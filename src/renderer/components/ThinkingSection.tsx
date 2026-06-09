import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface ThinkingSectionProps {
  content: string;
  isStreaming?: boolean;
  streamingLabel?: string;
  finishedLabel?: string;
  contentClassName?: string;
  onAutoScrollCancel?: () => void;
  onAutoScrollReactivate?: () => void;
}

const AUTO_SCROLL_BOTTOM_THRESHOLD = 8;
const STREAMING_STICKY_BOTTOM_THRESHOLD = 50;

const isNearBottom = (
  container: HTMLElement,
  threshold = AUTO_SCROLL_BOTTOM_THRESHOLD
) => (
  container.scrollHeight - container.scrollTop - container.clientHeight < threshold
);

interface ScrollSnapshot {
  shouldMaintain: boolean;
}

const ThinkingSection: React.FC<ThinkingSectionProps> = ({
  content,
  isStreaming = false,
  streamingLabel = 'Thinking...',
  finishedLabel = 'Thought process',
  contentClassName = 'text-text-tertiary',
  onAutoScrollCancel,
  onAutoScrollReactivate,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    if (autoScrollEnabledRef.current === enabled) return;
    autoScrollEnabledRef.current = enabled;
    if (enabled) {
      onAutoScrollReactivate?.();
    } else {
      onAutoScrollCancel?.();
    }
  }, [onAutoScrollCancel, onAutoScrollReactivate]);

  useEffect(() => {
    if (!isStreaming && content) {
      setIsExpanded(false);
    }
  }, [isStreaming, content]);

  const maintainScrollAtEnd = useCallback((snapshot: ScrollSnapshot) => {
    if (!snapshot.shouldMaintain) {
      setAutoScrollEnabled(false);
      return;
    }

    const container = contentRef.current;
    if (!container) return;

    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    setAutoScrollEnabled(true);
  }, [setAutoScrollEnabled]);

  const scrollSnapshot: ScrollSnapshot = (() => {
    if (!isStreaming || !isExpanded || !autoScrollEnabledRef.current) {
      return { shouldMaintain: false };
    }
    const container = contentRef.current;
    return {
      shouldMaintain: container ? isNearBottom(container, STREAMING_STICKY_BOTTOM_THRESHOLD) : true,
    };
  })();

  useLayoutEffect(() => {
    if (!isStreaming || !isExpanded) return;
    maintainScrollAtEnd(scrollSnapshot);
  }, [content, isStreaming, isExpanded, scrollSnapshot, maintainScrollAtEnd]);

  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;

    setAutoScrollEnabled(isNearBottom(container));

    const handleScroll = () => {
      setAutoScrollEnabled(isNearBottom(container));
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isExpanded, setAutoScrollEnabled]);

  return (
    <div className="my-2 border bg-transparent border-border-secondary rounded bg-bg-secondary">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-2 py-2 flex items-center justify-between text-left hover:bg-bg-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="thinking-panel-toggle-label">
            {isStreaming ? streamingLabel : finishedLabel}
          </span>
        </div>
        <span className="thinking-panel-toggle-hint">
          {isExpanded ? 'Click to collapse' : 'Click to expand'}
        </span>
      </button>
      
      {isExpanded && (
        <div
          ref={contentRef}
          className={`px-4 pb-4 pt-2 border-t border-border-secondary thinking-scroll-container ${isStreaming ? 'max-h-[300px] overflow-y-auto' : ''}`}
        >
          <div className={contentClassName}>
            <MarkdownRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingSection;
