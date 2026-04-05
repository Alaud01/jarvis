import React from 'react';

interface ChatHeaderProps {
  onMenuClick: () => void;
  title: string;
  models: string[];
  selectedModel: string | null;
  onModelSelect: (model: string) => void;
  isLoadingModels?: boolean;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  onMenuClick,
  title,
  models,
  selectedModel,
  onModelSelect,
  isLoadingModels = false,
}) => {
  return (
    <header className="h-[50px] px-6 flex items-center justify-between border-b border-border-primary shrink-0">
      <div className="flex items-center gap-4">
        <button 
          className="w-8 h-8 border border-transparent bg-transparent text-text-primary flex items-center justify-center cursor-pointer transition-all duration-[150ms] hover:border-border-primary" 
          onClick={onMenuClick} 
          title="Toggle index"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h1 className="font-mono text-base text-text-primary">{title}</h1>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative">
          <select
            value={selectedModel || ''}
            onChange={(e) => onModelSelect(e.target.value)}
            disabled={isLoadingModels || models.length === 0}
            className="appearance-none bg-transparent border border-border-secondary px-3 py-1 pr-8 font-mono text-[0.7rem] text-text-secondary uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:border-text-primary hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:border-text-primary"
          >
            {isLoadingModels && (
              <option value="" disabled>Loading...</option>
            )}
            {!isLoadingModels && models.length === 0 && (
              <option value="" disabled>No models</option>
            )}
            {!isLoadingModels && models.length > 0 && (
              <option value="" disabled>Select model</option>
            )}
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-tertiary">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        </div>
      </div>
    </header>
  );
};

export default ChatHeader;