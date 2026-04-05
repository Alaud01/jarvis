import React from 'react';

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  currentConversationId: string | null;
  onConversationSelect: (id: string) => void;
  onNewChat: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  conversations,
  currentConversationId,
  onConversationSelect,
  onNewChat,
}) => {
  return (
    <aside className={`h-full bg-bg-sidebar border-r border-border-primary flex flex-col shrink-0 transition-[width] duration-[200ms] overflow-hidden ${isOpen ? 'w-60' : 'w-0 border-r-0'}`}>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        <button 
          className="w-full py-2 mb-6 mt-4 bg-transparent border border-border-primary text-text-primary font-sans text-[0.7rem] uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:bg-text-primary hover:text-bg-primary"
          onClick={onNewChat}
        >
          Draft New
        </button>

        <div className="font-mono text-[0.65rem] text-text-tertiary uppercase tracking-[1.5px] mb-2 mt-4">
          Archive
        </div>
        
        <div className="flex flex-col gap-0.5">
          {conversations.length === 0 ? (
            <div className="py-2 text-text-tertiary text-sm italic">
              Empty
            </div>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`py-2 cursor-pointer text-text-secondary text-[0.85rem] flex items-center gap-2 transition-colors duration-[150ms] border-b border-transparent hover:text-text-primary hover:border-b-border-secondary ${
                  currentConversationId === conversation.id ? 'text-text-primary font-medium' : ''
                }`}
                onClick={() => onConversationSelect(conversation.id)}
              >
                <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{conversation.title}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="px-4 py-4 border-t border-border-primary shrink-0 flex items-center gap-3 font-mono text-[0.7rem]">
        <span>AUTHOR</span>
        <span className="ml-auto text-text-tertiary">v1.0</span>
      </div>
    </aside>
  );
};

export default Sidebar;