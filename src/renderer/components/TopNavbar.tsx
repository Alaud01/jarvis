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
  onMenuClick: () => void;
}

const TopNavbar: React.FC<TopNavbarProps> = ({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  onMenuClick,
}) => {
  return (
    <div className="h-10 bg-bg-navbar border-b border-border-primary flex items-end shrink-0 gap-1 [-webkit-app-region:drag]">
      <div className="w-[72px] h-8 shrink-0" />
      <button
        className="h-8 w-8 shrink-0 flex items-center justify-center cursor-pointer transition-all duration-[150ms] text-text-primary [-webkit-app-region:no-drag]"
        onClick={onMenuClick}
        title="Toggle sidebar"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`h-8 px-4 flex items-center gap-2 text-[0.7rem] font-mono cursor-pointer transition-all duration-[150ms] max-w-[200px] [-webkit-app-region:no-drag] ${
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