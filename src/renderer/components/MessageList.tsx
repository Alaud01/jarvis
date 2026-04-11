import React, { useRef, useEffect, useLayoutEffect, useCallback, useImperativeHandle, forwardRef, useState } from 'react';
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
  editingMessageId?: string | null;
  onEditMessage?: (messageId: string) => void;
  onCancelEdit?: () => void;
  onResubmitMessage?: (messageId: string, newText: string) => void;
  onRegenerateResponse?: (messageId: string) => void;
}

export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
  scrollToBottom: () => void;
  isAutoScrollEnabled: () => boolean;
  enableAutoScroll: () => void;
}

export interface MessageSegment {
  type: 'thinking' | 'content';
  text?: string;
  isThinkingInProgress?: boolean;
}

const parseMessageSegments = (text: string, isStreaming?: boolean): MessageSegment[] => {
  const segments: MessageSegment[] = [];
  
  const xmlThinkingRegex = /(?:<thinking>|思考)([\s\S]*?)(?:<\/thinking>|<\/思考>)/g;
  const ollamaCompleteThinkingRegex = /Thinking\.\.\.\n([\s\S]*?)\n\.\.\.done thinking\./g;
  const ollamaStreamingStartRegex = /Thinking\.\.\.\n([\s\S]*)$/;
  
  const processText = (inputText: string) => {
    let remaining = inputText;
    
    while (remaining.length > 0) {
      const xmlMatches = [...remaining.matchAll(xmlThinkingRegex)];
      const ollamaMatches = [...remaining.matchAll(ollamaCompleteThinkingRegex)];
      
      let nextXmlIndex = xmlMatches.length > 0 ? xmlMatches[0].index! : Infinity;
      let nextOllamaIndex = ollamaMatches.length > 0 ? ollamaMatches[0].index! : Infinity;
      
      const nextIndex = Math.min(nextXmlIndex, nextOllamaIndex);
      
      if (isStreaming && nextIndex === Infinity) {
        const streamingMatch = remaining.match(ollamaStreamingStartRegex);
        if (streamingMatch) {
          const beforeStreaming = remaining.slice(0, remaining.indexOf(streamingMatch[0]));
          if (beforeStreaming.trim()) {
            segments.push({ type: 'content', text: beforeStreaming.trim() });
          }
          segments.push({ type: 'thinking', text: streamingMatch[1].trim(), isThinkingInProgress: true });
          return;
        }
      }
      
      if (nextIndex === Infinity) {
        if (remaining.trim()) {
          segments.push({ type: 'content', text: remaining.trim() });
        }
        return;
      }
      
      if (nextIndex > 0) {
        const beforeContent = remaining.slice(0, nextIndex);
        if (beforeContent.trim()) {
          segments.push({ type: 'content', text: beforeContent.trim() });
        }
      }
      
      if (nextIndex === nextXmlIndex) {
        const match = xmlMatches.find(m => m.index === nextIndex)!;
        segments.push({ type: 'thinking', text: match[1].trim(), isThinkingInProgress: false });
        remaining = remaining.slice(nextIndex + match[0].length);
      } else if (nextIndex === nextOllamaIndex) {
        const match = ollamaMatches.find(m => m.index === nextIndex)!;
        segments.push({ type: 'thinking', text: match[1].trim(), isThinkingInProgress: false });
        remaining = remaining.slice(nextIndex + match[0].length);
      }
    }
  };
  
  processText(text);
  
  if (segments.length === 0) {
    return [{ type: 'content', text: text.trim() }];
  }
  
  return segments;
};

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

const PencilIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"></polyline>
    <polyline points="1 20 1 14 7 14"></polyline>
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"></polyline>
  </svg>
);

const XIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"></line>
    <line x1="6" y1="6" x2="18" y2="18"></line>
  </svg>
);

interface MessageActionButtonProps {
  onClick: () => void;
  label: string;
  icon?: React.ReactNode;
  variant?: 'default' | 'primary';
}

