import React, { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatHeader from './components/ChatHeader';
import MessageList from './components/MessageList';
import InputArea from './components/InputArea';
import TopNavbar from './components/TopNavbar';
import { ThemeProvider } from './context/ThemeContext';

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<string[]>;
      sendMessage: (model: string, messages: { role: string; content: string }[]) => Promise<string>;
      sendMessageStream: (model: string, messages: { role: string; content: string }[]) => Promise<{ success: boolean }>;
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
        setIsLoading(false);
      }
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
      id: `${conversationId}-${Date.now()}`,
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
    
    const assistantMessageId = `${conversationId}-${Date.now() + 1}`;
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
            
            <MessageList messages={messages} isLoading={isLoading} />
            
            <InputArea
              onSendMessage={handleSendMessage}
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