import React from 'react';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface MessageTrailProps {
  messages: Message[];
  onScrollToMessage: (messageId: string) => void;
}

const MessageTrail: React.FC<MessageTrailProps> = ({ messages, onScrollToMessage }) => {
  const getPreview = (text: string, maxLength: number = 50): string => {
    const cleanText = text.replace(/<[^>]*>/g, '').replace(/\n/g, ' ').trim();
    if (cleanText.length <= maxLength) return cleanText;
    return cleanText.substring(0, maxLength) + '...';
  };

  if (messages.length === 0) return null;

  return (
    <div className="w-8 shrink-0 px-1 py-2 flex flex-col gap-0.5 sticky top-0 h-fit max-h-[calc(100vh-140px)] overflow-y-auto">
      {messages.map((message) => (
        <div
          key={message.id}
          className="flex-1 flex items-center justify-end min-h-4 cursor-pointer group"
          onClick={() => onScrollToMessage(message.id)}
        >
          <div className={`w-3 h-[3px] bg-border-secondary transition-all duration-200 ease-in-out relative
            ${message.sender === 'user' ? 'rounded-sm' : 'rounded-[1px]'}
            group-hover:w-4 group-hover:bg-text-tertiary`}
          >
            <div className="fixed right-14 bg-bg-secondary border border-border-secondary rounded-md px-3 py-2 
              min-w-[200px] max-w-[280px] opacity-0 invisible transition-[opacity,visibility] duration-150 ease-in-out
              shadow-lg z-[100] pointer-events-none
              group-hover:opacity-100 group-hover:visible">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-serif text-[0.9rem] font-medium text-text-primary">
                  {message.sender === 'user' ? 'Author' : 'Editor'}
                </span>
              </div>
              <div className="text-xs text-text-tertiary leading-[1.4] overflow-hidden text-ellipsis 
                line-clamp-2">
                {message.isStreaming ? 'Streaming...' : getPreview(message.text)}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default MessageTrail;