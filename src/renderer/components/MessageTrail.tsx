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
const ROW_SPACING_VISIBLE = 'mb-0.5';
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
  activeTarget: ActiveTrailTarget | null;
  reduction: ReductionState;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

const MSG_ROW_VISIBLE_CLASS = 'min-h-2.5 max-h-8 opacity-100';
const MSG_ROW_HIDDEN_CLASS = 'min-h-0 max-h-0 opacity-0';
const HDR_ROW_VISIBLE_CLASS = 'min-h-1.5 max-h-6 opacity-100';
const HDR_ROW_HIDDEN_CLASS = 'min-h-0 max-h-0 opacity-0';

const CollapsedTrail: React.FC<CollapsedTrailProps> = ({ messages, assistantEntries, activeTarget, reduction, onScrollToMessage }) => {
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

  const offset = reduction.messageKeepRange?.start ?? 0;

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
          const activePreviewHeaderSourceIndex = entry && inRange
            ? getActiveDisplayHeaderSourceIndex(entry.headers, visibleHeaders, activeTarget, message.id)
            : null;
          const isMessageActive = inRange && activeTarget?.messageId === message.id
            && (activeTarget.headerIndex === undefined || activePreviewHeaderSourceIndex === null);

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
                  className={`w-5 h-[3px] bg-border-secondary rounded-[1px] transition-[width,background-color,box-shadow] duration-200 ease-in-out
                    group-hover/bar:w-6 group-hover/bar:bg-text-tertiary ${isMessageActive ? 'message-trail-bar-active' : ''}`}
                />
              </div>
              {entry?.previewHeaders.map((header, i) => {
                const sourceHeaderIndex = getSourceHeaderIndex(entry.headers, header);
                const visible = visibleFlags[i];
                const isHeaderActive = visible && inRange && activePreviewHeaderSourceIndex === sourceHeaderIndex;

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
                      className={`${HEADER_WIDTHS[header.level]} h-[2px] bg-border-secondary rounded-[1px] transition-[width,background-color,box-shadow] duration-200 ease-in-out
                        ${HEADER_HOVER_WIDTHS[header.level]} group-hover/bar:bg-text-tertiary ${isHeaderActive ? 'message-trail-bar-active' : ''}`}
                    />
                  </div>
                );
              })}
            </div>
          );
        }

        const isMessageActive = inRange && activeTarget?.messageId === message.id && activeTarget.headerIndex === undefined;

        return (
          <div
            key={message.id}
            className={`flex items-center justify-end cursor-pointer group ${ROW_TRANSITION} ${
              inRange ? `${MSG_ROW_VISIBLE_CLASS} ${ROW_SPACING_VISIBLE}` : `${MSG_ROW_HIDDEN_CLASS} ${ROW_SPACING_HIDDEN}`
            }`}
            onClick={() => inRange && onScrollToMessage(message.id)}
          >
            <div
              className={`w-3 h-[3px] bg-border-secondary transition-[width,background-color,box-shadow] duration-200 ease-in-out relative
                rounded-sm
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
  activeTarget: ActiveTrailTarget | null;
  onScrollToMessage: (messageId: string, headerIndex?: number) => void;
}

interface ExpandedPanelFrame {
  top: number;
  height: number;
}

const ExpandedTrail: React.FC<ExpandedTrailProps> = ({ trailEntries, activeTarget, onScrollToMessage }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoScrollRef = useRef(false);
  const visibleEntries = trailEntries.filter((entry) => (
    entry.sender === 'user' || entry.headers.length > 0 || entry.previewText.length > 0 || entry.isStreaming
  ));

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
    <div ref={scrollRef} className="max-h-[inherit] min-h-0 overflow-x-hidden overflow-y-auto bg-[var(--color-bg-secondary)] px-1.5 py-1.5">
      {visibleEntries.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          {visibleEntries.map((entry) => (
            <div
              key={entry.messageId}
              className={`flex min-w-0 flex-col gap-0.5 ${
                entry.sender === 'user'
                  ? 'rounded border border-border-secondary bg-bg-secondary px-1 py-0.5'
                  : ''
              }`}
            >
              {entry.sender === 'user' ? (
                <button
                  type="button"
                  data-trail-active={activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined ? 'true' : undefined}
                  className={`flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-bg-hover focus:bg-bg-hover focus:outline-none ${
                    activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-secondary'
                  }`}
                  onClick={() => onScrollToMessage(entry.messageId)}
                >
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[0.58rem] uppercase tracking-[0.14em] text-text-tertiary">
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
                    className="w-full min-w-0 overflow-hidden rounded-[4px] px-1.5 py-0.5 text-left font-mono text-[0.58rem] uppercase tracking-[0.14em] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus:bg-bg-hover focus:text-text-secondary focus:outline-none"
                    onClick={() => onScrollToMessage(entry.messageId)}
                  >
                    <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      Jarvis {entry.messageIndex + 1}{entry.isStreaming ? ' / Streaming' : ''}
                    </span>
                  </button>
                  {entry.headers.length > 0 ? (
                    entry.headers.map((header, headerIndex) => (
                      <button
                        key={`${entry.messageId}-${headerIndex}`}
                        type="button"
                        data-trail-active={activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === headerIndex ? 'true' : undefined}
                        className={`block w-full min-w-0 overflow-hidden rounded-[4px] px-1.5 py-1 text-left text-[0.7rem] leading-[1.2] transition-colors hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary focus:outline-none ${HEADER_INDENT[header.level]} ${
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
                  ) : (
                    <button
                      type="button"
                      data-trail-active={activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined ? 'true' : undefined}
                      className={`block w-full min-w-0 overflow-hidden rounded-[4px] px-1.5 py-1 text-left text-[0.7rem] leading-[1.2] transition-colors hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary focus:outline-none ${
                        activeTarget?.messageId === entry.messageId && activeTarget.headerIndex === undefined
                          ? 'bg-bg-hover text-text-primary'
                          : 'text-text-tertiary'
                      }`}
                      onClick={() => onScrollToMessage(entry.messageId)}
                    >
                      <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                        {entry.isStreaming ? 'Streaming...' : <InlineMarkdownPreview content={entry.previewText || 'Untitled message'} />}
                      </span>
                    </button>
                  )}
                </>
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
  const [expandedPanelFrame, setExpandedPanelFrame] = useState<ExpandedPanelFrame | null>(null);
  const collapseTimeoutRef = useRef<number | null>(null);
  const hoverRecheckTimeoutRef = useRef<number | null>(null);
  const collapseFinishedRef = useRef(false);
  const expandedPanelRef = useRef<HTMLDivElement>(null);
  const collapsedBarsRef = useRef<HTMLDivElement>(null);
  const collapsedHoverRef = useRef<HTMLDivElement>(null);
  const isExpandedRef = useRef(isExpanded);
  isExpandedRef.current = isExpanded;
  const trailEntries = useMemo<TrailEntry[]>(() => {
    return messages.map((message, messageIndex) => {
      const headers = message.sender === 'assistant' ? parseHeaders(message.text) : [];
      return {
        messageId: message.id,
        messageIndex,
        sender: message.sender,
        headers,
        previewHeaders: getPreviewHeaders(headers),
        // Full header list kept for the expanded panel and active-header logic.
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

  // Adaptive collapsed-trail reduction state. Computed synchronously after
  // render so there is no visible overflow flash; falls back gracefully when
  // content fits (FULL_REDUCTION = everything shown, current behavior).
  const [reduction, setReduction] = useState<ReductionState>(FULL_REDUCTION);
  const [containerHeight, setContainerHeight] = useState(0);
  const metricsRef = useRef({
    msgRowHeight: MSG_ROW_HEIGHT_FALLBACK,
    headerRowHeight: HEADER_ROW_HEIGHT_FALLBACK,
    rowGap: ROW_GAP_FALLBACK,
    padding: COLLAPSED_PADDING_FALLBACK,
    calibrated: false,
  });

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
    if (!activeTarget) return messages.length - 1;
    const idx = messages.findIndex((m) => m.id === activeTarget.messageId);
    return idx === -1 ? messages.length - 1 : idx;
  }, [activeTarget, messages]);

  // Calibrate row-height metrics from the real DOM once (after first render
  // with content), then (re)compute the reduction whenever the inputs change.
  // Runs synchronously (useLayoutEffect) so there's no visible overflow flash.
  useLayoutEffect(() => {
    const wrapper = collapsedBarsRef.current;
    if (!wrapper) return;

    // Calibrate from the rendered rows if not already done.
    if (!metricsRef.current.calibrated) {
      const msgRow = wrapper.querySelector<HTMLElement>('.min-h-2\\.5');
      const headerRow = wrapper.querySelector<HTMLElement>('.min-h-1\\.5');
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
      setReduction(FULL_REDUCTION);
      return;
    }

    const total = messages.length;
    if (total === 0) {
      setReduction(FULL_REDUCTION);
      return;
    }

    // Try steps 1..4 with all messages; pick the first that fits. Step 4 uses
    // the collapsed-row height (min-height 0) so trimmed header rows still
    // contribute ~0px in the height model.
    for (const step of [1, 2, 3, 4] as ReductionStep[]) {
      if (stepHeight(step, total) <= available) {
        setReduction({ step, maxHeaderLevel: MAX_HEADER_LEVEL_FOR_STEP[step], messageKeepRange: null });
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
    setReduction({ step: 5, maxHeaderLevel: 0, messageKeepRange: { start, end } });
  }, [messages, assistantEntries, activeMessageIndex, containerHeight, stepHeight]);

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
      let activeEntry: TrailEntry | null = null;
      let activeMessageElement: HTMLElement | null = null;
      let activeHeader: ActiveTrailTarget | null = null;

      for (const entry of trailEntries) {
        const messageElement = messageElements.get(entry.messageId);
        if (!messageElement) continue;

        const messageTop = messageElement.getBoundingClientRect().top;
        if (messageTop <= readingLine) {
          activeEntry = entry;
          activeMessageElement = messageElement;
        }
      }

      const activeMessage: ActiveTrailTarget | null = activeEntry ? { messageId: activeEntry.messageId } : null;
      if (activeEntry?.sender === 'assistant' && activeMessageElement) {
        const headerElements = Array.from(activeMessageElement.querySelectorAll<HTMLElement>('h1, h2, h3'));
        headerElements.forEach((headerElement, headerIndex) => {
          if (headerElement.getBoundingClientRect().top <= readingLine) {
            activeHeader = { messageId: activeEntry.messageId, headerIndex };
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
    const handleResize = () => {
      updateActiveTarget();
      const wrapper = collapsedBarsRef.current;
      if (wrapper) setContainerHeight(wrapper.clientHeight);
    };
    window.addEventListener('resize', handleResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      const wrapper = collapsedBarsRef.current;
      if (wrapper) setContainerHeight(wrapper.clientHeight);
    }) : null;
    if (ro && collapsedBarsRef.current) ro.observe(collapsedBarsRef.current);

    return () => {
      container.removeEventListener('scroll', updateActiveTarget);
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
          height,
        };
        if (
          current?.top === next.top &&
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
      className="relative z-[200] w-8 shrink-0 self-start sticky top-0 h-full max-h-full bg-bg-primary"
    >
      <div
        ref={collapsedBarsRef}
        className={`h-full max-h-full min-w-full overflow-hidden px-1 py-2 flex items-center ${barsAnimationClass} ${
          isExpanded && !isCollapsing ? 'pointer-events-none' : ''
        }`}
      >
        <div
          ref={collapsedHoverRef}
          className="min-w-full"
          onMouseEnter={expandTrail}
          onMouseLeave={!isExpanded ? collapseTrail : undefined}
          onFocusCapture={expandTrail}
          onBlurCapture={handleTrailBlur}
        >
          <CollapsedTrail
            messages={messages}
            assistantEntries={assistantEntries}
            activeTarget={activeTarget}
            reduction={reduction}
            onScrollToMessage={onScrollToMessage}
          />
        </div>
      </div>

      {showPanel ? (
        <div
          ref={expandedPanelRef}
          className="fixed right-3 z-[200] flex w-[240px] items-center"
          style={{
            top: expandedPanelFrame?.top ?? 0,
            height: expandedPanelFrame?.height ?? '100%',
            maxHeight: expandedPanelFrame?.height ?? '100%',
          }}
          onMouseEnter={expandTrail}
          onMouseLeave={scheduleHoverRecheck}
          onFocusCapture={expandTrail}
          onBlurCapture={handleTrailBlur}
        >
          <div
            className={`max-h-[inherit] overflow-hidden rounded-md border border-border-secondary bg-[var(--color-bg-secondary)] shadow-lg ${
              isCollapsing ? 'message-trail-panel-exit' : 'message-trail-panel-enter'
            }`}
          >
            <ExpandedTrail
              trailEntries={trailEntries}
              activeTarget={activeTarget}
              onScrollToMessage={onScrollToMessage}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default MessageTrail;
