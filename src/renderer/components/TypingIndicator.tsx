import React from 'react';

interface TypingIndicatorProps {
  sender?: 'user' | 'assistant';
}

const TypingIndicator: React.FC<TypingIndicatorProps> = ({ sender = 'assistant' }) => {
  return (
    <div className="py-8 border-b border-border-primary">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="font-serif text-[1.15rem] text-text-primary">
          {sender === 'user' ? 'Author' : 'Editor'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          <div 
            className="w-2 h-2 rounded-full bg-text-tertiary"
            style={{
              animation: 'bounce 1.4s infinite ease-in-out both',
              animationDelay: '0s'
            }}
          />
          <div 
            className="w-2 h-2 rounded-full bg-text-tertiary"
            style={{
              animation: 'bounce 1.4s infinite ease-in-out both',
              animationDelay: '0.16s'
            }}
          />
          <div 
            className="w-2 h-2 rounded-full bg-text-tertiary"
            style={{
              animation: 'bounce 1.4s infinite ease-in-out both',
              animationDelay: '0.32s'
            }}
          />
        </div>
        <span className="font-mono text-[0.65rem] text-text-tertiary uppercase tracking-widest">
          Thinking
        </span>
      </div>
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% {
            transform: scale(0);
          }
          40% {
            transform: scale(1);
          }
        }
      `}</style>
    </div>
  );
};

export default TypingIndicator;