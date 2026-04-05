import React, { useState, useRef, useEffect } from 'react';

interface InputAreaProps {
  onSendMessage: (text: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({ onSendMessage, isLoading = false, disabled = false }) => {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="p-6 border-t border-border-primary bg-bg-primary shrink-0">
      <div className="max-w-[800px] mx-auto">
        <div className="bg-transparent border border-border-primary p-3 transition-all duration-[150ms] focus-within:border-text-primary">
          <textarea
            ref={textareaRef}
            className="w-full min-h-6 max-h-[200px] border-none outline-none resize-none bg-transparent text-text-primary font-sans text-base leading-[1.8] placeholder:text-text-tertiary placeholder:italic placeholder:font-serif"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Compose your thought..."
            rows={1}
            disabled={isLoading || disabled}
          />
          <div className="flex items-center justify-between mt-3">
            <span className="font-mono text-[0.65rem] text-text-tertiary uppercase tracking-widest">
              Return to send · Shift+Return for line
            </span>
            <button
              className="py-1 px-4 border border-text-primary bg-text-primary text-bg-primary font-mono text-[0.7rem] uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:not-disabled:bg-transparent hover:not-disabled:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
              onClick={handleSend}
              disabled={!input.trim() || isLoading || disabled}
            >
              {isLoading ? 'Wait' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InputArea;