const MessageActionButton: React.FC<MessageActionButtonProps> = ({ onClick, label, icon, variant = 'default' }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 font-mono text-[0.65rem] uppercase tracking-wider transition-all duration-150 ${
      variant === 'primary'
        ? 'border border-text-primary bg-text-primary text-bg-primary hover:bg-transparent hover:text-text-primary'
        : 'border border-border-secondary text-text-secondary hover:border-text-primary hover:text-text-primary'
    }`}
  >
    {icon}
    {label}
  </button>
);

const MessageList = forwardRef<MessageListHandle, MessageListProps>(({ 
  messages, 
  isLoading = false,
  editingMessageId,
  onEditMessage,
  onCancelEdit,
  onResubmitMessage,
  onRegenerateResponse,
}, ref) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const autoScrollEnabledRef = useRef(true);
  const isStreamingRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const messagesColumnRef = useRef<HTMLDivElement>(null);
  const programmaticScrollClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTopRef = useRef(0);

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');

  const handleCopy = useCallback((messageId: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(messageId);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleStartEdit = useCallback((messageId: string, text: string) => {
    setEditText(text);
    onEditMessage?.(messageId);
  }, [onEditMessage]);

  const handleCancelEdit = useCallback(() => {
    setEditText('');
    onCancelEdit?.();
  }, [onCancelEdit]);

  const handleResubmit = useCallback((messageId: string) => {
    onResubmitMessage?.(messageId, editText);
  }, [onResubmitMessage, editText]);

  const handleRegenerate = useCallback((messageId: string) => {
    onRegenerateResponse?.(messageId);
  }, [onRegenerateResponse]);

  const showTypingIndicator = isLoading && !hasStreamingMessage && messages.length > 0 && messages[messages.length - 1].sender === 'user';

  const showEmptyPlaceholder = messages.length === 0 && !isLoading;

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto message-scroll-container">
      {showEmptyPlaceholder ? (
        <div className="py-8">
          <div className="max-w-[800px] mx-auto px-6">
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <p className="font-playfair text-[2.5rem] text-text-primary mb-4">
                A <span className="italic">Blank</span> Page
              </p>
              <p className="font-mono text-[0.7rem] text-text-tertiary uppercase tracking-[2px]">
                Begin your discourse
              </p>
            </div>
          </div>
        </div>
      ) : (
      <div className="py-8 pl-9">
        <div ref={messagesColumnRef} className="max-w-[800px] mx-auto">
          {messages.map((message) => {
            const segments = parseMessageSegments(message.text, message.isStreaming);
            const isEditing = editingMessageId === message.id;
            
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
                
                {isEditing ? (
                  <div className="flex flex-col gap-3">
                    <textarea
                      className="w-full min-h-[60px] border border-text-primary bg-transparent p-3 text-base text-text-primary leading-relaxed resize-none outline-none focus:border-text-primary"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          handleResubmit(message.id);
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          handleCancelEdit();
                        }
                      }}
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                      <span className="font-mono text-[0.65rem] text-text-tertiary mr-auto">
                        ⌘ + Enter to submit · Esc to cancel
                      </span>
                      <MessageActionButton
                        onClick={() => handleCopy(message.id, editText)}
                        label={copiedId === message.id ? 'Copied' : 'Copy'}
                        icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                      />
                      <MessageActionButton
                        onClick={handleCancelEdit}
                        label="Cancel"
                        icon={<XIcon />}
                      />
                      <MessageActionButton
                        onClick={() => handleResubmit(message.id)}
                        label="Submit"
                        icon={<CheckIcon />}
                        variant="primary"
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    {segments.map((segment, index) => {
                      if (segment.type === 'thinking' && segment.text) {
                        return (
                          <ThinkingSection 
                            key={`thinking-${index}`}
                            content={segment.text} 
                            isStreaming={segment.isThinkingInProgress} 
                          />
                        );
                      }
                      if (segment.type === 'content' && segment.text) {
                        return (
                          <div key={`content-${index}`} className="text-base text-text-primary leading-[1.8]">
                            <MarkdownRenderer content={segment.text} />
                          </div>
                        );
                      }
                      return null;
                    })}
                      
                      {!message.isStreaming && !isLoading && (
                        <div className="flex items-center justify-end gap-2 mt-2">
                          {message.sender === 'user' ? (
                            <>
                              <MessageActionButton
                                onClick={() => handleCopy(message.id, message.text)}
                                label={copiedId === message.id ? 'Copied' : 'Copy'}
                                icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                              />
                              <MessageActionButton
                                onClick={() => handleStartEdit(message.id, message.text)}
                                label="Edit"
                                icon={<PencilIcon />}
                              />
                            </>
                          ) : (
                            <>
                              <MessageActionButton
                                onClick={() => handleCopy(message.id, message.text)}
                                label={copiedId === message.id ? 'Copied' : 'Copy'}
                                icon={copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                              />
                              <MessageActionButton
                                onClick={() => handleRegenerate(message.id)}
                                label="Regenerate"
                                icon={<RefreshIcon />}
                              />
                            </>
                          )}
                        </div>
                      )}
                  </>
                )}
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