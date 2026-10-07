import React, { useState, useEffect, useRef } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import { useAutoScroll } from '../hooks/useAutoScroll';

interface ThinkingSectionProps {
  content: string;
  isStreaming?: boolean;
  streamingLabel?: string;
  finishedLabel?: string;
  contentClassName?: string;
  onAutoScrollCancel?: () => void;
  onAutoScrollReactivate?: () => void;
}

// Small viewport (max 300px while streaming): ~1-2 lines of slack keeps the
// follow through per-chunk height jitter without grabbing back real scroll-ups.
const THINKING_STICKY_THRESHOLD = 24;

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

  useAutoScroll(contentRef, {
    active: isStreaming && isExpanded,
    threshold: THINKING_STICKY_THRESHOLD,
    onFollowingChange: (following) => {
      if (following) {
        onAutoScrollReactivate?.();
      } else {
        onAutoScrollCancel?.();
      }
    },
  });

  useEffect(() => {
    if (!isStreaming && content) {
      setIsExpanded(false);
    }
  }, [isStreaming, content]);

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
