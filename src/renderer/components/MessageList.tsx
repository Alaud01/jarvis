import React, { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef, useState, useMemo } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingSection from './ThinkingSection';
import BrowserTraceSection from './BrowserTraceSection';
import TypingIndicator from './TypingIndicator';
import type { BrowserToolRun } from '../../shared/browser';
import type { SearchSource, SearchSourceGroup } from '../../shared/search';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  browserRuns?: BrowserToolRun[];
  searchSources?: SearchSourceGroup[];
}

interface MessageListProps {
  messages: Message[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  isLoading?: boolean;
  editingMessageId?: string | null;
  onEditMessage?: (messageId: string) => void;
  onCancelEdit?: () => void;
  onResubmitMessage?: (messageId: string, newText: string) => void;
  onRegenerateResponse?: (messageId: string) => void;
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
  | (MessageSegment & { renderType: 'segment'; key: string })
  | { renderType: 'browserRun'; key: string; run: BrowserToolRun; startOffset: number };

const getSegmentEndOffset = (segment: MessageSegment) => (
  segment.startOffset + (segment.text?.length ?? 0)
);

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

const buildMessageRenderItems = (
  segments: MessageSegment[],
  runs: BrowserToolRun[] = []
): MessageRenderItem[] => {
  const sortedRuns = [...runs].sort((a, b) => {
    const offsetA = a.textOffset ?? Number.MAX_SAFE_INTEGER;
    const offsetB = b.textOffset ?? Number.MAX_SAFE_INTEGER;
    if (offsetA !== offsetB) return offsetA - offsetB;
    return a.startedAt.localeCompare(b.startedAt);
  });
  const items: MessageRenderItem[] = [];
  let runIndex = 0;

  const pushRunsUntil = (offset: number) => {
    while (
      runIndex < sortedRuns.length
      && (sortedRuns[runIndex].textOffset ?? Number.MAX_SAFE_INTEGER) <= offset
    ) {
      const run = sortedRuns[runIndex];
      items.push({
        renderType: 'browserRun',
        key: `browser-${run.id}`,
        run,
        startOffset: run.textOffset ?? Number.MAX_SAFE_INTEGER,
      });
      runIndex += 1;
    }
  };

  segments.forEach((segment, segmentIndex) => {
    const text = segment.text ?? '';
    const segmentStart = segment.startOffset;
    const segmentEnd = getSegmentEndOffset(segment);
    let cursor = segmentStart;

    pushRunsUntil(segmentStart);

    while (
      runIndex < sortedRuns.length
      && (sortedRuns[runIndex].textOffset ?? Number.MAX_SAFE_INTEGER) > cursor
      && (sortedRuns[runIndex].textOffset ?? Number.MAX_SAFE_INTEGER) < segmentEnd
    ) {
      const run = sortedRuns[runIndex];
      const runOffset = run.textOffset ?? segmentEnd;
      const beforeText = text.slice(cursor - segmentStart, runOffset - segmentStart);
      const beforeItem = createSegmentItem(
        segment,
        `segment-${segmentIndex}-${cursor}`,
        beforeText,
        cursor
      );
      if (beforeItem) {
        items.push(beforeItem);
      }

      items.push({
        renderType: 'browserRun',
        key: `browser-${run.id}`,
        run,
        startOffset: runOffset,
      });
      runIndex += 1;
      cursor = runOffset;
    }

    const remainingText = text.slice(cursor - segmentStart);
    const remainingItem = createSegmentItem(
      segment,
      `segment-${segmentIndex}-${cursor}`,
      remainingText,
      cursor
    );
    if (remainingItem) {
      items.push(remainingItem);
    }
  });

  while (runIndex < sortedRuns.length) {
    const run = sortedRuns[runIndex];
    items.push({
      renderType: 'browserRun',
      key: `browser-${run.id}`,
      run,
      startOffset: run.textOffset ?? Number.MAX_SAFE_INTEGER,
    });
    runIndex += 1;
  }

  return items;
};

const parseMessageSegments = (text: string, isStreaming?: boolean): MessageSegment[] => {
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
      
      if (isStreaming && nextIndex === Infinity) {
        const streamingMatch = remaining.match(ollamaStreamingStartRegex);
        if (streamingMatch) {
          const beforeStreaming = remaining.slice(0, remaining.indexOf(streamingMatch[0]));
          pushContentSegment(beforeStreaming, currentOffset);
          pushThinkingSegment(
            streamingMatch[1],
            currentOffset + remaining.indexOf(streamingMatch[0]),
            true
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

const PARSED_MESSAGE_CACHE_LIMIT = 300;
const parsedMessageCache = new Map<string, {
  text: string;
  isStreaming?: boolean;
  browserRuns?: BrowserToolRun[];
  items: MessageRenderItem[];
}>();

const getCachedMessageRenderItems = (message: Message): MessageRenderItem[] => {
  const cached = parsedMessageCache.get(message.id);
  if (
    cached
    && cached.text === message.text
    && cached.isStreaming === message.isStreaming
    && cached.browserRuns === message.browserRuns
  ) {
    parsedMessageCache.delete(message.id);
    parsedMessageCache.set(message.id, cached);
    return cached.items;
  }

  const segments = parseMessageSegments(message.text, message.isStreaming);
  const items = buildMessageRenderItems(segments, message.browserRuns);
  parsedMessageCache.set(message.id, {
    text: message.text,
    isStreaming: message.isStreaming,
    browserRuns: message.browserRuns,
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
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

interface MessageActionButtonProps {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'primary';
}

const MessageActionButton: React.FC<MessageActionButtonProps> = ({ onClick, label, icon, variant = 'default' }) => (
  <button
    onClick={onClick}
    title={label}
    className={`flex items-center justify-center p-1.5 transition-all duration-150 ${
      variant === 'primary'
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

const SearchSourceChip: React.FC<{ source: SearchSource }> = ({ source }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const label = source.profileName || source.domain;
  const tooltip = [source.title, source.domain, source.age].filter(Boolean).join(' | ');
  const showFavicon = source.faviconUrl && !imageFailed;

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={tooltip}
      className="inline-flex min-w-0 max-w-[180px] items-center gap-1.5 border border-border-secondary px-2 py-1 text-text-secondary hover:border-text-primary hover:text-text-primary"
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden border border-border-secondary bg-bg-secondary text-[0.55rem] font-mono uppercase text-text-muted">
        {showFavicon ? (
          <img
            src={source.faviconUrl}
            alt=""
            className="h-4 w-4 object-cover"
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        ) : (
          getSourceInitial(source)
        )}
      </span>
      <span className="min-w-0 truncate font-mono text-[0.65rem]">
        {label}
      </span>
    </a>
  );
};

const SearchSourcesBar: React.FC<{ groups?: SearchSourceGroup[] }> = ({ groups }) => {
  const sources = (groups ?? []).flatMap(group => group.sources);
  const uniqueSources = sources.filter((source, index) => (
    sources.findIndex(candidate => candidate.url === source.url) === index
  ));

  if (!uniqueSources.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-tertiary">
        Sources
      </span>
      {uniqueSources.map(source => (
        <SearchSourceChip key={source.url} source={source} />
      ))}
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

  return (
    <div
      data-message-id={message.id}
      ref={(el) => setMessageRef(message.id, el)}
      className={`flex flex-col gap-2 last:border-b-0 ${message.sender === 'user' ? 'px-2 py-2 border border-border-secondary rounded bg-bg-secondary' : 'border-b border-border-primary py-4'}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.15em] text-text-primary">
          {message.sender === 'user' ? 'you' : 'jarvis'}
        </span>
        <span className="font-mono text-[0.65rem] text-text-tertiary">
          {formatMessageTime(message.timestamp)}
        </span>
        {message.isStreaming && (
          <span className="font-mono text-[0.65rem] text-text-muted animate-pulse">
            streaming...
          </span>
        )}
      </div>

      {isEditing ? (
        <div className="flex flex-col gap-3">
          <textarea
            className="w-full min-h-[60px] border border-text-primary bg-transparent p-3 text-base text-text-primary leading-relaxed resize-none outline-none focus:border-text-primary"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
            <span className="font-mono text-[0.65rem] text-text-tertiary mr-auto">
              Cmd + Enter to submit · Esc to cancel
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
            if (item.renderType === 'browserRun') {
              return (
                <BrowserTraceSection
                  key={item.key}
                  run={item.run}
                  onAutoScrollCancel={onAutoScrollCancel}
                  onAutoScrollReactivate={onAutoScrollReactivate}
                />
              );
            }

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
                <div key={item.key} className="text-base text-text-primary leading-[1.8]">
                  <MarkdownRenderer content={segment.text} />
                </div>
              );
            }
            return null;
          })}

          {message.sender === 'assistant' && (
            <SearchSourcesBar groups={message.searchSources} />
          )}

          {!message.isStreaming && !isLoading && (
            <div className="flex items-center justify-end gap-2">
              {message.sender === 'user' ? (
                <>
                  <MessageActionButton
                    onClick={() => onCopy(message.id, message.text)}
                    label={copiedId === message.id ? 'Copied' : 'Copy'}
                    icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  />
                  <MessageActionButton
                    onClick={() => onStartEdit(message.id, message.text)}
                    label="Edit"
                    icon={<PencilIcon />}
                  />
                </>
              ) : (
                <>
                  <MessageActionButton
                    onClick={() => onCopy(message.id, message.text)}
                    label={copiedId === message.id ? 'Copied' : 'Copy'}
                    icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  />
                  <MessageActionButton
                    onClick={() => onRegenerate(message.id)}
                    label="Regenerate"
                    icon={<RefreshIcon />}
                  />
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
});

const AUTO_SCROLL_BOTTOM_THRESHOLD = 8;
const STREAMING_STICKY_BOTTOM_THRESHOLD = 50;
const VIRTUALIZATION_THRESHOLD = 80;
const VIRTUALIZATION_OVERSCAN = 8;
const DEFAULT_MESSAGE_HEIGHT = 180;

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
  const toolEstimate = (message.browserRuns?.length ?? 0) * 120;
  const sourcesEstimate = message.searchSources?.length ? 44 : 0;
  const baseHeight = message.sender === 'user' ? 74 : 112;
  return Math.max(baseHeight, baseHeight + lineEstimate * 28 + toolEstimate + sourcesEstimate);
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

const MessageList = forwardRef<MessageListHandle, MessageListProps>(({ 
  messages, 
  scrollContainerRef,
  isLoading = false,
  editingMessageId,
  onEditMessage,
  onCancelEdit,
  onResubmitMessage,
  onRegenerateResponse,
}, ref) => {
  const messageRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const autoScrollEnabledRef = useRef(true);
  const messagesColumnRef = useRef<HTMLDivElement>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [heightVersion, setHeightVersion] = useState(0);
  const [virtualViewport, setVirtualViewport] = useState({ scrollTop: 0, height: 0 });

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    autoScrollEnabledRef.current = enabled;
  }, []);

  const cancelAutoScroll = useCallback(() => {
    setAutoScrollEnabled(false);
  }, [setAutoScrollEnabled]);

  const reactivateAutoScroll = useCallback(() => {
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

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
    container.scrollTo({ top: container.scrollHeight, behavior });
    setAutoScrollEnabled(true);
  }, [scrollContainerRef, setAutoScrollEnabled]);

  const maintainScrollAtEnd = useCallback((snapshot: ScrollSnapshot) => {
    if (!snapshot.shouldMaintain) {
      setAutoScrollEnabled(false);
      return;
    }

    scrollToBottomNow();
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

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      const messageElement = messageRefsRef.current.get(messageId);
      if (messageElement) {
        scrollElementIntoView(messageElement);
        return;
      }

      const messageIndex = messages.findIndex(message => message.id === messageId);
      const container = scrollContainerRef.current;
      if (messageIndex !== -1 && container && shouldVirtualize) {
        cancelAutoScroll();
        container.scrollTo({
          top: Math.max(0, heightOffsets.offsets[messageIndex] - 16),
          behavior: 'smooth',
        });
      }
    },
    scrollToMessageHeader: (messageId: string, headerIndex: number) => {
      const messageElement = messageRefsRef.current.get(messageId);
      const headerElement = messageElement?.querySelectorAll('h1, h2, h3')[headerIndex];

      if (headerElement) {
        scrollElementIntoView(headerElement, 24);
      } else if (messageElement) {
        scrollElementIntoView(messageElement);
      } else {
        const messageIndex = messages.findIndex(message => message.id === messageId);
        const container = scrollContainerRef.current;
        if (messageIndex !== -1 && container && shouldVirtualize) {
          cancelAutoScroll();
          container.scrollTo({
            top: Math.max(0, heightOffsets.offsets[messageIndex] - 24),
            behavior: 'smooth',
          });
        }
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
    heightOffsets,
    messages,
    reactivateAutoScroll,
    scrollContainerRef,
    scrollElementIntoView,
    scrollToBottomNow,
    shouldVirtualize,
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
      setAutoScrollEnabled(isNearBottom(container));
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [scrollContainerRef, setAutoScrollEnabled]);

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

  return (
    <div className="flex-1 min-w-0">
      {showEmptyPlaceholder ? (
        <div className="py-8">
          <div className="max-w-[800px] mx-auto px-6">
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <p className="font-playfair text-[2.5rem] text-text-primary mb-4">
                A <span className="italic">Blank</span> Page
              </p>
              <p className="font-mono text-[0.7rem] text-text-tertiary uppercase tracking-[2px]">
                Begin your discourse
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="py-4">
        <div ref={messagesColumnRef} className="max-w-[836px] mx-auto pl-9">
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
