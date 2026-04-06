import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface ThinkingSectionProps {
  content: string;
  isStreaming?: boolean;
}

const ThinkingSection: React.FC<ThinkingSectionProps> = ({ content, isStreaming = false }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (!isStreaming && content) {
      setIsExpanded(false);
    }
  }, [isStreaming, content]);

  /** Same pattern as MessageList flushScrollToBottom: follow the bottom while streaming after layout; instant scrollTop, no RAF backlog. */
  const flushScrollToBottom = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    const container = contentRef.current;
    if (!container) return;
    programmaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useLayoutEffect(() => {
    if (!isStreaming || !isExpanded) return;
    flushScrollToBottom();
  }, [content, isStreaming, isExpanded, flushScrollToBottom]);

  useEffect(() => {
    if (!isStreaming || !isExpanded) return;
    const el = contentRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      flushScrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isStreaming, isExpanded, flushScrollToBottom]);

  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;

    lastScrollTopRef.current = container.scrollTop;

    const handleWheel = (e: WheelEvent) => {
      if (!isStreamingRef.current) return;
      if (e.deltaY < 0) {
        autoScrollEnabledRef.current = false;
      }
    };

    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isStreamingRef.current) return;
      const y = e.touches[0].clientY;
      if (y > touchStartY + 8) {
        autoScrollEnabledRef.current = false;
      }
      touchStartY = y;
    };

    const handleScroll = () => {
      if (programmaticScrollRef.current) {
        lastScrollTopRef.current = container.scrollTop;
        return;
      }
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollTop < lastScrollTopRef.current - 1) {
        autoScrollEnabledRef.current = false;
      }
      lastScrollTopRef.current = scrollTop;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      if (isAtBottom && isStreamingRef.current) {
        autoScrollEnabledRef.current = true;
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: true, capture: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('wheel', handleWheel, true);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isStreaming, isExpanded]);

  return (
    <div className="my-4 border border-border-secondary rounded bg-bg-secondary">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-bg-hover transition-colors"
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
          <span className="font-mono text-[0.7rem] uppercase tracking-widest text-text-tertiary">
            {isStreaming ? 'Thinking...' : 'Thought process'}
          </span>
        </div>
        <span className="font-mono text-[0.65rem] text-text-muted">
          {isExpanded ? 'Click to collapse' : 'Click to expand'}
        </span>
      </button>
      
      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border-secondary">
          <div 
            ref={contentRef}
            className={`italic text-text-tertiary overflow-y-auto thinking-scroll-container ${isStreaming ? 'max-h-[300px]' : ''}`}
          >
            <MarkdownRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingSection;
