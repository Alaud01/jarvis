import React from 'react';

interface Tab {
  id: string;
  title: string;
}

interface TopNavbarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string, e: React.MouseEvent) => void;
}

const TopNavbar: React.FC<TopNavbarProps> = ({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
}) => {
  return (
    <div className="h-10 bg-bg-navbar border-b border-border-primary flex items-end px-2 shrink-0 gap-1 [-webkit-app-region:drag]">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`h-8 px-4 flex items-center gap-2 text-[0.7rem] font-mono cursor-pointer transition-all duration-[150ms] max-w-[200px] ${
            activeTabId === tab.id
              ? 'bg-bg-primary text-text-primary border border-border-primary border-b-bg-primary -mb-px'
              : 'text-text-secondary border border-transparent border-b-transparent hover:bg-bg-hover hover:text-text-primary'
          }`}
          onClick={() => onTabSelect(tab.id)}
        >
          <span className="truncate">{tab.title}</span>
          <div 
            className="opacity-50 cursor-pointer flex items-center justify-center hover:opacity-100"
            onClick={(e) => onTabClose(tab.id, e)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
};

export default TopNavbar;