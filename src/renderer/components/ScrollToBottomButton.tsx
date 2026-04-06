import React from 'react';

interface ScrollToBottomButtonProps {
  onClick: () => void;
}

const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ onClick }) => {
  return (
    <button
      onClick={onClick}
      className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-bg-secondary border border-border-primary shadow-lg hover:bg-bg-tertiary transition-colors flex items-center justify-center group"
      aria-label="Scroll to bottom"
    >
      <svg
        className="w-5 h-5 text-text-secondary group-hover:text-text-primary transition-colors"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 14l-7 7m0 0l-7-7m7 7V3"
        />
      </svg>
    </button>
  );
};

export default ScrollToBottomButton;