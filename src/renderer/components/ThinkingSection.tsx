import React, { useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';

interface ThinkingSectionProps {
  content: string;
}

const ThinkingSection: React.FC<ThinkingSectionProps> = ({ content }) => {
  const [isExpanded, setIsExpanded] = useState(true);

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
            Thinking...
          </span>
        </div>
        <span className="font-mono text-[0.65rem] text-text-muted">
          {isExpanded ? 'Click to collapse' : 'Click to expand'}
        </span>
      </button>
      
      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border-secondary">
          <div className="italic text-text-tertiary">
            <MarkdownRenderer content={content} />
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingSection;