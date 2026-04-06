import React, { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList, { MessageListHandle } from './components/MessageList';
import InputArea from './components/InputArea';
import TopNavbar from './components/TopNavbar';
import CopyNotification from './components/CopyNotification';
import MessageTrail from './components/MessageTrail';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ThemeProvider } from './context/ThemeContext';

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<string[]>;
      sendMessage: (model: string, messages: { role: string; content: string }[]) => Promise<string>;
      sendMessageStream: (model: string, messages: { role: string; content: string }[]) => Promise<{ success: boolean }>;
      stopStream: () => Promise<{ success: boolean }>;
      onChunk: (callback: (chunk: string) => void) => () => void;
      onDone: (callback: () => void) => () => void;
      onError: (callback: (error: string) => void) => () => void;
    };
  }
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  messages: Message[];
}

const generateId = (): string => {
  return crypto.randomUUID();
};

const App: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  
  const streamingMessageIdRef = useRef<string | null>(null);
  const cleanupFunctionsRef = useRef<(() => void)[]>([]);
  const messageListRef = useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        const fetchedModels = await window.assistant.getModels();
        setModels(fetchedModels);
        if (fetchedModels.length > 0 && !selectedModel) {
          setSelectedModel(fetchedModels[0]);
        }
      } catch (error) {
        console.error('Failed to load models:', error);
        setModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    loadModels();
  }, []);

  useEffect(() => {
    const handleChunk = (chunk: string) => {
      if (streamingMessageIdRef.current) {
        setConversations(prev =>
          prev.map(c => ({
            ...c,
            messages: c.messages.map(m =>
              m.id === streamingMessageIdRef.current
                ? { ...m, text: m.text + chunk }
                : m
            ),
          }))
        );
      }
    };

    const handleDone = () => {
      setConversations(prev =>
        prev.map(c => ({
          ...c,
          messages: c.messages.map(m =>
            m.isStreaming
              ? { ...m, isStreaming: false }
              : m
          ),
        }))
      );
      streamingMessageIdRef.current = null;
      setIsLoading(false);
    };

    const handleError = (error: string) => {
      console.error('Streaming error:', error);
      if (streamingMessageIdRef.current) {
        setConversations(prev =>
          prev.map(c => ({
            ...c,
            messages: c.messages.map(m =>
              m.id === streamingMessageIdRef.current
                ? {
                    ...m,
                    text: `Error: ${error}. Make sure Ollama is running.`,
                    isStreaming: false,
                  }
                : m
            ),
          }))
        );
        streamingMessageIdRef.current = null;
        setIsLoading(false);
      }
    };

    const chunkCleanup = window.assistant.onChunk(handleChunk);
    const doneCleanup = window.assistant.onDone(handleDone);
    const errorCleanup = window.assistant.onError(handleError);

    cleanupFunctionsRef.current = [chunkCleanup, doneCleanup, errorCleanup];

    return () => {
      cleanupFunctionsRef.current.forEach(cleanup => cleanup());
    };
  }, []);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const messages = currentConversation?.messages || [];

  useEffect(() => {
    const checkScrollButton = () => {
      const isStreaming = messages.some(m => m.isStreaming);
      const autoScrollEnabled = messageListRef.current?.isAutoScrollEnabled() ?? true;
      setShowScrollButton(isStreaming && !autoScrollEnabled);
    };

    const intervalId = setInterval(checkScrollButton, 100);
    return () => clearInterval(intervalId);
  }, [messages]);

  const generateTitle = (text: string): string => {
    const words = text.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < text.split(' ').length ? '...' : '');
  };

  const handleNewChat = useCallback(() => {
    setCurrentConversationId(null);
  }, []);

  const handleConversationSelect = useCallback((id: string) => {
    setCurrentConversationId(id);
    setOpenTabIds(prev => {
      if (!prev.includes(id)) {
        return [...prev, id];
      }
      return prev;
    });
  }, []);

  const handleDeleteConversation = useCallback((id: string) => {
    if (!window.confirm('Delete this conversation?')) return;
    
    setConversations(prev => prev.filter(c => c.id !== id));
    setOpenTabIds(prev => prev.filter(tabId => tabId !== id));
    
    if (currentConversationId === id) {
      const remainingConversations = conversations.filter(c => c.id !== id);
      if (remainingConversations.length > 0) {
        setCurrentConversationId(remainingConversations[0].id);
        setOpenTabIds(prev => {
          if (!prev.includes(remainingConversations[0].id)) {
            return [remainingConversations[0].id];
          }
          return prev.filter(tabId => tabId !== id);
        });
      } else {
        setCurrentConversationId(null);
      }
    }
  }, [currentConversationId, conversations]);

  const handleTabClose = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabIds(prev => {
      const newTabs = prev.filter(tabId => tabId !== id);
      if (currentConversationId === id) {
        if (newTabs.length > 0) {
          setCurrentConversationId(newTabs[newTabs.length - 1]);
        } else {
          setCurrentConversationId(null);
        }
      }
      return newTabs;
    });
  }, [currentConversationId]);

  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
  }, []);

  const handleStopStreaming = useCallback(async () => {
    await window.assistant.stopStream();
    
    if (streamingMessageIdRef.current) {
      setConversations(prev =>
        prev.map(c => ({
          ...c,
          messages: c.messages.map(m =>
            m.id === streamingMessageIdRef.current
              ? { ...m, isStreaming: false }
              : m
          ),
        }))
      );
      streamingMessageIdRef.current = null;
    }
    
    setIsLoading(false);
  }, []);

  const handleScrollToMessage = useCallback((messageId: string) => {
    messageListRef.current?.scrollToMessage(messageId);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    messageListRef.current?.enableAutoScroll();
    messageListRef.current?.scrollToBottom();
    setShowScrollButton(false);
  }, []);

  const handleSendMessage = useCallback(async (text: string) => {
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    let conversationId = currentConversationId;
    
    if (!conversationId) {
      conversationId = Date.now().toString();
      const newTitle = generateTitle(text);
      const newConversation: Conversation = {
        id: conversationId,
        title: newTitle,
        timestamp: new Date(),
        messages: [],
      };
      setConversations(prev => [newConversation, ...prev]);
      setCurrentConversationId(conversationId);
      
      const cid = conversationId;
      setOpenTabIds(prev => [...prev, cid]);
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      text,
      sender: 'user',
      timestamp: new Date(),
    };

    setConversations(prev =>
      prev.map(c =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, userMessage] }
          : c
      )
    );

    setIsLoading(true);
    
    const assistantMessageId = crypto.randomUUID();
    const assistantMessage: Message = {
      id: assistantMessageId,
      text: '',
      sender: 'assistant',
      timestamp: new Date(),
      isStreaming: true,
    };

    setConversations(prev =>
      prev.map(c =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, assistantMessage] }
          : c
      )
    );

    streamingMessageIdRef.current = assistantMessageId;

    try {
      const conversationMessages = [
        ...messages.map(m => ({
          role: m.sender === 'user' ? 'user' : 'assistant' as const,
          content: m.text,
        })),
        { role: 'user' as const, content: text },
      ];

      await window.assistant.sendMessageStream(selectedModel, conversationMessages);
    } catch (error) {
      console.error('Error sending message:', error);
      setConversations(prev =>
        prev.map(c =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map(m =>
                  m.id === assistantMessageId
                    ? {
                        ...m,
                        text: `Error: ${error instanceof Error ? error.message : 'Failed to get response from model'}. Make sure Ollama is running.`,
                        isStreaming: false,
                      }
                    : m
                ),
              }
            : c
        )
      );
      setIsLoading(false);
      streamingMessageIdRef.current = null;
    }
  }, [currentConversationId, selectedModel, messages]);

  const openTabs = openTabIds.map(id => {
    const convo = conversations.find(c => c.id === id);
    return {
      id,
      title: convo ? convo.title : 'New Chat'
    };
  });

  return (
    <ThemeProvider>
      <CopyNotification />
      <div className="flex flex-col h-[100vh] w-[100vw] bg-bg-primary">
        <TopNavbar 
          tabs={openTabs}
          activeTabId={currentConversationId}
          onTabSelect={handleConversationSelect}
          onTabClose={handleTabClose}
        />
        
        <div className="flex flex-1 min-h-0 bg-bg-primary">
          <Sidebar
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            conversations={conversations.map(c => ({ 
              id: c.id, 
              title: c.title, 
              timestamp: c.timestamp 
            }))}
            currentConversationId={currentConversationId}
            onConversationSelect={handleConversationSelect}
            onConversationDelete={handleDeleteConversation}
            onNewChat={handleNewChat}
          />
          
          <main className="flex flex-col flex-1 min-w-0 bg-bg-primary">
            <ChatHeader
              onMenuClick={() => setSidebarOpen(!sidebarOpen)}
              title={currentConversation?.title || 'New Entry'}
              models={models}
              selectedModel={selectedModel}
              onModelSelect={handleModelSelect}
              isLoadingModels={isLoadingModels}
            />
            
            <div className="flex flex-1 min-h-0 relative">
              <MessageList 
                ref={messageListRef} 
                messages={messages} 
                isLoading={isLoading}
              />
              <MessageTrail messages={messages} onScrollToMessage={handleScrollToMessage} />
              {showScrollButton && <ScrollToBottomButton onClick={handleScrollToBottom} />}
            </div>
            
            <InputArea
              onSendMessage={handleSendMessage}
              onStopStreaming={handleStopStreaming}
              isLoading={isLoading}
              disabled={!selectedModel}
            />
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
};

export default App;