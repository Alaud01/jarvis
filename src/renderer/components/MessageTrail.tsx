import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface MessageTrailProps {
  messages: Message[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

interface HeaderEntry {
  level: 1 | 2 | 3;
  text: string;
}

interface AssistantTrailEntry {
  messageId: string;
  messageIndex: number;
  headers: HeaderEntry[];
  previewHeaders: HeaderEntry[];
  isStreaming?: boolean;
}

interface TrailEntry {
  messageId: string;
  messageIndex: number;
  sender: Message['sender'];
  headers: HeaderEntry[];
  previewHeaders: HeaderEntry[];
  previewText: string;
  isStreaming?: boolean;
}

interface ActiveTrailTarget {
  messageId: string;
  headerIndex?: number;
}

const MAX_PREVIEW_HEADERS = 9;
const ACTIVE_READING_OFFSET = 56;
const TRAIL_COLLAPSE_ANIMATION_MS = 220;

const parseHeaders = (text: string): HeaderEntry[] => {
  let cleanText = text;
  cleanText = cleanText.replace(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*?\n\.\.\.done thinking\./g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*/g, '');
  cleanText = cleanText.replace(/\{\{screenshot:[a-f0-9-]+\}\}/g, '');
  cleanText = cleanText.replace(/```[\s\S]*?```/g, '');

  const headers: HeaderEntry[] = [];
  const lines = cleanText.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)/);
    if (match) {
      const level = match[1].length as 1 | 2 | 3;
      const headerText = match[2].replace(/<[^>]*>/g, '').trim();
      if (headerText) {
        headers.push({ level, text: headerText });
      }
    }
  }
  return headers;
};

const getPreviewHeaders = (headers: HeaderEntry[]): HeaderEntry[] => {
  if (headers.length <= MAX_PREVIEW_HEADERS) {
    return headers;
  }

  for (const maxLevel of [2, 1] as const) {
    const filteredHeaders = headers.filter((header) => header.level <= maxLevel);
    if (filteredHeaders.length <= MAX_PREVIEW_HEADERS) {
      return filteredHeaders;
    }
  }

  return headers.filter((header) => header.level === 1).slice(0, MAX_PREVIEW_HEADERS);
};

const getSourceHeaderIndex = (headers: HeaderEntry[], targetHeader: HeaderEntry): number => {
  return headers.findIndex((header) => header === targetHeader);
};

const getPreview = (text: string, maxLength: number = 120): string => {
  let cleanText = text;
  cleanText = cleanText.replace(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*?\n\.\.\.done thinking\./g, '');
  cleanText = cleanText.replace(/Thinking\.\.\.\n[\s\S]*/g, '');
  cleanText = cleanText.replace(/\{\{screenshot:[a-f0-9-]+\}\}/g, '');
  cleanText = cleanText.replace(/```[\s\S]*?```/g, '');
  cleanText = cleanText.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (cleanText.length <= maxLength) return cleanText;
  return `${cleanText.substring(0, maxLength)}...`;
};

const HEADER_WIDTHS: Record<number, string> = {
  1: 'w-4',
  2: 'w-3',
  3: 'w-2',
};

const HEADER_HOVER_WIDTHS: Record<number, string> = {
  1: 'group-hover/bar:w-5',
  2: 'group-hover/bar:w-4',
  3: 'group-hover/bar:w-3',
};

const HEADER_INDENT: Record<number, string> = {
  1: '',
  2: 'pl-5',
  3: 'pl-9',
};

