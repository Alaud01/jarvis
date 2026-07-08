import React, { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef, useState, useMemo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingSection from './ThinkingSection';
import TypingIndicator from './TypingIndicator';
import NewChatEmptyState from './NewChatEmptyState';
import type { SearchSource, SearchSourceGroup } from '../../shared/search';
import type { FileAttachment } from '../../shared/attachments';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
}

interface MessageListProps {
  messages: Message[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  isLoading?: boolean;
  emptyStateRefreshKey?: number;
  conversationSearchTrigger?: number;
  editingMessageId?: string | null;
  onEditMessage?: (messageId: string) => void;
  onCancelEdit?: () => void;
  onResubmitMessage?: (messageId: string, newText: string) => void;
  onRegenerateResponse?: (messageId: string) => void;
}

function getAttachmentImageSrc(attachment: FileAttachment): string | null {
  if (attachment.kind !== 'image' || !attachment.base64) {
    return null;
  }

  return `data:${attachment.mimeType ?? 'image/png'};base64,${attachment.base64}`;
}

export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
  scrollToMessageHeader: (messageId: string, headerIndex: number) => void;
  scrollToBottom: () => void;
  isAutoScrollEnabled: () => boolean;
  enableAutoScroll: () => void;
}

export interface MessageSegment {
  type: 'thinking' | 'content';
  text?: string;
  isThinkingInProgress?: boolean;
  startOffset: number;
}

type MessageRenderItem =
  MessageSegment & { renderType: 'segment'; key: string };

const createSegmentItem = (
  segment: MessageSegment,
  key: string,
  text = segment.text,
  startOffset = segment.startOffset
): MessageRenderItem | null => {
  if (!text?.trim()) {
    return null;
  }

  return {
    ...segment,
    renderType: 'segment',
    key,
    text,
    startOffset,
  };
};

const buildMessageRenderItems = (segments: MessageSegment[]): MessageRenderItem[] => (
  segments
    .map((segment, segmentIndex) => createSegmentItem(segment, `segment-${segmentIndex}`))
    .filter((item): item is MessageRenderItem => item !== null)
);

const parseMessageSegments = (
  text: string,
  isStreaming?: boolean,
  allowIncompleteThinking = isStreaming
): MessageSegment[] => {
  const rawSegments: MessageSegment[] = [];
  
  const xmlThinkingRegex = /(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g;
  const ollamaCompleteThinkingRegex = /Thinking\.\.\.\n([\s\S]*?)\n\.\.\.done thinking\./g;
  const ollamaStreamingStartRegex = /Thinking\.\.\.\n([\s\S]*)$/;

  const pushContentSegment = (rawText: string, startOffset: number) => {
    const firstNonWhitespaceIndex = rawText.search(/\S/);
    if (firstNonWhitespaceIndex === -1) {
      return;
    }

    const trimmedText = rawText.trimEnd().slice(firstNonWhitespaceIndex);
    if (!trimmedText) {
      return;
    }

    rawSegments.push({
      type: 'content',
      text: trimmedText,
      startOffset: startOffset + firstNonWhitespaceIndex,
    });
  };

  const pushThinkingSegment = (
    rawText: string,
    startOffset: number,
    isThinkingInProgress: boolean
  ) => {
    const trimmedText = rawText.trim();
    if (!trimmedText) {
      return;
    }

    rawSegments.push({
      type: 'thinking',
      text: trimmedText,
      isThinkingInProgress,
      startOffset,
    });
  };

  const collapseAdjacentThinkingSegments = (segments: MessageSegment[]): MessageSegment[] => {
    return segments.reduce<MessageSegment[]>((collapsed, segment) => {
      const previous = collapsed[collapsed.length - 1];
      if (previous?.type === 'thinking' && segment.type === 'thinking' && previous.text && segment.text) {
        previous.text = `${previous.text}\n\n${segment.text}`;
        previous.isThinkingInProgress = Boolean(
          previous.isThinkingInProgress || segment.isThinkingInProgress
        );
        return collapsed;
      }

      collapsed.push({ ...segment });
      return collapsed;
    }, []);
  };
  
  const processText = (inputText: string, baseOffset: number) => {
    let remaining = inputText;
    let currentOffset = baseOffset;
    
    while (remaining.length > 0) {
      const xmlMatches = [...remaining.matchAll(xmlThinkingRegex)];
      const ollamaMatches = [...remaining.matchAll(ollamaCompleteThinkingRegex)];
      
      let nextXmlIndex = xmlMatches.length > 0 ? xmlMatches[0].index! : Infinity;
      let nextOllamaIndex = ollamaMatches.length > 0 ? ollamaMatches[0].index! : Infinity;
      
      const nextIndex = Math.min(nextXmlIndex, nextOllamaIndex);
      
      if (allowIncompleteThinking && nextIndex === Infinity) {
        const streamingMatch = remaining.match(ollamaStreamingStartRegex);
        if (streamingMatch) {
          const beforeStreaming = remaining.slice(0, remaining.indexOf(streamingMatch[0]));
          pushContentSegment(beforeStreaming, currentOffset);
          pushThinkingSegment(
            streamingMatch[1],
            currentOffset + remaining.indexOf(streamingMatch[0]),
            Boolean(isStreaming)
          );
          return;
        }
      }
      
      if (nextIndex === Infinity) {
        pushContentSegment(remaining, currentOffset);
        return;
      }
      
      if (nextIndex > 0) {
        const beforeContent = remaining.slice(0, nextIndex);
        pushContentSegment(beforeContent, currentOffset);
      }
      
      if (nextIndex === nextXmlIndex) {
        const match = xmlMatches.find(m => m.index === nextIndex)!;
        pushThinkingSegment(match[1], currentOffset + nextIndex, false);
        remaining = remaining.slice(nextIndex + match[0].length);
        currentOffset += nextIndex + match[0].length;
      } else if (nextIndex === nextOllamaIndex) {
        const match = ollamaMatches.find(m => m.index === nextIndex)!;
        pushThinkingSegment(match[1], currentOffset + nextIndex, false);
        remaining = remaining.slice(nextIndex + match[0].length);
        currentOffset += nextIndex + match[0].length;
      }
    }
  };
  
  processText(text, 0);
  
  if (rawSegments.length === 0 && text.trim()) {
    pushContentSegment(text, 0);
  }

  return collapseAdjacentThinkingSegments(rawSegments);
};

const getCopyableAssistantText = (text: string, isStreaming?: boolean): string => (
  parseMessageSegments(text, isStreaming, true)
    .filter((segment) => segment.type === 'content')
    .map((segment) => segment.text ?? '')
    .join('\n\n')
    .trim()
);

const PARSED_MESSAGE_CACHE_LIMIT = 300;
const parsedMessageCache = new Map<string, {
  text: string;
  isStreaming?: boolean;
  items: MessageRenderItem[];
}>();

const getCachedMessageRenderItems = (message: Message): MessageRenderItem[] => {
  const cached = parsedMessageCache.get(message.id);
  if (
    cached
    && cached.text === message.text
    && cached.isStreaming === message.isStreaming
  ) {
    parsedMessageCache.delete(message.id);
    parsedMessageCache.set(message.id, cached);
    return cached.items;
  }

  const segments = parseMessageSegments(
    message.text,
    message.isStreaming,
    message.sender === 'assistant'
  );
  const items = buildMessageRenderItems(segments);
  parsedMessageCache.set(message.id, {
    text: message.text,
    isStreaming: message.isStreaming,
    items,
  });

  while (parsedMessageCache.size > PARSED_MESSAGE_CACHE_LIMIT) {
    const oldestKey = parsedMessageCache.keys().next().value;
    if (!oldestKey) break;
    parsedMessageCache.delete(oldestKey);
  }

  return items;
};

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

const PencilIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>
);

const RefreshIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
);

const ThreeDotsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
    <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"></circle>
  </svg>
);

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const XIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

const ChevronUpIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="18 15 12 9 6 15"></polyline>
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9"></polyline>
  </svg>
);

interface MessageActionButtonProps {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'primary';
  disabled?: boolean;
  ariaExpanded?: boolean;
  ariaHaspopup?: React.AriaAttributes['aria-haspopup'];
}

const MessageActionButton: React.FC<MessageActionButtonProps> = ({
  onClick,
  label,
  icon,
  variant = 'default',
  disabled = false,
  ariaExpanded,
  ariaHaspopup,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    aria-expanded={ariaExpanded}
    aria-haspopup={ariaHaspopup}
    className={`flex h-6 w-6 items-center justify-center p-1 transition-all duration-150 ${disabled
      ? 'cursor-not-allowed border border-border-secondary text-text-tertiary opacity-60'
      : variant === 'primary'
        ? 'border border-text-primary bg-text-primary text-bg-primary hover:bg-transparent hover:text-text-primary'
        : 'border border-border-secondary text-text-secondary hover:border-text-primary hover:text-text-primary'
    }`}
  >
    {icon}
  </button>
);

const getSourceInitial = (source: SearchSource): string => {
  const label = source.profileName || source.domain || source.title;
  return label.trim().charAt(0).toUpperCase() || '?';
};

const SOURCE_ROW_GAP_PX = 8;

const getUniqueSearchSources = (groups?: SearchSourceGroup[]): SearchSource[] => {
  const sources = (groups ?? []).flatMap(group => group.sources);
  return sources.filter((source, index) => (
    sources.findIndex(candidate => candidate.url === source.url) === index
  ));
};

const SourceIcon: React.FC<{ source: SearchSource; className?: string }> = ({ source, className = 'h-3.5 w-3.5' }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const showFavicon = source.faviconUrl && !imageFailed;

  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden bg-bg-secondary text-[0.425rem] font-mono uppercase text-text-muted ${className}`}>
      {showFavicon ? (
        <img
          src={source.faviconUrl}
          alt=""
          className="h-full w-full object-contain"
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      ) : (
        getSourceInitial(source)
      )}
    </span>
  );
};

const SearchSourceChip: React.FC<{ source: SearchSource }> = ({ source }) => {
  const label = source.profileName || source.domain;
  const tooltip = [source.title, source.domain, source.age].filter(Boolean).join(' | ');

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={tooltip}
      className="inline-flex min-w-0 max-w-[180px] shrink-0 items-center gap-1.5 border border-border-secondary px-1 py-1 text-text-secondary hover:border-text-primary hover:text-text-primary"
    >
      <SourceIcon source={source} />
      <span className="min-w-0 truncate font-mono text-[0.525rem]">
        {label}
      </span>
    </a>
  );
};

const SearchSourcesOverflowMenu: React.FC<{
  sources: SearchSource[];
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
}> = ({ sources, isOpen, onToggle, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  return (
    <div ref={menuRef} className="relative shrink-0">
      <MessageActionButton
        onClick={onToggle}
        label={`${sources.length} more sources`}
        icon={<ThreeDotsIcon />}
        ariaExpanded={isOpen}
        ariaHaspopup="menu"
      />
      {isOpen && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-[440px] border border-border-primary bg-bg-secondary p-2 shadow-lg">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(sources.length, 4)}, minmax(0, 1fr))` }}>
            {sources.map(source => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col gap-1 border border-border-secondary bg-bg-primary p-2 hover:border-text-primary"
                title={[source.title, source.domain, source.age].filter(Boolean).join(' | ')}
              >
                <div className="flex items-center gap-1.5 overflow-hidden">
                  <SourceIcon source={source} className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate font-mono text-[0.525rem] text-text-secondary group-hover:text-text-primary">
                    {source.profileName || source.domain}
                  </span>
                </div>
                {source.title && (
                  <span className="line-clamp-2 text-[0.475rem] leading-relaxed text-text-tertiary">
                    {source.title}
                  </span>
                )}
                {source.age && (
                  <span className="font-mono text-[0.45rem] text-text-muted">{source.age}</span>
                )}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const SearchSourcesBar: React.FC<{
  groups?: SearchSourceGroup[];
}> = ({ groups }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const overflowButtonMeasureRef = useRef<HTMLDivElement>(null);
  const measureChipRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const [visibleSourceCount, setVisibleSourceCount] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const uniqueSources = useMemo(() => getUniqueSearchSources(groups), [groups]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || !uniqueSources.length) {
      setVisibleSourceCount(0);
      return;
    }

    const updateVisibleSourceCount = () => {
      const rowWidth = row.clientWidth;
      const labelWidth = labelRef.current?.getBoundingClientRect().width ?? 0;
      const overflowButtonWidth = overflowButtonMeasureRef.current?.getBoundingClientRect().width ?? 24;
      const sourceWidths = uniqueSources.map(source => (
        measureChipRefs.current.get(source.url)?.getBoundingClientRect().width ?? 0
      ));

      const getRowWidthForCount = (count: number, hasOverflowButton: boolean) => {
        const visibleSourceWidth = sourceWidths
          .slice(0, count)
          .reduce((total, width) => total + width, 0);
        const itemCount = 1 + count + (hasOverflowButton ? 1 : 0);
        const gapWidth = Math.max(0, itemCount - 1) * SOURCE_ROW_GAP_PX;
        return labelWidth + visibleSourceWidth + (hasOverflowButton ? overflowButtonWidth : 0) + gapWidth;
      };

      let nextVisibleCount = uniqueSources.length;
      if (getRowWidthForCount(uniqueSources.length, false) > rowWidth) {
        nextVisibleCount = 0;
        for (let count = uniqueSources.length - 1; count >= 0; count -= 1) {
          if (getRowWidthForCount(count, true) <= rowWidth) {
            nextVisibleCount = count;
            break;
          }
        }
      }

      setVisibleSourceCount(current => (
        current === nextVisibleCount ? current : nextVisibleCount
      ));
    };

    updateVisibleSourceCount();

    const resizeObserver = new ResizeObserver(updateVisibleSourceCount);
    resizeObserver.observe(row);
    window.addEventListener('resize', updateVisibleSourceCount);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateVisibleSourceCount);
    };
  }, [uniqueSources]);

  const visibleSources = uniqueSources.slice(0, visibleSourceCount);
  const hiddenSources = uniqueSources.slice(visibleSourceCount);

  useEffect(() => {
    if (hiddenSources.length === 0) {
      setMenuOpen(false);
    }
  }, [hiddenSources.length]);

  if (!uniqueSources.length) {
    return null;
  }

  return (
    <div ref={rowRef} className="relative flex w-full min-w-0 flex-nowrap items-center gap-2 pt-1">
      <span ref={labelRef} className="shrink-0 font-mono text-[0.475rem] uppercase tracking-[0.15em] text-text-tertiary">
        Sources
      </span>
      {visibleSources.map(source => (
        <SearchSourceChip key={source.url} source={source} />
      ))}
      {hiddenSources.length > 0 && (
        <SearchSourcesOverflowMenu
          sources={hiddenSources}
          isOpen={menuOpen}
          onToggle={() => setMenuOpen(open => !open)}
          onClose={() => setMenuOpen(false)}
        />
      )}
      <div
        aria-hidden="true"
        className="invisible pointer-events-none absolute left-0 top-0 flex max-w-none flex-nowrap items-center gap-2"
      >
        {uniqueSources.map(source => (
          <span
            key={source.url}
            ref={(element) => {
              if (element) {
                measureChipRefs.current.set(source.url, element);
              } else {
                measureChipRefs.current.delete(source.url);
              }
            }}
            className="shrink-0"
          >
            <SearchSourceChip source={source} />
          </span>
        ))}
        <div ref={overflowButtonMeasureRef} className="shrink-0">
          <MessageActionButton
            onClick={() => undefined}
            label="More sources"
            icon={<ThreeDotsIcon />}
            ariaHaspopup="menu"
          />
        </div>
      </div>
    </div>
  );
};

