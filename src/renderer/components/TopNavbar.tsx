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
    <div className="h-[37px] bg-bg-navbar border-b border-border-primary flex items-stretch shrink-0 gap-1 [-webkit-app-region:drag]">
      <div className="w-[72px] shrink-0" />
      <button
        className="self-center h-8 w-8 shrink-0 flex items-center justify-center cursor-pointer transition-all duration-[150ms] text-text-primary [-webkit-app-region:no-drag]"
        onClick={onMenuClick}
        title="Toggle sidebar (Cmd+B)"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="9" y1="4" x2="9" y2="20" />
        </svg>
      </button>
      <div className="flex flex-1 min-w-0 items-end gap-1">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`h-8 px-3 flex grow shrink basis-[160px] min-w-0 max-w-[200px] items-center gap-2 overflow-hidden font-readable text-[0.7rem] cursor-pointer transition-all duration-[150ms] [-webkit-app-region:no-drag] ${
              activeTabId === tab.id
                ? 'bg-bg-primary text-text-primary border border-border-primary border-b-bg-primary -mb-px'
                : 'text-text-secondary border border-transparent border-b-transparent hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => onTabSelect(tab.id)}
          >
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
            <div 
              className="shrink-0 opacity-50 cursor-pointer flex items-center justify-center hover:opacity-100"
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
    </div>
  );
};

export default TopNavbar;