const InlineMarkdownPreview: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => (
  <span className={`trail-markdown-preview ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <span>{children}</span>,
        strong: ({ children }) => <strong>{children}</strong>,
        em: ({ children }) => <em>{children}</em>,
        code: ({ children }) => <code>{children}</code>,
        a: ({ children }) => <span>{children}</span>,
        del: ({ children }) => <del>{children}</del>,
        br: () => <span> </span>,
        ul: ({ children }) => <span>{children}</span>,
        ol: ({ children }) => <span>{children}</span>,
        li: ({ children }) => <span>{children}</span>,
      }}
    >
      {content}
    </ReactMarkdown>
  </span>
);

interface CollapsedTrailProps {
  messages: Message[];
  assistantEntries: AssistantTrailEntry[];
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

const CollapsedTrail: React.FC<CollapsedTrailProps> = ({ messages, assistantEntries, onScrollToMessage }) => {
  const entriesByMessageId = useMemo(() => {
    return new Map(assistantEntries.map((entry) => [entry.messageId, entry]));
  }, [assistantEntries]);

  return (
    <div className="flex min-h-full flex-col justify-center gap-0.5">
      {messages.map((message) => {
        if (message.sender === 'assistant') {
          const entry = entriesByMessageId.get(message.id);

          return (
            <div
              key={message.id}
              className="flex flex-col"
              onClick={() => onScrollToMessage(message.id)}
            >
              <div className="flex items-center justify-start min-h-2.5 cursor-pointer group/bar">
                <div
                  className="w-5 h-[3px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out
                    group-hover/bar:w-6 group-hover/bar:bg-text-tertiary"
                />
              </div>
              {entry?.previewHeaders.map((header) => {
                const sourceHeaderIndex = getSourceHeaderIndex(entry.headers, header);

                return (
                  <div
                    key={`${message.id}-h-${sourceHeaderIndex}`}
                    className="flex items-center justify-start min-h-1.5 cursor-pointer group/bar"
                    onClick={(e) => {
                      e.stopPropagation();
                      onScrollToMessage(message.id, sourceHeaderIndex);
                    }}
                  >
                    <div
                      className={`${HEADER_WIDTHS[header.level]} h-[2px] bg-border-secondary rounded-[1px] transition-all duration-200 ease-in-out
                        ${HEADER_HOVER_WIDTHS[header.level]} group-hover/bar:bg-text-tertiary`}
                    />
                  </div>
                );
              })}
            </div>
          );
        }

        return (
          <div
            key={message.id}
            className="flex items-center justify-end min-h-2.5 cursor-pointer group"
            onClick={() => onScrollToMessage(message.id)}
          >
            <div
              className={`w-3 h-[3px] bg-border-secondary transition-all duration-200 ease-in-out relative
                rounded-sm
                group-hover:w-4 group-hover:bg-text-tertiary`}
            />
          </div>
        );
      })}
    </div>
  );
};

interface ExpandedTrailProps {
  trailEntries: TrailEntry[];
  activeTarget: ActiveTrailTarget | null;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

const ExpandedTrail: React.FC<ExpandedTrailProps> = ({ trailEntries, activeTarget, onScrollToMessage }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);
  const visibleEntries = trailEntries.filter((entry) => entry.sender === 'user' || entry.headers.length > 0);

  useEffect(() => {
    if (didAutoScrollRef.current || !activeTarget) return;

    const scrollContainer = scrollRef.current;
    const activeElement = scrollContainer?.querySelector<HTMLElement>('[data-trail-active="true"]');
    if (!scrollContainer || !activeElement) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const activeRect = activeElement.getBoundingClientRect();
    const targetScrollTop = scrollContainer.scrollTop + activeRect.top - containerRect.top - (containerRect.height / 2) + (activeRect.height / 2);
    scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'auto' });
    didAutoScrollRef.current = true;
  }, [activeTarget]);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-x-hidden overflow-y-auto bg-[var(--color-bg-secondary)] px-2 py-2">
      <div className="mb-2 px-2 font-mono text-[0.62rem] uppercase tracking-[0.16em] text-text-tertiary">
        Trail
      </div>
      {visibleEntries.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-3">
          {visibleEntries.map((entry) => (
            <div
              key={entry.messageId}
              className={`flex min-w-0 flex-col gap-0.5 ${
                entry.sender === 'user'
                  ? 'rounded border border-border-secondary bg-bg-secondary px-1 py-1'
                  : ''
              }`}
            >
              <button
                type="button"
                className="w-full min-w-0 overflow-hidden rounded-[4px] px-2 py-1 text-left font-mono text-[0.62rem] uppercase tracking-[0.14em] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus:bg-bg-hover focus:text-text-secondary focus:outline-none"
                onClick={() => onScrollToMessage(entry.messageId)}
              >
                <span className={`block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap`}>
                  {entry.sender === 'user' ? 'You' : 'Jarvis'} {entry.messageIndex + 1}{entry.isStreaming ? ' / Streaming' : ''}
                </span>
              </button>
              {entry.sender === 'user' ? (
                <button
                  type="button"
                  data-trail-active={activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined ? 'true' : undefined}
                  className={`block w-full min-w-0 overflow-hidden rounded-[4px] px-2 py-1.5 text-left text-[0.75rem] leading-[1.25] transition-colors hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary focus:outline-none ${
                    activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-secondary'
                  }`}
                  onClick={() => onScrollToMessage(entry.messageId)}
                >
                  <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {entry.isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={entry.previewText || 'Untitled message'} />}
                  </span>
                </button>
              ) : (
                entry.headers.map((header, headerIndex) => (
                  <button
                    key={`${entry.messageId}-${headerIndex}`}
                    type="button"
                    data-trail-active={activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === headerIndex ? 'true' : undefined}
                    className={`block w-full min-w-0 overflow-hidden rounded-[4px] px-2 py-1.5 text-left text-[0.75rem] leading-[1.25] transition-colors hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary focus:outline-none ${HEADER_INDENT[header.level]} ${
                      activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === headerIndex
                        ? 'bg-bg-hover text-text-primary'
                        : 'text-text-tertiary'
                    }`}
                    onClick={() => onScrollToMessage(entry.messageId, headerIndex)}
                  >
                    <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      <InlineMarkdownPreview content={header.text} />
                    </span>
                  </button>
                ))
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-2 text-xs leading-[1.4] text-text-tertiary">
          No messages yet.
        </div>
      )}
    </div>
  );
};

const MessageTrail: React.FC<MessageTrailProps> = ({ messages, scrollContainerRef, onScrollToMessage }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [activeTarget, setActiveTarget] = useState<ActiveTrailTarget | null>(null);
  const collapseTimeoutRef = useRef<number | null>(null);
  const trailEntries = useMemo<TrailEntry[]>(() => {
    return messages.map((message, messageIndex) => {
      const headers = message.sender === 'assistant' ? parseHeaders(message.text) : [];
      return {
        messageId: message.id,
        messageIndex,
        sender: message.sender,
        headers,
        previewHeaders: getPreviewHeaders(headers),
        previewText: getPreview(message.text),
        isStreaming: message.isStreaming,
      };
    });
  }, [messages]);
  const assistantEntries = useMemo<AssistantTrailEntry[]>(() => {
    return trailEntries
      .filter((entry) => entry.sender === 'assistant')
      .map(({ messageId, messageIndex, headers, previewHeaders, isStreaming }) => ({
        messageId,
        messageIndex,
        headers,
        previewHeaders,
        isStreaming,
      }));
  }, [trailEntries]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateActiveTarget = () => {
      const containerRect = container.getBoundingClientRect();
      const readingLine = containerRect.top + ACTIVE_READING_OFFSET;
      const messageElements = new Map(
        Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
          .map((element) => [element.dataset.messageId, element] as const)
      );
      let activeMessage: ActiveTrailTarget | null = null;
      let activeHeader: ActiveTrailTarget | null = null;

      for (const entry of trailEntries) {
        const messageElement = messageElements.get(entry.messageId);
        if (!messageElement) continue;

        const messageTop = messageElement.getBoundingClientRect().top;
        if (messageTop <= readingLine) {
          activeMessage = { messageId: entry.messageId };
        }

        if (entry.sender !== 'assistant') continue;

        const headerElements = Array.from(messageElement.querySelectorAll<HTMLElement>('h1, h2, h3'));
        headerElements.forEach((headerElement, headerIndex) => {
          if (headerElement.getBoundingClientRect().top <= readingLine) {
            activeHeader = { messageId: entry.messageId, headerIndex };
          }
        });
      }

      const nextTarget = activeHeader ?? activeMessage;
      setActiveTarget((currentTarget) => {
        if (
          currentTarget?.messageId === nextTarget?.messageId &&
          currentTarget?.headerIndex === nextTarget?.headerIndex
        ) {
          return currentTarget;
        }
        return nextTarget;
      });
    };

    updateActiveTarget();
    container.addEventListener('scroll', updateActiveTarget, { passive: true });
    window.addEventListener('resize', updateActiveTarget);

    return () => {
      container.removeEventListener('scroll', updateActiveTarget);
      window.removeEventListener('resize', updateActiveTarget);
    };
  }, [scrollContainerRef, trailEntries]);

  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current !== null) {
        window.clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  const expandTrail = () => {
    if (collapseTimeoutRef.current !== null) {
      window.clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsCollapsing(false);
    setIsExpanded(true);
  };

  const collapseTrail = () => {
    if (!isExpanded) return;

    setIsCollapsing(true);
    if (collapseTimeoutRef.current !== null) {
      window.clearTimeout(collapseTimeoutRef.current);
    }
    collapseTimeoutRef.current = window.setTimeout(() => {
      setIsExpanded(false);
      setIsCollapsing(false);
      collapseTimeoutRef.current = null;
    }, TRAIL_COLLAPSE_ANIMATION_MS);
  };

  if (messages.length === 0) return null;

  const shouldRenderExpandedTrail = isExpanded || isCollapsing;

  return (
    <div
      tabIndex={0}
      role="navigation"
      aria-label="Message headers"
      className="relative z-[200] w-8 shrink-0 self-start sticky top-0 h-full max-h-full bg-bg-primary"
      onMouseEnter={expandTrail}
      onMouseLeave={collapseTrail}
      onFocusCapture={expandTrail}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          collapseTrail();
        }
      }}
    >
      {shouldRenderExpandedTrail ? (
        <>
          <div
            className={`h-full max-h-full overflow-y-auto px-1 py-2 pointer-events-none ${
              isCollapsing ? 'message-trail-bars-enter' : 'message-trail-bars-exit'
            }`}
          >
            <CollapsedTrail
              messages={messages}
              assistantEntries={assistantEntries}
              onScrollToMessage={onScrollToMessage}
            />
          </div>
          <div
            className={`fixed right-3 top-12 bottom-4 z-[200] w-[280px] overflow-hidden rounded-md border border-border-secondary bg-[var(--color-bg-secondary)] shadow-lg ${
              isCollapsing ? 'message-trail-panel-exit' : 'message-trail-panel-enter'
            }`}
          >
            <ExpandedTrail
              trailEntries={trailEntries}
              activeTarget={activeTarget}
              onScrollToMessage={onScrollToMessage}
            />
          </div>
        </>
      ) : (
        <div className="h-full max-h-full overflow-y-auto px-1 py-2">
          <CollapsedTrail
            messages={messages}
            assistantEntries={assistantEntries}
            onScrollToMessage={onScrollToMessage}
          />
        </div>
      )}
    </div>
  );
};

export default MessageTrail;