const formatMessageTime = (date: Date): string => {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

interface MessageRowProps {
  message: Message;
  isEditing: boolean;
  editText: string;
  copiedId: string | null;
  isLoading: boolean;
  searchQuery: string;
  setMessageRef: (messageId: string, element: HTMLDivElement | null) => void;
  setEditText: (text: string) => void;
  onCopy: (messageId: string, text: string) => void;
  onStartEdit: (messageId: string, text: string) => void;
  onCancelEdit: () => void;
  onResubmit: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onAutoScrollCancel: () => void;
  onAutoScrollReactivate: () => void;
}

const MessageRow = React.memo(({
  message,
  isEditing,
  editText,
  copiedId,
  isLoading,
  searchQuery,
  setMessageRef,
  setEditText,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onResubmit,
  onRegenerate,
  onAutoScrollCancel,
  onAutoScrollReactivate,
}: MessageRowProps) => {
  const renderItems = useMemo(() => getCachedMessageRenderItems(message), [message]);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeEditTextarea = useCallback(() => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const maxHeight = window.innerHeight;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useLayoutEffect(() => {
    if (!isEditing) return;
    resizeEditTextarea();
  }, [isEditing, editText, resizeEditTextarea]);

  useEffect(() => {
    if (!isEditing) return;

    window.addEventListener('resize', resizeEditTextarea);
    return () => window.removeEventListener('resize', resizeEditTextarea);
  }, [isEditing, resizeEditTextarea]);

  const actionsDisabled = Boolean(message.isStreaming || isLoading);

  return (
    <div
      data-message-id={message.id}
      ref={(el) => setMessageRef(message.id, el)}
      className={`flex flex-col gap-2 last:border-b-0 ${message.sender === 'user' ? 'px-2 py-2 border border-border-secondary rounded bg-bg-secondary' : 'border-b border-border-primary py-4'}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[0.475rem] uppercase tracking-[0.15em] text-text-primary">
          {message.sender === 'user' ? 'you' : 'jarvis'}
        </span>
        <span className="font-mono text-[0.525rem] text-text-tertiary">
          {formatMessageTime(message.timestamp)}
        </span>
        {message.isStreaming && (
          <span className="font-mono text-[0.525rem] text-text-muted animate-pulse">
            streaming...
          </span>
        )}
      </div>

      {message.sender === 'user' && message.attachments && message.attachments.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {message.attachments.map((attachment, index) => {
            const imageSrc = getAttachmentImageSrc(attachment);
            return (
              <span
                key={`${attachment.name}-${attachment.size}-${index}`}
                className="inline-flex items-center gap-2 border border-border-secondary px-2 py-1 font-mono text-[0.525rem] text-text-secondary"
                title={attachment.truncated ? 'Model context was truncated for this file' : undefined}
              >
                {imageSrc && (
                  <img
                    src={imageSrc}
                    alt=""
                    className="h-12 w-12 object-cover border border-border-secondary"
                  />
                )}
                {attachment.name}{attachment.truncated ? ' (trimmed)' : ''}
              </span>
            );
          })}
        </div>
      )}

      {isEditing ? (
        <div className="flex flex-col gap-3">
          <textarea
            ref={editTextareaRef}
            className="w-full min-h-[60px] bg-transparent p-3 text-[0.875rem] text-text-primary leading-relaxed resize-none outline-none focus:border-text-primary"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onResubmit(message.id);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancelEdit();
              }
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-[0.525rem] text-text-tertiary mr-auto">
              Enter to submit · Shift + Enter for newline · Esc to cancel
            </span>
            <MessageActionButton
              onClick={() => onCopy(message.id, editText)}
              label={copiedId === message.id ? 'Copied' : 'Copy'}
              icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
            />
            <MessageActionButton
              onClick={onCancelEdit}
              label="Cancel"
              icon={<XIcon />}
            />
            <MessageActionButton
              onClick={() => onResubmit(message.id)}
              label="Submit"
              icon={<CheckIcon />}
              variant="primary"
            />
          </div>
        </div>
      ) : (
        <>
          {renderItems.map((item) => {
            const segment = item;
            if (segment.type === 'thinking' && segment.text) {
              return (
                <ThinkingSection
                  key={item.key}
                  content={segment.text}
                  isStreaming={segment.isThinkingInProgress}
                  onAutoScrollCancel={onAutoScrollCancel}
                  onAutoScrollReactivate={onAutoScrollReactivate}
                />
              );
            }
            if (segment.type === 'content' && segment.text) {
              return (
                <div key={item.key} className="text-[0.875rem] text-text-primary leading-[1.8]">
                  <MarkdownRenderer content={segment.text} highlightTerm={searchQuery} />
                </div>
              );
            }
            return null;
          })}

          {message.sender === 'assistant' && message.searchSources && message.searchSources.length > 0 && (
            <SearchSourcesBar groups={message.searchSources} />
          )}

          <div className="flex items-center justify-end gap-2">
            {message.sender === 'user' ? (
              <>
                <MessageActionButton
                  onClick={() => onCopy(message.id, message.text)}
                  label={copiedId === message.id ? 'Copied' : 'Copy'}
                  icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  disabled={actionsDisabled}
                />
                <MessageActionButton
                  onClick={() => onStartEdit(message.id, message.text)}
                  label="Edit"
                  icon={<PencilIcon />}
                  disabled={actionsDisabled}
                />
              </>
            ) : (
              <>
                <MessageActionButton
                  onClick={() => onCopy(message.id, getCopyableAssistantText(message.text, message.isStreaming))}
                  label={copiedId === message.id ? 'Copied' : 'Copy'}
                  icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  disabled={actionsDisabled}
                />
                <MessageActionButton
                  onClick={() => onRegenerate(message.id)}
                  label="Regenerate"
                  icon={<RefreshIcon />}
                  disabled={actionsDisabled}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
});

const AUTO_SCROLL_BOTTOM_THRESHOLD = 8;
const STREAMING_STICKY_BOTTOM_THRESHOLD = 50;
const SMOOTH_AUTO_SCROLL_TRACKING_MS = 500;
const VIRTUALIZATION_THRESHOLD = 80;
const VIRTUALIZATION_OVERSCAN = 8;
const DEFAULT_MESSAGE_HEIGHT = 180;

interface ConversationSearchMatch {
  messageId: string;
  occurrenceIndex: number;
}

const isNearBottom = (
  container: HTMLElement,
  threshold = AUTO_SCROLL_BOTTOM_THRESHOLD
) => (
  container.scrollHeight - container.scrollTop - container.clientHeight < threshold
);

interface ScrollSnapshot {
  shouldMaintain: boolean;
}

const estimateMessageHeight = (message: Message): number => {
  const lineEstimate = Math.ceil(message.text.length / 88);
  const sourcesEstimate = message.searchSources?.length ? 44 : 0;
  const baseHeight = message.sender === 'user' ? 74 : 112;
  return Math.max(baseHeight, baseHeight + lineEstimate * 28 + sourcesEstimate);
};

const findOffsetIndex = (offsets: number[], target: number): number => {
  let low = 0;
  let high = offsets.length - 1;

  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle] <= target) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};

const countTextMatches = (text: string, query: string): number => {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedText = text.toLocaleLowerCase();
  let count = 0;
  let searchStart = 0;

  while (searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
    if (matchIndex === -1) {
      break;
    }

    count += 1;
    searchStart = matchIndex + normalizedQuery.length;
  }

  return count;
};

const countSearchableMessageMatches = (message: Message, query: string): number => (
  getCachedMessageRenderItems(message)
    .filter(item => item.type === 'content' && item.text)
    .reduce((total, item) => total + countTextMatches(item.text ?? '', query), 0)
);

const MessageList = forwardRef<MessageListHandle, MessageListProps>(({ 
  messages, 
  scrollContainerRef,
  isLoading = false,
  emptyStateRefreshKey,
  conversationSearchTrigger = 0,
  editingMessageId,
  onEditMessage,
  onCancelEdit,
  onResubmitMessage,
  onRegenerateResponse,
}, ref) => {
  const messageRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const autoScrollEnabledRef = useRef(true);
  const smoothAutoScrollDeadlineRef = useRef(0);
  const smoothAutoScrollTimeoutRef = useRef<number | null>(null);
  const prevLastMessageIdRef = useRef<string | null>(null);
  const messagesColumnRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const lastConversationSearchTriggerRef = useRef(conversationSearchTrigger);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [heightVersion, setHeightVersion] = useState(0);
  const [virtualViewport, setVirtualViewport] = useState({ scrollTop: 0, height: 0 });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollEnabledRef.current = enabled;
  }, []);

  const cancelAutoScroll = useCallback(() => {
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const reactivateAutoScroll = useCallback(() => {
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

  const clearSmoothAutoScrollTracking = useCallback(() => {
    smoothAutoScrollDeadlineRef.current = 0;
    if (smoothAutoScrollTimeoutRef.current !== null) {
      window.clearTimeout(smoothAutoScrollTimeoutRef.current);
      smoothAutoScrollTimeoutRef.current = null;
    }
  }, []);

  const trackSmoothAutoScroll = useCallback(() => {
    smoothAutoScrollDeadlineRef.current = performance.now() + SMOOTH_AUTO_SCROLL_TRACKING_MS;
    if (smoothAutoScrollTimeoutRef.current !== null) {
      window.clearTimeout(smoothAutoScrollTimeoutRef.current);
    }
    smoothAutoScrollTimeoutRef.current = window.setTimeout(() => {
      smoothAutoScrollDeadlineRef.current = 0;
      smoothAutoScrollTimeoutRef.current = null;
    }, SMOOTH_AUTO_SCROLL_TRACKING_MS);
  }, []);

  const reactivateAutoScrollIfAtBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container && isNearBottom(container)) {
      reactivateAutoScroll();
    }
  }, [reactivateAutoScroll, scrollContainerRef]);

  const heightOffsets = useMemo(() => {
    let total = 0;
    const offsets = messages.map(message => {
      const offset = total;
      total += measuredHeightsRef.current.get(message.id) ?? estimateMessageHeight(message);
      return offset;
    });

    return {
      offsets,
      totalHeight: total,
    };
  }, [messages, heightVersion]);

  const shouldVirtualize = messages.length > VIRTUALIZATION_THRESHOLD;
  const virtualRange = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        start: 0,
        end: messages.length,
        topPadding: 0,
        bottomPadding: 0,
      };
    }

    const viewportStart = Math.max(0, virtualViewport.scrollTop - DEFAULT_MESSAGE_HEIGHT * VIRTUALIZATION_OVERSCAN);
    const viewportEnd = virtualViewport.scrollTop
      + virtualViewport.height
      + DEFAULT_MESSAGE_HEIGHT * VIRTUALIZATION_OVERSCAN;
    const start = Math.max(0, findOffsetIndex(heightOffsets.offsets, viewportStart));
    const end = Math.min(
      messages.length,
      findOffsetIndex(heightOffsets.offsets, viewportEnd) + VIRTUALIZATION_OVERSCAN + 1
    );
    const renderedEndOffset = end < messages.length
      ? heightOffsets.offsets[end]
      : heightOffsets.totalHeight;

    return {
      start,
      end,
      topPadding: heightOffsets.offsets[start] ?? 0,
      bottomPadding: Math.max(0, heightOffsets.totalHeight - renderedEndOffset),
    };
  }, [heightOffsets, messages.length, shouldVirtualize, virtualViewport]);

  const renderedMessages = shouldVirtualize
    ? messages.slice(virtualRange.start, virtualRange.end)
    : messages;

  const conversationSearchMatches = useMemo<ConversationSearchMatch[]>(() => {
    const query = searchQuery.trim();
    if (!query) {
      return [];
    }

    return messages.flatMap(message => (
      Array.from({ length: countSearchableMessageMatches(message, query) }, (_value, occurrenceIndex) => ({
        messageId: message.id,
        occurrenceIndex,
      }))
    ));
  }, [messages, searchQuery]);

  const updateVirtualViewport = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    setVirtualViewport({
      scrollTop: container.scrollTop,
      height: container.clientHeight,
    });
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    updateVirtualViewport();
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener('scroll', updateVirtualViewport, { passive: true });
    window.addEventListener('resize', updateVirtualViewport);
    return () => {
      container.removeEventListener('scroll', updateVirtualViewport);
      window.removeEventListener('resize', updateVirtualViewport);
    };
  }, [scrollContainerRef, updateVirtualViewport]);

  useLayoutEffect(() => {
    updateVirtualViewport();
  }, [messages.length, updateVirtualViewport]);

  useEffect(() => {
    const liveIds = new Set(messages.map(message => message.id));
    measuredHeightsRef.current.forEach((_height, messageId) => {
      if (!liveIds.has(messageId)) {
        measuredHeightsRef.current.delete(messageId);
      }
    });
  }, [messages]);

  const setMessageRef = useCallback((messageId: string, element: HTMLDivElement | null) => {
    if (element) {
      messageRefsRef.current.set(messageId, element);
      const measuredHeight = element.getBoundingClientRect().height;
      const previousHeight = measuredHeightsRef.current.get(messageId);
      if (Math.abs((previousHeight ?? 0) - measuredHeight) > 1) {
        measuredHeightsRef.current.set(messageId, measuredHeight);
        setHeightVersion(version => version + 1);
      }
    } else {
      messageRefsRef.current.delete(messageId);
    }
  }, []);

  const scrollToBottomNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (behavior === 'smooth') {
      trackSmoothAutoScroll();
    } else {
      clearSmoothAutoScrollTracking();
    }
    container.scrollTo({ top: container.scrollHeight, behavior });
    setAutoScrollEnabled(true);
  }, [clearSmoothAutoScrollTracking, scrollContainerRef, setAutoScrollEnabled, trackSmoothAutoScroll]);

  useLayoutEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      prevLastMessageIdRef.current = null;
      return;
    }

    const previousLastId = prevLastMessageIdRef.current;
    prevLastMessageIdRef.current = lastMessage.id;

    if (
      lastMessage.id !== previousLastId &&
      (lastMessage.sender === 'user' || lastMessage.isStreaming)
    ) {
      scrollToBottomNow(lastMessage.isStreaming ? 'smooth' : 'auto');
    }
  }, [messages, scrollToBottomNow]);

  const maintainScrollAtEnd = useCallback((snapshot: ScrollSnapshot) => {
    if (!snapshot.shouldMaintain) {
      setAutoScrollEnabled(false);
      return;
    }

    scrollToBottomNow('smooth');
  }, [scrollToBottomNow, setAutoScrollEnabled]);

  const scrollElementIntoView = useCallback((element: Element, offset: number = 16) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const targetScrollTop = container.scrollTop + elementRect.top - containerRect.top - offset;
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const targetIsNearBottom = maxScrollTop - targetScrollTop < AUTO_SCROLL_BOTTOM_THRESHOLD;

    if (!targetIsNearBottom) {
      cancelAutoScroll();
    } else {
      reactivateAutoScroll();
    }

    container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
  }, [cancelAutoScroll, reactivateAutoScroll, scrollContainerRef]);

  const scrollToMessageId = useCallback((messageId: string, offset = 16) => {
    const messageElement = messageRefsRef.current.get(messageId);
    if (messageElement) {
      scrollElementIntoView(messageElement, offset);
      return;
    }

    const messageIndex = messages.findIndex(message => message.id === messageId);
    const container = scrollContainerRef.current;
    if (messageIndex !== -1 && container && shouldVirtualize) {
      cancelAutoScroll();
      container.scrollTo({
        top: Math.max(0, heightOffsets.offsets[messageIndex] - offset),
        behavior: 'smooth',
      });
    }
  }, [cancelAutoScroll, heightOffsets, messages, scrollContainerRef, scrollElementIntoView, shouldVirtualize]);

  const scrollToSearchMatch = useCallback((match: ConversationSearchMatch) => {
    const scrollToHighlight = () => {
      const messageElement = messageRefsRef.current.get(match.messageId);
      const highlightElement = messageElement?.querySelectorAll('.conversation-search-highlight')[match.occurrenceIndex];
      if (!highlightElement) {
        return false;
      }

      scrollElementIntoView(highlightElement, 72);
      return true;
    };

    if (scrollToHighlight()) {
      return;
    }

    scrollToMessageId(match.messageId, 48);
    window.requestAnimationFrame(() => {
      if (scrollToHighlight()) {
        return;
      }

      window.requestAnimationFrame(() => {
        if (!scrollToHighlight()) {
          scrollToMessageId(match.messageId, 48);
        }
      });
    });
  }, [scrollElementIntoView, scrollToMessageId]);

  const activateSearchMatch = useCallback((nextIndex: number) => {
    const match = conversationSearchMatches[nextIndex];
    if (!match) {
      return;
    }

    setActiveSearchMatchIndex(nextIndex);
    scrollToSearchMatch(match);
  }, [conversationSearchMatches, scrollToSearchMatch]);

  const goToNextSearchMatch = useCallback(() => {
    if (conversationSearchMatches.length === 0) {
      return;
    }

    const nextIndex = (activeSearchMatchIndex + 1) % conversationSearchMatches.length;
    activateSearchMatch(nextIndex);
  }, [activateSearchMatch, activeSearchMatchIndex, conversationSearchMatches.length]);

  const goToPreviousSearchMatch = useCallback(() => {
    if (conversationSearchMatches.length === 0) {
      return;
    }

    const nextIndex = (activeSearchMatchIndex - 1 + conversationSearchMatches.length) % conversationSearchMatches.length;
    activateSearchMatch(nextIndex);
  }, [activateSearchMatch, activeSearchMatchIndex, conversationSearchMatches.length]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      scrollToMessageId(messageId);
    },
    scrollToMessageHeader: (messageId: string, headerIndex: number) => {
      const messageElement = messageRefsRef.current.get(messageId);
      const headerElement = messageElement?.querySelectorAll('h1, h2, h3')[headerIndex];

      if (headerElement) {
        scrollElementIntoView(headerElement, 24);
      } else if (messageElement) {
        scrollElementIntoView(messageElement);
      } else {
        scrollToMessageId(messageId, 24);
      }
    },
    scrollToBottom: () => {
      autoScrollEnabledRef.current = true;
      scrollToBottomNow('smooth');
    },
    isAutoScrollEnabled: () => autoScrollEnabledRef.current,
    enableAutoScroll: () => {
      reactivateAutoScroll();
    }
  }), [
    cancelAutoScroll,
    messages,
    reactivateAutoScroll,
    scrollContainerRef,
    scrollElementIntoView,
    scrollToMessageId,
    scrollToBottomNow,
    shouldVirtualize,
  ]);

  useEffect(() => {
    if (conversationSearchTrigger === lastConversationSearchTriggerRef.current) {
      return;
    }

    lastConversationSearchTriggerRef.current = conversationSearchTrigger;
    setIsSearchOpen(true);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [conversationSearchTrigger]);

  useEffect(() => {
    if (conversationSearchMatches.length === 0) {
      setActiveSearchMatchIndex(0);
      return;
    }

    if (activeSearchMatchIndex >= conversationSearchMatches.length) {
      activateSearchMatch(0);
      return;
    }

    if (searchQuery.trim()) {
      scrollToSearchMatch(conversationSearchMatches[activeSearchMatchIndex]);
    }
  }, [
    activateSearchMatch,
    activeSearchMatchIndex,
    conversationSearchMatches,
    scrollToSearchMatch,
    searchQuery,
  ]);

  const streamingActive = messages.some(m => m.isStreaming);
  const scrollSnapshot: ScrollSnapshot = (() => {
    if (!streamingActive || !autoScrollEnabledRef.current) {
      return { shouldMaintain: false };
    }
    const container = scrollContainerRef.current;
    return {
      shouldMaintain: container ? isNearBottom(container, STREAMING_STICKY_BOTTOM_THRESHOLD) : true,
    };
  })();

  useLayoutEffect(() => {
    if (!streamingActive) return;
    maintainScrollAtEnd(scrollSnapshot);
  }, [messages, streamingActive, scrollSnapshot, maintainScrollAtEnd]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setAutoScrollEnabled(isNearBottom(container));

    const handleScroll = () => {
      if (
        autoScrollEnabledRef.current &&
        smoothAutoScrollDeadlineRef.current > performance.now()
      ) {
        return;
      }

      setAutoScrollEnabled(isNearBottom(container));
    };

    const handleUserScrollIntent = () => {
      clearSmoothAutoScrollTracking();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    container.addEventListener('wheel', handleUserScrollIntent, { passive: true });
    container.addEventListener('touchmove', handleUserScrollIntent, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('wheel', handleUserScrollIntent);
      container.removeEventListener('touchmove', handleUserScrollIntent);
      clearSmoothAutoScrollTracking();
    };
  }, [clearSmoothAutoScrollTracking, scrollContainerRef, setAutoScrollEnabled]);

  const hasStreamingMessage = messages.some(m => m.isStreaming);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');

  const handleCopy = useCallback((messageId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(messageId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleStartEdit = useCallback((messageId: string, text: string) => {
    setEditText(text);
    onEditMessage?.(messageId);
  }, [onEditMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditText('');
    onCancelEdit?.();
  }, [onCancelEdit]);

  const handleResubmit = useCallback((messageId: string) => {
    onResubmitMessage?.(messageId, editText);
  }, [onResubmitMessage, editText]);

  const handleRegenerate = useCallback((messageId: string) => {
    onRegenerateResponse?.(messageId);
  }, [onRegenerateResponse]);

  const showTypingIndicator = isLoading && !hasStreamingMessage && messages.length > 0 && messages[messages.length - 1].sender === 'user';

  const showEmptyPlaceholder = messages.length === 0 && !isLoading;
  const hasSearchQuery = searchQuery.trim().length > 0;
  const searchResultLabel = hasSearchQuery
    ? `${conversationSearchMatches.length === 0 ? 0 : activeSearchMatchIndex + 1}/${conversationSearchMatches.length}`
    : '0/0';

  return (
    <div className="flex-1 min-w-0">
      {isSearchOpen && (
        <div className="fixed right-[40px] top-[49px] z-50 w-[min(360px,calc(100vw-2rem))]">
          <div className="flex h-9 w-full max-w-[360px] items-center gap-1 border border-border-secondary bg-bg-primary p-1 shadow-lg">
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setActiveSearchMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsSearchOpen(false);
                  return;
                }

                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (event.shiftKey) {
                    goToPreviousSearchMatch();
                  } else {
                    goToNextSearchMatch();
                  }
                }
              }}
              placeholder="Find in conversation"
              aria-label="Find in conversation"
              className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[0.75rem] text-text-primary outline-none placeholder:text-text-muted"
            />
            <span className="w-12 shrink-0 text-right font-mono text-[0.625rem] text-text-tertiary">
              {searchResultLabel}
            </span>
            <MessageActionButton
              onClick={goToPreviousSearchMatch}
              label="Previous match"
              icon={<ChevronUpIcon />}
              disabled={conversationSearchMatches.length === 0}
            />
            <MessageActionButton
              onClick={goToNextSearchMatch}
              label="Next match"
              icon={<ChevronDownIcon />}
              disabled={conversationSearchMatches.length === 0}
            />
            <MessageActionButton
              onClick={() => setIsSearchOpen(false)}
              label="Close search"
              icon={<XIcon />}
            />
          </div>
        </div>
      )}
      {showEmptyPlaceholder ? (
        <NewChatEmptyState refreshKey={emptyStateRefreshKey ?? 0} />
      ) : (
      <div className="py-4">
        <div ref={messagesColumnRef} className="max-w-[838px] mx-auto pl-[38px]">
          {shouldVirtualize && virtualRange.topPadding > 0 && (
            <div aria-hidden="true" style={{ height: virtualRange.topPadding }} />
          )}
          {renderedMessages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              isEditing={editingMessageId === message.id}
              editText={editText}
              copiedId={copiedId}
              isLoading={isLoading}
              searchQuery={isSearchOpen ? searchQuery : ''}
              setMessageRef={setMessageRef}
              setEditText={setEditText}
              onCopy={handleCopy}
              onStartEdit={handleStartEdit}
              onCancelEdit={handleCancelEdit}
              onResubmit={handleResubmit}
              onRegenerate={handleRegenerate}
              onAutoScrollCancel={cancelAutoScroll}
              onAutoScrollReactivate={reactivateAutoScrollIfAtBottom}
            />
          ))}
          {shouldVirtualize && virtualRange.bottomPadding > 0 && (
            <div aria-hidden="true" style={{ height: virtualRange.bottomPadding }} />
          )}
          
          {showTypingIndicator && (
            <TypingIndicator sender="assistant" />
          )}
        </div>
      </div>
      )}
    </div>
  );
});

export default MessageList;
