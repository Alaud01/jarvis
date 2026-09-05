import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { prepareMarkdownMath } from '../utils/markdownMath';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface MessageTrailProps {
  conversationId: string | null;
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

type CachedTrailEntry = Omit<TrailEntry, 'messageIndex'>;

interface ActiveTrailTarget {
  messageId: string;
  headerIndex?: number;
}

interface ActiveTrailState {
  targets: ActiveTrailTarget[];
  primaryTarget: ActiveTrailTarget | null;
}

interface ActiveTrailCandidate {
  target: ActiveTrailTarget;
  top: number;
  bottom: number;
}

// Adaptive collapsed-trail reduction state.
// step 1: all header levels shown, all messages
// step 2: drop h3
// step 3: drop h2+h3 (only h1 bars)
// step 4: no header bars, just the one message-level bar each
// step 5: only N messages kept, centered on the active message
type ReductionStep = 1 | 2 | 3 | 4 | 5;

interface ReductionState {
  step: ReductionStep;
  maxHeaderLevel: 3 | 2 | 1 | 0;
  messageKeepRange: { start: number; end: number } | null;
}

const MAX_HEADER_LEVEL_FOR_STEP: Record<ReductionStep, 3 | 2 | 1 | 0> = {
  1: 3,
  2: 2,
  3: 1,
  4: 0,
  5: 0,
};

// Default (step 1, everything fits) — used as the initial state and whenever
// content fits without any trimming.
const FULL_REDUCTION: ReductionState = {
  step: 1,
  maxHeaderLevel: 3,
  messageKeepRange: null,
};

// Reduction depends on both a conversation's header density and the available
// viewport height. Cache the last measured result per conversation so switching
// conversations never renders the temporary "show every header" state first.
const reductionByConversation = new Map<string, ReductionState>();
const trailEntryByMessage = new WeakMap<Message, CachedTrailEntry>();
const trailEntriesByMessageList = new WeakMap<Message[], TrailEntry[]>();

const areReductionsEqual = (a: ReductionState, b: ReductionState): boolean => (
  a.step === b.step
  && a.maxHeaderLevel === b.maxHeaderLevel
  && a.messageKeepRange?.start === b.messageKeepRange?.start
  && a.messageKeepRange?.end === b.messageKeepRange?.end
);

const getCachedTrailEntries = (messages: Message[]): TrailEntry[] => {
  const cachedEntries = trailEntriesByMessageList.get(messages);
  if (cachedEntries) {
    return cachedEntries;
  }

  const entries = messages.map((message, messageIndex) => {
    let cachedEntry = trailEntryByMessage.get(message);
    if (!cachedEntry) {
      const headers = message.sender === 'assistant' ? parseHeaders(message.text) : [];
      cachedEntry = {
        messageId: message.id,
        sender: message.sender,
        headers,
        previewHeaders: getPreviewHeaders(headers),
        previewText: getPreview(message.text),
        isStreaming: message.isStreaming,
      };
      trailEntryByMessage.set(message, cachedEntry);
    }
    return { ...cachedEntry, messageIndex };
  });

  trailEntriesByMessageList.set(messages, entries);
  return entries;
};

const MAX_PREVIEW_HEADERS = 9;
const ACTIVE_READING_OFFSET = 56;
const TRAIL_COLLAPSE_ANIMATION_MS = 220;
const TRAIL_HOVER_RECHECK_MS = 300;
const EXPANDED_PANEL_VERTICAL_MARGIN = 12;

// Adaptive collapsed-trail reduction: row-height estimates (in px) used to
// compute whether content fits without scrolling. Calibrated once from the
// real DOM on mount; these are the Tailwind-derived fallbacks.
const MSG_ROW_HEIGHT_FALLBACK = 10;
const HEADER_ROW_HEIGHT_FALLBACK = 6;
const ROW_GAP_FALLBACK = 2;
const COLLAPSED_PADDING_FALLBACK = 8;

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

const targetKey = (target: ActiveTrailTarget | null): string => (
  target ? `${target.messageId}:${target.headerIndex ?? 'message'}` : ''
);

const areTargetsEqual = (a: ActiveTrailTarget | null, b: ActiveTrailTarget | null): boolean => (
  a?.messageId === b?.messageId && a?.headerIndex === b?.headerIndex
);

const areTargetListsEqual = (a: ActiveTrailTarget[], b: ActiveTrailTarget[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((target, index) => areTargetsEqual(target, b[index]));
};

const targetIntersectsViewport = (top: number, bottom: number, viewportTop: number, viewportBottom: number): boolean => (
  bottom > viewportTop && top < viewportBottom
);

const isTargetActive = (targets: ActiveTrailTarget[], messageId: string, headerIndex?: number): boolean => (
  targets.some((target) => target.messageId === messageId && target.headerIndex === headerIndex)
);

// Like getActivePreviewHeaderSourceIndex but operates on an arbitrary filtered
// header list (the headers actually displayed after reduction). When the
// active header's level has been dropped entirely, returns null so the caller
// falls back to highlighting the message-level bar.
const getActiveDisplayHeaderSourceIndex = (
  fullHeaders: HeaderEntry[],
  displayHeaders: HeaderEntry[],
  activeTarget: ActiveTrailTarget | null,
  messageId: string
): number | null => {
  if (activeTarget?.messageId !== messageId || activeTarget.headerIndex === undefined) {
    return null;
  }
  const targetHeaderIndex = activeTarget.headerIndex;
  return displayHeaders.reduce<number | null>((activeSourceIndex, header) => {
    const sourceHeaderIndex = getSourceHeaderIndex(fullHeaders, header);
    if (sourceHeaderIndex === -1 || sourceHeaderIndex > targetHeaderIndex) {
      return activeSourceIndex;
    }
    if (activeSourceIndex === null || sourceHeaderIndex > activeSourceIndex) {
      return sourceHeaderIndex;
    }
    return activeSourceIndex;
  }, null);
};

const getActiveDisplayHeaderSourceIndexes = (
  fullHeaders: HeaderEntry[],
  displayHeaders: HeaderEntry[],
  activeTargets: ActiveTrailTarget[],
  messageId: string
): Set<number> => {
  const sourceIndexes = new Set<number>();
  for (const activeTarget of activeTargets) {
    const sourceIndex = getActiveDisplayHeaderSourceIndex(fullHeaders, displayHeaders, activeTarget, messageId);
    if (sourceIndex !== null) {
      sourceIndexes.add(sourceIndex);
    }
  }
  return sourceIndexes;
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

// Transition classes for smoothly collapsing a trail row when the reduction
// level drops it. Visible rows keep their natural min-height + a generous
// max-height; hidden rows collapse to 0 and fade out. Spacing is done with
// per-row bottom margin (transitioned) rather than flex gap, so a hidden row
// contributes no vertical space once collapsed.
const ROW_TRANSITION = 'overflow-hidden transition-[min-height,max-height,opacity,margin-bottom] duration-200 ease-in-out';
const ROW_SPACING_VISIBLE = 'mb-[1px]';

const ROW_SPACING_HIDDEN = 'mb-0';
const InlineMarkdownPreview: React.FC<{ content: string; className?: string }> = ({ content, className = '' }) => (
  <span className={`trail-markdown-preview ${className}`}>
    <ReactMarkdown
      remarkPlugins={[[remarkMath, { singleDollarTextMath: true }], [remarkGfm, { singleTilde: false }]]}
      rehypePlugins={[rehypeKatex]}
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
      {prepareMarkdownMath(content)}
    </ReactMarkdown>
  </span>
);

interface CollapsedTrailProps {
  messages: Message[];
  assistantEntries: AssistantTrailEntry[];
  activeTargets: ActiveTrailTarget[];
  reduction: ReductionState;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

const MSG_ROW_VISIBLE_CLASS = 'min-h-2 max-h-6 opacity-100';
const MSG_ROW_HIDDEN_CLASS = 'min-h-0 max-h-0 opacity-0';
const HDR_ROW_VISIBLE_CLASS = 'min-h-1 max-h-4 opacity-100';
const HDR_ROW_HIDDEN_CLASS = 'min-h-0 max-h-0 opacity-0';

const CollapsedTrail: React.FC<CollapsedTrailProps> = ({ messages, assistantEntries, activeTargets, reduction, onScrollToMessage }) => {
  const entriesByMessageId = useMemo(() => {
    return new Map(assistantEntries.map((entry) => [entry.messageId, entry]));
  }, [assistantEntries]);

  // Precompute which preview headers are visible at the current reduction
  // level. We render ALL preview headers for every message, but hidden ones
  // collapse (height->0, opacity->0) with a CSS transition so dropping a
  // header level animates instead of popping.
  const visibleFlagsByMessageId = useMemo(() => {
    const map = new Map<string, boolean[]>();
    const maxLevel = reduction.maxHeaderLevel;
    for (const entry of assistantEntries) {
      map.set(
        entry.messageId,
        entry.previewHeaders.map((header) => maxLevel === 0 ? false : header.level <= maxLevel)
      );
    }
    return map;
  }, [assistantEntries, reduction.maxHeaderLevel]);

  return (
    <div className="flex flex-col">
      {messages.map((message, messageIndex) => {
        const inRange = !reduction.messageKeepRange
          || (messageIndex >= reduction.messageKeepRange.start && messageIndex < reduction.messageKeepRange.end);

        if (message.sender === 'assistant') {
          const entry = entriesByMessageId.get(message.id);
          const visibleFlags = entry ? (visibleFlagsByMessageId.get(message.id) ?? []) : [];
          // Active highlight runs over the currently-visible (not-yet-collapsed)
          // header rows so a dropped active header cleanly falls back to the bar.
          const visibleHeaders = entry
            ? entry.previewHeaders.filter((_, i) => visibleFlags[i])
            : [];
          const activePreviewHeaderSourceIndexes = entry && inRange
            ? getActiveDisplayHeaderSourceIndexes(entry.headers, visibleHeaders, activeTargets, message.id)
            : new Set<number>();
          const hasActiveTargetForMessage = activeTargets.some((target) => target.messageId === message.id);
          const hasMessageLevelTarget = isTargetActive(activeTargets, message.id);
          const isMessageActive = inRange && (
            hasMessageLevelTarget ||
            (hasActiveTargetForMessage && activePreviewHeaderSourceIndexes.size === 0)
          );

          return (
            <div
              key={message.id}
              className="flex flex-col"
              onClick={() => inRange && onScrollToMessage(message.id)}
            >
              <div
                className={`flex items-center justify-start cursor-pointer group/bar ${ROW_TRANSITION} ${
                  inRange ? `${MSG_ROW_VISIBLE_CLASS} ${ROW_SPACING_VISIBLE}` : `${MSG_ROW_HIDDEN_CLASS} ${ROW_SPACING_HIDDEN}`
                }`}
              >
                <div
                  className={`w-5 h-[2px] bg-border-secondary transition-[width,background-color,box-shadow] duration-200 ease-in-out
                    group-hover/bar:w-6 group-hover/bar:bg-text-tertiary ${isMessageActive ? 'message-trail-bar-active' : ''}`}
                />
              </div>
              {entry?.previewHeaders.map((header, i) => {
                const sourceHeaderIndex = getSourceHeaderIndex(entry.headers, header);
                const visible = visibleFlags[i];
                const isHeaderActive = visible && inRange && activePreviewHeaderSourceIndexes.has(sourceHeaderIndex);

                return (
                  <div
                    key={`${message.id}-h-${sourceHeaderIndex}`}
                    className={`flex items-center justify-start cursor-pointer group/bar ${ROW_TRANSITION} ${
                      visible ? `${HDR_ROW_VISIBLE_CLASS} ${ROW_SPACING_VISIBLE}` : `${HDR_ROW_HIDDEN_CLASS} ${ROW_SPACING_HIDDEN}`
                    }`}
                    onClick={(e) => {
                      if (!visible || !inRange) return;
                      e.stopPropagation();
                      onScrollToMessage(message.id, sourceHeaderIndex);
                    }}
                  >
                    <div
                      className={`${HEADER_WIDTHS[header.level]} h-[1px] bg-border-secondary transition-[width,background-color,box-shadow] duration-200 ease-in-out
                        ${HEADER_HOVER_WIDTHS[header.level]} group-hover/bar:bg-text-tertiary ${isHeaderActive ? 'message-trail-bar-active' : ''}`}
                    />
                  </div>
                );
              })}
            </div>
          );
        }

        const isMessageActive = inRange && isTargetActive(activeTargets, message.id);

        return (
          <div
            key={message.id}
            className={`flex items-center justify-end cursor-pointer group ${ROW_TRANSITION} ${
              inRange ? `${MSG_ROW_VISIBLE_CLASS} ${ROW_SPACING_VISIBLE}` : `${MSG_ROW_HIDDEN_CLASS} ${ROW_SPACING_HIDDEN}`
            }`}
            onClick={() => inRange && onScrollToMessage(message.id)}
          >
            <div
              className={`w-3 h-[2px] bg-border-secondary transition-[width,background-color,box-shadow] duration-200 ease-in-out relative
                group-hover:w-4 group-hover:bg-text-tertiary ${isMessageActive ? 'message-trail-bar-active' : ''}`}
            />
          </div>
        );
      })}
    </div>
  );
};

interface ExpandedTrailProps {
  trailEntries: TrailEntry[];
  reduction: ReductionState;
  primaryActiveTarget: ActiveTrailTarget | null;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

interface ExpandedPanelFrame {
  top: number;
  left: number;
  height: number;
}

interface ExpandedTrailHoverFrame {
  top: number;
  left: number;
  width: number;
  height: number;
}

const ExpandedTrail: React.FC<ExpandedTrailProps> = ({
  trailEntries,
  reduction,
  primaryActiveTarget,
  onScrollToMessage,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);
  const [hoveredTargetKey, setHoveredTargetKey] = useState<string | null>(null);
  const [hoverFrame, setHoverFrame] = useState<ExpandedTrailHoverFrame | null>(null);

  // Mirror the collapsed trail's adaptive reduction so expanded content shows
  // the same messages/headers and grows/shrinks with window size.
  const visibleEntries = useMemo(() => {
    const maxLevel = reduction.maxHeaderLevel;
    return trailEntries
      .filter((entry) => {
        if (reduction.messageKeepRange) {
          const { start, end } = reduction.messageKeepRange;
          if (entry.messageIndex < start || entry.messageIndex >= end) return false;
        }
        return (
          entry.sender === 'user'
          || entry.headers.length > 0
          || entry.previewText.length > 0
          || entry.isStreaming
        );
      })
      .map((entry) => {
        if (entry.sender !== 'assistant') {
          return { ...entry, displayHeaders: [] as HeaderEntry[], showMessagePreview: true };
        }
        const displayHeaders = maxLevel === 0
          ? []
          : entry.previewHeaders.filter((header) => header.level <= maxLevel);
        // Only use the body-preview fallback when the message never had header
        // bars — not when reduction dropped them — so item count stays in sync
        // with the collapsed trail.
        const showMessagePreview = entry.previewHeaders.length === 0;
        return { ...entry, displayHeaders, showMessagePreview };
      });
  }, [trailEntries, reduction]);

  const updateHoverFrame = useCallback(() => {
    const content = contentRef.current;
    if (!content || !hoveredTargetKey) {
      return;
    }

    const target = content.querySelector<HTMLElement>(
      `[data-expanded-trail-target="${CSS.escape(hoveredTargetKey)}"]`,
    );
    if (!target) {
      return;
    }

    const contentRect = content.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const nextFrame = {
      top: targetRect.top - contentRect.top,
      left: targetRect.left - contentRect.left,
      width: targetRect.width,
      height: targetRect.height,
    };
    setHoverFrame((current) => (
      current?.top === nextFrame.top
      && current.left === nextFrame.left
      && current.width === nextFrame.width
      && current.height === nextFrame.height
        ? current
        : nextFrame
    ));
  }, [hoveredTargetKey]);

  useLayoutEffect(() => {
    updateHoverFrame();
  }, [visibleEntries, updateHoverFrame]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateHoverFrame)
      : null;
    resizeObserver?.observe(content);
    window.addEventListener('resize', updateHoverFrame);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateHoverFrame);
    };
  }, [updateHoverFrame]);

  useEffect(() => {
    if (!hoveredTargetKey) return;

    let hoverRecheckTimeout: number | null = null;
    const recheckHover = () => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-expanded-trail-target="${CSS.escape(hoveredTargetKey)}"]`,
      );
      if (!document.hasFocus() || (!target?.matches(':hover') && !target?.matches(':focus'))) {
        setHoveredTargetKey((current) => current === hoveredTargetKey ? null : current);
        return;
      }
      hoverRecheckTimeout = window.setTimeout(recheckHover, TRAIL_HOVER_RECHECK_MS);
    };

    hoverRecheckTimeout = window.setTimeout(recheckHover, TRAIL_HOVER_RECHECK_MS);
    return () => {
      if (hoverRecheckTimeout !== null) window.clearTimeout(hoverRecheckTimeout);
    };
  }, [hoveredTargetKey]);

  const hoverTargetProps = (key: string) => ({
    'data-expanded-trail-target': key,
    onMouseEnter: () => setHoveredTargetKey(key),
    onMouseLeave: () => setHoveredTargetKey((current) => current === key ? null : current),
    onFocus: () => setHoveredTargetKey(key),
    onBlur: () => setHoveredTargetKey((current) => current === key ? null : current),
  });

  useEffect(() => {
    if (didAutoScrollRef.current || !primaryActiveTarget) return;

    const scrollContainer = scrollRef.current;
    const activeElement = scrollContainer?.querySelector<HTMLElement>('[data-trail-primary-active="true"]')
      ?? scrollContainer?.querySelector<HTMLElement>('[data-trail-active="true"]');
    if (!scrollContainer || !activeElement) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const activeRect = activeElement.getBoundingClientRect();
    const targetScrollTop = scrollContainer.scrollTop + activeRect.top - containerRect.top - (containerRect.height / 2) + (activeRect.height / 2);
    scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'auto' });
    didAutoScrollRef.current = true;
  }, [primaryActiveTarget]);

  return (
    <div ref={scrollRef} className="expanded-trail-scroll max-h-[inherit] min-h-0 overflow-x-hidden overflow-y-auto bg-[var(--color-bg-secondary)] px-1.5 py-1.5">
      {visibleEntries.length > 0 ? (
        <div ref={contentRef} className="relative flex min-w-0 flex-col gap-0">
          {hoverFrame ? (
            <div
              aria-hidden="true"
              data-expanded-trail-highlight
              className="pointer-events-none absolute z-0 rounded bg-bg-active transition-[transform,width,height,opacity] duration-200 ease-out motion-reduce:transition-none"
              style={{
                width: hoverFrame.width,
                height: hoverFrame.height,
                opacity: hoveredTargetKey ? 1 : 0,
                transform: `translate3d(${hoverFrame.left}px, ${hoverFrame.top}px, 0)`,
              }}
            />
          ) : null}
          {visibleEntries.map((entry) => {
            const activeDisplayHeaderSourceIndex = entry.sender === 'assistant'
              ? getActiveDisplayHeaderSourceIndex(
                entry.headers,
                entry.displayHeaders,
                primaryActiveTarget,
                entry.messageId,
              )
              : null;
            const hasActiveTargetForMessage = primaryActiveTarget?.messageId === entry.messageId;
            const hasMessageLevelTarget = areTargetsEqual(primaryActiveTarget, { messageId: entry.messageId });
            // When the active header's level was reduced away, fall back to the
            // message-level row — same behavior as the collapsed trail bars.
            const isMessagePrimaryActive = hasMessageLevelTarget
              || (hasActiveTargetForMessage && activeDisplayHeaderSourceIndex === null);

            return (
            <div
              key={entry.messageId}
              className="relative z-10 flex min-w-0 flex-col gap-0"
            >
              {entry.sender === 'user' ? (
                <button
                  type="button"
                  data-trail-primary-active={isMessagePrimaryActive ? 'true' : undefined}
                  {...hoverTargetProps(targetKey({ messageId: entry.messageId }))}
                  className="flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded border border-border-secondary px-1.5 py-1 text-left text-text-secondary transition-colors hover:text-text-primary focus:text-text-primary focus:outline-none"
                  onClick={() => onScrollToMessage(entry.messageId)}
                >
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.5rem] uppercase tracking-[0.12em] text-text-tertiary">
                    You {entry.messageIndex + 1}{entry.isStreaming ? ' / Streaming' : ''}
                  </span>
                  <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.7rem] leading-[1.2]">
                    {entry.isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={entry.previewText || 'Untitled message'} />}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    data-trail-primary-active={isMessagePrimaryActive ? 'true' : undefined}
                    {...hoverTargetProps(`${entry.messageId}:label`)}
                    className="flex h-[1.35rem] w-full min-w-0 items-center overflow-hidden px-1.5 text-left font-mono text-[0.5rem] uppercase tracking-[0.12em] text-text-tertiary transition-colors hover:text-text-secondary focus:text-text-secondary focus:outline-none"
                    onClick={() => onScrollToMessage(entry.messageId)}
                  >
                    <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      Jarvis {entry.messageIndex + 1}{entry.isStreaming ? ' / Streaming' : ''}
                    </span>
                  </button>
                  {entry.displayHeaders.length > 0 ? (
                    entry.displayHeaders.map((header) => {
                      const sourceHeaderIndex = getSourceHeaderIndex(entry.headers, header);
                      const primaryActive = activeDisplayHeaderSourceIndex === sourceHeaderIndex;
                      return (
                      <button
                        key={`${entry.messageId}-${sourceHeaderIndex}`}
                        type="button"
                        data-trail-primary-active={primaryActive ? 'true' : undefined}
                        {...hoverTargetProps(targetKey({ messageId: entry.messageId, headerIndex: sourceHeaderIndex }))}
                        className={`block w-full min-w-0 overflow-hidden px-1.5 py-1 text-left text-[0.7rem] leading-[1.2] text-text-tertiary transition-colors hover:text-text-primary focus:text-text-primary focus:outline-none ${HEADER_INDENT[header.level]}`}
                        onClick={() => onScrollToMessage(entry.messageId, sourceHeaderIndex)}
                      >
                        <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                          <InlineMarkdownPreview content={header.text} />
                        </span>
                      </button>
                      );
                    })
                  ) : entry.showMessagePreview ? (
                    <button
                      type="button"
                      data-trail-primary-active={isMessagePrimaryActive ? 'true' : undefined}
                      {...hoverTargetProps(targetKey({ messageId: entry.messageId }))}
                      className="block w-full min-w-0 overflow-hidden px-1.5 py-1 text-left text-[0.7rem] leading-[1.2] text-text-tertiary transition-colors hover:text-text-primary focus:text-text-primary focus:outline-none"
                      onClick={() => onScrollToMessage(entry.messageId)}
                    >
                      <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {entry.isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={entry.previewText || 'Untitled message'} />}
                      </span>
                    </button>
                  ) : null}
                </>
              )}
            </div>
            );
          })}
        </div>
      ) : (
        <div className="px-2 text-xs leading-[1.4] text-text-tertiary">
          No messages yet.
        </div>
      )}
    </div>
  );
};

const MessageTrail: React.FC<MessageTrailProps> = ({
  conversationId,
  messages,
  scrollContainerRef,
  onScrollToMessage,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [activeTrailState, setActiveTrailState] = useState<ActiveTrailState>({
    targets: [],
    primaryTarget: null,
  });
  const [expandedPanelFrame, setExpandedPanelFrame] = useState<ExpandedPanelFrame | null>(null);
  const collapseTimeoutRef = useRef<number | null>(null);
  const hoverRecheckTimeoutRef = useRef<number | null>(null);
  const collapseFinishedRef = useRef(false);
  const expandedPanelRef = useRef<HTMLDivElement>(null);
  const collapsedBarsRef = useRef<HTMLDivElement>(null);
  const collapsedHoverRef = useRef<HTMLDivElement>(null);
  const isExpandedRef = useRef(isExpanded);

  useEffect(() => {
    isExpandedRef.current = isExpanded;
  }, [isExpanded]);

  const trailEntries = useMemo<TrailEntry[]>(() => getCachedTrailEntries(messages), [messages]);
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

  // Keep the owner alongside the state because this component is reused when
  // switching conversations. During the switching render, use that conversation's
  // cache directly rather than briefly displaying the previous view's reduction.
  const cachedReduction = conversationId
    ? reductionByConversation.get(conversationId)
    : undefined;
  const [reductionSnapshot, setReductionSnapshot] = useState(() => ({
    conversationId,
    reduction: cachedReduction ?? FULL_REDUCTION,
    ready: Boolean(cachedReduction),
  }));
  const snapshotIsCurrent = reductionSnapshot.conversationId === conversationId;
  const reduction = snapshotIsCurrent
    ? reductionSnapshot.reduction
    : cachedReduction ?? FULL_REDUCTION;
  const isReductionReady = snapshotIsCurrent
    ? reductionSnapshot.ready
    : Boolean(cachedReduction);
  const [containerHeight, setContainerHeight] = useState(0);
  const metricsRef = useRef({
    msgRowHeight: MSG_ROW_HEIGHT_FALLBACK,
    headerRowHeight: HEADER_ROW_HEIGHT_FALLBACK,
    rowGap: ROW_GAP_FALLBACK,
    padding: COLLAPSED_PADDING_FALLBACK,
    calibrated: false,
  });

  const commitReduction = useCallback((nextReduction: ReductionState) => {
    if (conversationId) {
      reductionByConversation.set(conversationId, nextReduction);
    }
    setReductionSnapshot((current) => {
      if (
        current.conversationId === conversationId
        && current.ready
        && areReductionsEqual(current.reduction, nextReduction)
      ) {
        return current;
      }
      return {
        conversationId,
        reduction: nextReduction,
        ready: true,
      };
    });
  }, [conversationId]);

  // Total collapsed content height (px) for a given reduction step. Visible
  // rows contribute their height plus a bottom margin (rowGap); hidden rows
  // contribute 0 height and 0 margin. The last visible row still carries its
  // margin (over-estimate by one gap; harmless — prefers trimming slightly).
  const stepHeight = useCallback(
    (step: ReductionStep, messageCount: number) => {
      const m = metricsRef.current;
      const maxLevel = MAX_HEADER_LEVEL_FOR_STEP[step];
      let headerRows = 0;
      if (maxLevel > 0) {
        for (const entry of assistantEntries) {
          headerRows += entry.previewHeaders.filter((h) => h.level <= maxLevel).length;
        }
      }
      const totalRows = messageCount + headerRows;
      if (totalRows === 0) return 0;
      return (
        messageCount * (m.msgRowHeight + m.rowGap) +
        headerRows * (m.headerRowHeight + m.rowGap)
      );
    },
    [assistantEntries]
  );

  // Find the index of the active message within the full `messages` array, so
  // step 5 can center the kept window on it. Falls back to the last message.
  const activeMessageIndex = useMemo(() => {
    if (!activeTrailState.primaryTarget) return messages.length - 1;
    const idx = messages.findIndex((m) => m.id === activeTrailState.primaryTarget?.messageId);
    return idx === -1 ? messages.length - 1 : idx;
  }, [activeTrailState.primaryTarget, messages]);

  // Calibrate row-height metrics from the real DOM once (after first render
  // with content), then (re)compute the reduction whenever the inputs change.
  // Runs synchronously (useLayoutEffect) so there's no visible overflow flash.
  useLayoutEffect(() => {
    const wrapper = collapsedBarsRef.current;
    if (!wrapper) return;

    // Calibrate from the rendered rows if not already done.
    if (!metricsRef.current.calibrated) {
      const msgRow = wrapper.querySelector<HTMLElement>('.min-h-2');
      const headerRow = wrapper.querySelector<HTMLElement>('.min-h-1');
      const containerStyle = window.getComputedStyle(wrapper);
      const firstRow = wrapper.querySelector<HTMLElement>(':scope > div > div');
      if (msgRow || headerRow || firstRow) {
        // Spacing is via per-row margin-bottom (mb-0.5); measure it from a row.
        let measuredGap = ROW_GAP_FALLBACK;
        const gapSource = msgRow ?? headerRow ?? firstRow;
        if (gapSource) {
          const parsed = parseFloat(window.getComputedStyle(gapSource).marginBottom || '');
          if (!Number.isNaN(parsed) && parsed >= 0) measuredGap = parsed;
        }
        metricsRef.current = {
          msgRowHeight: msgRow ? msgRow.getBoundingClientRect().height : MSG_ROW_HEIGHT_FALLBACK,
          headerRowHeight: headerRow ? headerRow.getBoundingClientRect().height : HEADER_ROW_HEIGHT_FALLBACK,
          rowGap: measuredGap,
          padding: parseFloat(containerStyle.paddingTop || '') + parseFloat(containerStyle.paddingBottom || '') || COLLAPSED_PADDING_FALLBACK,
          calibrated: true,
        };
      }
    }

    const m = metricsRef.current;
    const available = wrapper.clientHeight - m.padding;
    if (available <= 0) {
      // The sticky wrapper can report zero for one frame while a conversation
      // mounts. Keep the cached result (or remain hidden) until it is measurable.
      return;
    }

    const total = messages.length;
    if (total === 0) {
      return;
    }

    // Try steps 1..4 with all messages; pick the first that fits. Step 4 uses
    // the collapsed-row height (min-height 0) so trimmed header rows still
    // contribute ~0px in the height model.
    for (const step of [1, 2, 3, 4] as ReductionStep[]) {
      if (stepHeight(step, total) <= available) {
        commitReduction({ step, maxHeaderLevel: MAX_HEADER_LEVEL_FOR_STEP[step], messageKeepRange: null });
        return;
      }
    }

    // Step 5: no headers, keep only N messages centered on the active message.
    const perMsg = m.msgRowHeight + m.rowGap;
    let n = perMsg > 0 ? Math.floor((available + m.rowGap) / perMsg) : total;
    n = Math.max(1, Math.min(n, total));

    let start = activeMessageIndex - Math.floor(n / 2);
    start = Math.max(0, Math.min(start, total - n));
    const end = start + n;
    commitReduction({ step: 5, maxHeaderLevel: 0, messageKeepRange: { start, end } });
  }, [messages, assistantEntries, activeMessageIndex, commitReduction, containerHeight, stepHeight]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const updateActiveTargets = () => {
      const containerRect = container.getBoundingClientRect();
      const viewportTop = containerRect.top;
      const viewportBottom = containerRect.bottom;
      const readingLine = containerRect.top + ACTIVE_READING_OFFSET;
      const messageElements = new Map<string, HTMLElement>();
      container.querySelectorAll<HTMLElement>('[data-message-id]').forEach((element) => {
        if (element.dataset.messageId) {
          messageElements.set(element.dataset.messageId, element);
        }
      });

      const candidates: ActiveTrailCandidate[] = [];
      const addCandidate = (target: ActiveTrailTarget, top: number, bottom: number) => {
        if (!targetIntersectsViewport(top, bottom, viewportTop, viewportBottom)) return;
        candidates.push({ target, top, bottom });
      };

      for (const entry of trailEntries) {
        const messageElement = messageElements.get(entry.messageId);
        if (!messageElement) continue;

        const messageRect = messageElement.getBoundingClientRect();
        if (!targetIntersectsViewport(messageRect.top, messageRect.bottom, viewportTop, viewportBottom)) {
          continue;
        }

        if (entry.sender !== 'assistant') {
          addCandidate({ messageId: entry.messageId }, messageRect.top, messageRect.bottom);
          continue;
        }

        const headerElements = Array.from(messageElement.querySelectorAll<HTMLElement>('h1, h2, h3'));
        if (headerElements.length === 0) {
          addCandidate({ messageId: entry.messageId }, messageRect.top, messageRect.bottom);
          continue;
        }

        const firstHeaderRect = headerElements[0].getBoundingClientRect();
        addCandidate({ messageId: entry.messageId }, messageRect.top, firstHeaderRect.top);

        headerElements.forEach((headerElement, headerIndex) => {
          const headerRect = headerElement.getBoundingClientRect();
          const nextHeaderRect = headerElements[headerIndex + 1]?.getBoundingClientRect();
          const sectionBottom = nextHeaderRect?.top ?? messageRect.bottom;
          addCandidate({ messageId: entry.messageId, headerIndex }, headerRect.top, sectionBottom);
        });
      }

      const dedupedTargets: ActiveTrailTarget[] = [];
      const seenTargets = new Set<string>();
      for (const candidate of candidates) {
        const key = targetKey(candidate.target);
        if (!seenTargets.has(key)) {
          seenTargets.add(key);
          dedupedTargets.push(candidate.target);
        }
      }

      const primaryCandidate = candidates.reduce<ActiveTrailCandidate | null>((best, candidate) => {
        const distance = readingLine < candidate.top
          ? candidate.top - readingLine
          : readingLine > candidate.bottom
            ? readingLine - candidate.bottom
            : 0;

        if (!best) return candidate;

        const bestDistance = readingLine < best.top
          ? best.top - readingLine
          : readingLine > best.bottom
            ? readingLine - best.bottom
            : 0;

        if (distance < bestDistance) {
          return candidate;
        }

        if (distance === bestDistance && candidate.top >= best.top) {
          return candidate;
        }

        return best;
      }, null);

      const nextState: ActiveTrailState = {
        targets: dedupedTargets,
        primaryTarget: primaryCandidate?.target ?? null,
      };

      setActiveTrailState((currentState) => {
        if (
          areTargetListsEqual(currentState.targets, nextState.targets) &&
          areTargetsEqual(currentState.primaryTarget, nextState.primaryTarget)
        ) {
          return currentState;
        }
        return nextState;
      });
    };

    updateActiveTargets();
    container.addEventListener('scroll', updateActiveTargets, { passive: true });
    const handleResize = () => {
      updateActiveTargets();
      const wrapper = collapsedBarsRef.current;
      if (wrapper) setContainerHeight(wrapper.clientHeight);
    };
    window.addEventListener('resize', handleResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      updateActiveTargets();
      const wrapper = collapsedBarsRef.current;
      if (wrapper) setContainerHeight(wrapper.clientHeight);
    }) : null;
    if (ro && collapsedBarsRef.current) ro.observe(collapsedBarsRef.current);

    return () => {
      container.removeEventListener('scroll', updateActiveTargets);
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
    };
  }, [scrollContainerRef, trailEntries]);

  const clearHoverRecheck = useCallback(() => {
    if (hoverRecheckTimeoutRef.current !== null) {
      window.clearTimeout(hoverRecheckTimeoutRef.current);
      hoverRecheckTimeoutRef.current = null;
    }
  }, []);

  const collapseTrailImmediate = useCallback(() => {
    clearHoverRecheck();
    if (collapseTimeoutRef.current !== null) {
      window.clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsCollapsing(false);
    setIsExpanded(false);
  }, [clearHoverRecheck]);

  const collapseTrail = useCallback(() => {
    if (!isExpandedRef.current || isCollapsing) return;

    clearHoverRecheck();
    setIsCollapsing(true);
  }, [clearHoverRecheck, isCollapsing]);

  useEffect(() => {
    if (!isCollapsing) return;

    const wrapper = collapsedBarsRef.current;
    if (!wrapper) return;

    collapseFinishedRef.current = false;

    const finishCollapse = () => {
      if (collapseFinishedRef.current) return;
      collapseFinishedRef.current = true;
      setIsExpanded(false);
      setIsCollapsing(false);
      if (collapseTimeoutRef.current !== null) {
        window.clearTimeout(collapseTimeoutRef.current);
        collapseTimeoutRef.current = null;
      }
    };

    const handleAnimationEnd = (event: AnimationEvent) => {
      if (event.target !== wrapper || event.animationName !== 'messageTrailBarsEnter') return;
      finishCollapse();
    };

    wrapper.addEventListener('animationend', handleAnimationEnd);
    collapseTimeoutRef.current = window.setTimeout(finishCollapse, TRAIL_COLLAPSE_ANIMATION_MS);

    return () => {
      wrapper.removeEventListener('animationend', handleAnimationEnd);
    };
  }, [isCollapsing]);

  const collapseTrailIfNotHovered = useCallback(() => {
    requestAnimationFrame(() => {
      if (!isExpandedRef.current) return;

      const expandedPanelHovered = expandedPanelRef.current?.matches(':hover') ?? false;
      const collapsedHovered = collapsedHoverRef.current?.matches(':hover') ?? false;
      if (!expandedPanelHovered && !collapsedHovered) {
        collapseTrail();
      }
    });
  }, [collapseTrail]);

  const scheduleHoverRecheck = useCallback(() => {
    if (!isExpandedRef.current) return;

    clearHoverRecheck();
    hoverRecheckTimeoutRef.current = window.setTimeout(() => {
      hoverRecheckTimeoutRef.current = null;
      collapseTrailIfNotHovered();
    }, TRAIL_HOVER_RECHECK_MS);
  }, [clearHoverRecheck, collapseTrailIfNotHovered]);

  useEffect(() => {
    const handleWindowBlur = () => {
      scheduleHoverRecheck();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        collapseTrailImmediate();
      }
    };

    const handleWindowFocus = () => {
      clearHoverRecheck();
      collapseTrailIfNotHovered();
    };

    const handleDocumentMouseLeave = (event: MouseEvent) => {
      if (!event.relatedTarget) {
        scheduleHoverRecheck();
      }
    };

    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    document.documentElement.addEventListener('mouseleave', handleDocumentMouseLeave);

    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      document.documentElement.removeEventListener('mouseleave', handleDocumentMouseLeave);
      clearHoverRecheck();
      if (collapseTimeoutRef.current !== null) {
        window.clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, [clearHoverRecheck, collapseTrailImmediate, collapseTrailIfNotHovered, scheduleHoverRecheck]);

  const expandTrail = () => {
    clearHoverRecheck();
    if (collapseTimeoutRef.current !== null) {
      window.clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    setIsCollapsing(false);
    setIsExpanded(true);
  };

  const showPanel = isExpanded || isCollapsing;
  const barsAnimationClass = showPanel
    ? (isCollapsing ? 'message-trail-bars-enter' : 'message-trail-bars-exit')
    : '';

  useLayoutEffect(() => {
    if (!showPanel) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const updateExpandedPanelFrame = () => {
      const rect = container.getBoundingClientRect();
      setExpandedPanelFrame((current) => {
        const height = Math.max(0, rect.height - EXPANDED_PANEL_VERTICAL_MARGIN * 2);
        const next = {
          top: rect.top + EXPANDED_PANEL_VERTICAL_MARGIN,
          left: rect.left + 12,
          height,
        };
        if (
          current?.top === next.top &&
          current.left === next.left &&
          current.height === next.height
        ) {
          return current;
        }
        return next;
      });
    };

    updateExpandedPanelFrame();

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateExpandedPanelFrame)
      : null;
    resizeObserver?.observe(container);
    window.addEventListener('resize', updateExpandedPanelFrame);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateExpandedPanelFrame);
    };
  }, [scrollContainerRef, showPanel]);

  if (messages.length === 0) return null;

  const handleTrailBlur = (event: React.FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      collapseTrail();
    }
  };

  return (
    <div
      role="navigation"
      aria-label="Message headers"
      data-message-trail
      className="relative z-30 w-8 shrink-0 self-start sticky top-0 h-full max-h-full bg-bg-primary"
    >
      <div
        ref={collapsedBarsRef}
        data-message-trail-collapsed
        className={`h-full max-h-full min-w-full overflow-hidden pl-2 py-2 flex items-center transition-opacity duration-150 ease-out ${barsAnimationClass} ${
          !isReductionReady
            ? 'pointer-events-none opacity-0'
            : isExpanded && !isCollapsing
              ? 'pointer-events-none opacity-100'
              : 'opacity-100'
        }`}
      >
        <div
          ref={collapsedHoverRef}
          className="min-w-full"
          onMouseEnter={expandTrail}
          onMouseLeave={isExpanded ? scheduleHoverRecheck : collapseTrail}
          onFocusCapture={expandTrail}
          onBlurCapture={handleTrailBlur}
        >
          <CollapsedTrail
            messages={messages}
            assistantEntries={assistantEntries}
            activeTargets={activeTrailState.targets}
            reduction={reduction}
            onScrollToMessage={onScrollToMessage}
          />
        </div>
      </div>

      {showPanel ? (
        <div
          className="pointer-events-none fixed z-30 flex w-[240px] items-center"
          style={{
            top: expandedPanelFrame?.top ?? 0,
            left: expandedPanelFrame?.left ?? 0,
            height: expandedPanelFrame?.height ?? '100%',
            maxHeight: expandedPanelFrame?.height ?? '100%',
          }}
        >
          <div
            ref={expandedPanelRef}
            className={`pointer-events-auto max-h-[inherit] overflow-hidden rounded border border-border-secondary bg-[var(--color-bg-secondary)] shadow-lg ${
              isCollapsing ? 'message-trail-panel-exit' : 'message-trail-panel-enter'
            }`}
            onMouseEnter={expandTrail}
            onMouseLeave={scheduleHoverRecheck}
            onFocusCapture={expandTrail}
            onBlurCapture={handleTrailBlur}
          >
            <ExpandedTrail
              trailEntries={trailEntries}
              reduction={reduction}
              primaryActiveTarget={activeTrailState.primaryTarget}
              onScrollToMessage={onScrollToMessage}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default MessageTrail;
