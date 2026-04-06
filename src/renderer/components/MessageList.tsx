import React, { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
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

export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
  scrollToBottom: () => void;
  isAutoScrollEnabled: () => boolean;
  enableAutoScroll: () => void;
}

const parseThinkingTokens = (text: string, isStreaming?: boolean): { thinking: string | null; content: string; isThinkingInProgress: boolean } => {
  const xmlThinkingMatch = text.match(/(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/);

  if (xmlThinkingMatch) {
    const thinking = xmlThinkingMatch[1].trim();
    const content = text.replace(xmlThinkingMatch[0], '').trim();
    return { thinking, content, isThinkingInProgress: false };
  }

  const ollamaStartPattern = /^Thinking\.\.\.\n/;
  const ollamaEndPattern = /\n\.\.\.done thinking\./;

  if (ollamaStartPattern.test(text)) {
    const endMatch = text.match(ollamaEndPattern);

    if (endMatch) {
      const afterStart = text.replace(ollamaStartPattern, '');
      const endIndex = afterStart.indexOf(endMatch[0]);
      const thinking = afterStart.slice(0, endIndex).trim();
      const content = afterStart.slice(endIndex + endMatch[0].length).trim();
      return { thinking, content, isThinkingInProgress: false };
    }

    if (isStreaming) {
      const thinking = text.replace(ollamaStartPattern, '').trim();
      return { thinking, content: '', isThinkingInProgress: true };
    }
  }

  return { thinking: null, content: text, isThinkingInProgress: false };
};

const MessageList = forwardRef<MessageListHandle, MessageListProps>(({ messages, isLoading = false }, ref) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const autoScrollEnabledRef = useRef(true);
  const isStreamingRef = useRef(false);
  /** True while a programmatic scrollTo is applying; prevents scroll handler from re-enabling auto-scroll. */
  const programmaticScrollRef = useRef(false);
  const messagesColumnRef = useRef<HTMLDivElement>(null);
  const programmaticScrollClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);

  /** True while the user is physically interacting (wheel / touch); distinguishes user scrolls from layout-triggered scroll events. */
  const userInteractingRef = useRef(false);
  const userInteractingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markUserInteracting = () => {
    userInteractingRef.current = true;
    if (userInteractingTimerRef.current) clearTimeout(userInteractingTimerRef.current);
    userInteractingTimerRef.current = setTimeout(() => {
      userInteractingRef.current = false;
    }, 150);
  };

  const clearProgrammaticScrollTimer = () => {
    if (programmaticScrollClearTimerRef.current !== null) {
      clearTimeout(programmaticScrollClearTimerRef.current);
      programmaticScrollClearTimerRef.current = null;
    }
  };

  const endProgrammaticScrollAfterSmooth = () => {
    clearProgrammaticScrollTimer();
    programmaticScrollClearTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollClearTimerRef.current = null;
    }, 450);
  };

  const flushScrollToBottom = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    programmaticScrollRef.current = true;
    container.scrollTop = container.scrollHeight;
    lastScrollTopRef.current = container.scrollTop;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      const messageElement = messageRefsRef.current.get(messageId);
      const container = scrollContainerRef.current;
      if (messageElement && container) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = messageElement.getBoundingClientRect();
        const currentScrollTop = container.scrollTop;
        const targetScrollTop = currentScrollTop + elementRect.top - containerRect.top - 16;
        programmaticScrollRef.current = true;
        container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
        lastScrollTopRef.current = container.scrollTop;
        endProgrammaticScrollAfterSmooth();
      }
    },
    scrollToBottom: () => {
      autoScrollEnabledRef.current = true;
      const container = scrollContainerRef.current;
      if (container) {
        programmaticScrollRef.current = true;
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth'
        });
        lastScrollTopRef.current = container.scrollTop;
        endProgrammaticScrollAfterSmooth();
      }
    },
    isAutoScrollEnabled: () => autoScrollEnabledRef.current,
    enableAutoScroll: () => {
      autoScrollEnabledRef.current = true;
    }
  }));

  useEffect(() => {
    isStreamingRef.current = messages.some(m => m.isStreaming);
  }, [messages]);

  const streamingActive = messages.some(m => m.isStreaming);

  useLayoutEffect(() => {
    if (!streamingActive) return;
    flushScrollToBottom();
  }, [messages, streamingActive, flushScrollToBottom]);

  useEffect(() => {
    if (!streamingActive) return;
    const el = messagesColumnRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      flushScrollToBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [streamingActive, flushScrollToBottom]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    lastScrollTopRef.current = container.scrollTop;

    const handleWheel = (e: WheelEvent) => {
      markUserInteracting();
      if (!isStreamingRef.current) return;
      if (e.deltaY < 0) {
        autoScrollEnabledRef.current = false;
        console.log('[MessageList] user scroll up', { source: 'wheel', autoScroll: autoScrollEnabledRef.current });
      }
    };

    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      markUserInteracting();
      if (!isStreamingRef.current) return;
      const y = e.touches[0].clientY;
      if (y > touchStartY + 8) {
        autoScrollEnabledRef.current = false;
        console.log('[MessageList] user scroll up', { source: 'touch', autoScroll: autoScrollEnabledRef.current });
      }
      touchStartY = y;
    };

    const handleScroll = () => {
      if (programmaticScrollRef.current) {
        lastScrollTopRef.current = container.scrollTop;
        return;
      }
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollTop < lastScrollTopRef.current - 1) {
        autoScrollEnabledRef.current = false;
        console.log('[MessageList] user scroll up', { source: 'scroll', autoScroll: autoScrollEnabledRef.current });
      }
      lastScrollTopRef.current = scrollTop;
      if (userInteractingRef.current) {
        const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
        if (isAtBottom && isStreamingRef.current) {
          autoScrollEnabledRef.current = true;
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: true, capture: true });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('wheel', handleWheel, true);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    return () => {
      clearProgrammaticScrollTimer();
      if (userInteractingTimerRef.current) clearTimeout(userInteractingTimerRef.current);
    };
  }, []);

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const hasStreamingMessage = messages.some(m => m.isStreaming);
  const showTypingIndicator = isLoading && !hasStreamingMessage && messages.length > 0 && messages[messages.length - 1].sender === 'user';

  const showEmptyPlaceholder = messages.length === 0 && !isLoading;

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto message-scroll-container">
      {showEmptyPlaceholder ? (
        <div className="py-8">
          <div className="max-w-[800px] mx-auto px-6">
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <p className="font-serif text-[2.5rem] italic text-text-primary mb-4">
                A <span className="bg-red-500 px-1.5">Blank</span> Page
              </p>
              <p className="font-mono text-[0.7rem] text-text-tertiary uppercase tracking-[2px]">
                Begin your discourse
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="py-8 pr-8 pl-6">
        <div ref={messagesColumnRef} className="max-w-[800px] mx-auto">
          {messages.map((message) => {
            const { thinking, content, isThinkingInProgress } = parseThinkingTokens(message.text, message.isStreaming);
            
            return (
              <div 
                key={message.id} 
                ref={(el) => {
                  if (el) {
                    messageRefsRef.current.set(message.id, el);
                  } else {
                    messageRefsRef.current.delete(message.id);
                  }
                }}
                className="py-4 border-b border-border-primary flex flex-col gap-2 last:border-b-0"
              >
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
                
                {thinking && (
                  <ThinkingSection 
                    content={thinking} 
                    isStreaming={isThinkingInProgress} 
                  />
                )}
                
                <div className="text-base text-text-primary leading-[1.8]">
                  <MarkdownRenderer content={content} />
                </div>
              </div>
            );
          })}
          
          {showTypingIndicator && (
            <TypingIndicator sender="assistant" />
          )}
        </div>
      </div>
      )}
    </div>
  );
});

export default MessageList;