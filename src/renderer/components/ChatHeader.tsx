import React from 'react';

interface ChatHeaderProps {
  onMenuClick: () => void;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  onMenuClick,
}) => {
  return (
    <button
      className="absolute top-3 left-3 z-10 w-8 h-8 border border-transparent bg-transparent text-text-primary flex items-center justify-center cursor-pointer transition-all duration-[150ms] hover:border-border-primary"
      onClick={onMenuClick}
      title="Toggle index"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
};

export default ChatHeader;