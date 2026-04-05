import React, { useRef, useEffect, useState } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import ThinkingSection from './ThinkingSection';
import TypingIndicator from './TypingIndicator';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface MessageListProps {
  messages: Message[];
  isLoading?: boolean;
}

const parseThinkingTokens = (text: string): { thinking: string | null; content: string } => {
  const thinkingMatch = text.match(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/);
  
  if (thinkingMatch) {
    const thinking = thinkingMatch[1].trim();
    const content = text.replace(thinkingMatch[0], '').trim();
    return { thinking, content };
  }
  
  return { thinking: null, content: text };
};

const MessageList: React.FC<MessageListProps> = ({ messages, isLoading = false }) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const userScrolledUpRef = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom();
    }
  }, [messages, shouldAutoScroll]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 50;
    
    setIsAtBottom(isBottom);
    
    if (isBottom) {
      userScrolledUpRef.current = false;
      setShouldAutoScroll(true);
    } else if (!userScrolledUpRef.current) {
      const hasStreamingMessage = messages.some(m => m.isStreaming);
      if (hasStreamingMessage) {
        userScrolledUpRef.current = true;
        setShouldAutoScroll(false);
      }
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [messages]);

  useEffect(() => {
    const hasStreamingMessage = messages.some(m => m.isStreaming);
    if (!hasStreamingMessage) {
      setShouldAutoScroll(true);
      userScrolledUpRef.current = false;
    }
  }, [messages]);

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const hasStreamingMessage = messages.some(m => m.isStreaming);
  const showTypingIndicator = isLoading && !hasStreamingMessage && messages.length > 0 && messages[messages.length - 1].sender === 'user';

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 overflow-y-auto py-8">
        <div className="max-w-[800px] mx-auto px-6">
          <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
            <h2 className="font-serif text-[2.5rem] italic text-text-primary mb-4">
              A Blank Page
            </h2>
            <p className="font-mono text-[0.7rem] text-text-tertiary uppercase tracking-[2px]">
              Begin your discourse
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto py-8">
      <div className="max-w-[800px] mx-auto px-6">
        {messages.map((message) => {
          const { thinking, content } = parseThinkingTokens(message.text);
          
          return (
            <div key={message.id} className="py-8 border-b border-border-primary flex flex-col gap-2 last:border-b-0">
              <div className="flex items-baseline gap-3 mb-2">
                <span className="font-serif text-[1.15rem] text-text-primary">
                  {message.sender === 'user' ? 'Author' : 'Editor'}
                </span>
                <span className="font-mono text-[0.65rem] text-text-tertiary">
                  {formatTime(message.timestamp)}
                </span>
                {message.isStreaming && (
                  <span className="font-mono text-[0.65rem] text-text-muted animate-pulse">
                    streaming...
                  </span>
                )}
              </div>
              
              {thinking && <ThinkingSection content={thinking} />}
              
              <div className="text-base text-text-primary leading-[1.8]">
                <MarkdownRenderer content={content} />
              </div>
            </div>
          );
        })}
        
        {showTypingIndicator && (
          <TypingIndicator sender="assistant" />
        )}
        
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};

export default MessageList;