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

interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
}

interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
}

function serializeConversation(c: Conversation): SerializedConversation {
  return {
    ...c,
    timestamp: c.timestamp.toISOString(),
    messages: c.messages.map(m => ({
      ...m,
      timestamp: m.timestamp.toISOString(),
    })),
  };
}

function deserializeConversation(c: SerializedConversation): Conversation {
  return {
    ...c,
    timestamp: new Date(c.timestamp),
    messages: c.messages.map(m => ({
      ...m,
      timestamp: new Date(m.timestamp),
    })),
  };
}

interface VoiceTranscriptPayload {
  text: string;
  autoSubmit: boolean;
}

interface PendingVoiceTranscript extends VoiceTranscriptPayload {
  id: string;
}

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<string[]>;
      sendMessage: (model: string, messages: { role: string; content: string }[]) => Promise<string>;
      sendMessageStream: (model: string, messages: { role: string; content: string }[]) => Promise<{ success: boolean }>;
      stopStream: () => Promise<{ success: boolean }>;
      getVoiceShortcut: () => Promise<string>;
      onChunk: (callback: (chunk: string) => void) => () => void;
      onDone: (callback: () => void) => () => void;
      onError: (callback: (error: string) => void) => () => void;
      startVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      stopVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      getVoiceRecordingState: () => Promise<'idle' | 'recording' | 'processing'>;
      onVoiceFlowState: (callback: (state: 'idle' | 'recording' | 'processing') => void) => () => void;
      onVoiceTranscript: (callback: (payload: VoiceTranscriptPayload) => void) => () => void;
      onVoiceError: (callback: (error: string) => void) => () => void;
      sendAudioData: (samples: number[]) => void;
      storeLoadConversations: () => Promise<SerializedConversation[]>;
      storeSaveConversations: (conversations: SerializedConversation[]) => Promise<{ success: boolean }>;
      storeDeleteConversation: (id: string) => Promise<{ success: boolean }>;
      storeLoadModel: () => Promise<string>;
      storeSaveModel: (model: string) => Promise<{ success: boolean }>;
    };
  }
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
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [voiceTranscript, setVoiceTranscript] = useState<PendingVoiceTranscript | null>(null);
  const [voiceShortcut, setVoiceShortcut] = useState<string>('');
  
  const streamingMessageIdRef = useRef<string | null>(null);
  const cleanupFunctionsRef = useRef<(() => void)[]>([]);
  const messageListRef = useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isInitialLoadRef = useRef(true);

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
    const loadStoredData = async () => {
      try {
        const stored = await window.assistant.storeLoadConversations();
        if (stored && stored.length > 0) {
          setConversations(stored.map(deserializeConversation));
          const lastId = stored[stored.length - 1].id;
          setCurrentConversationId(lastId);
          setOpenTabIds([lastId]);
        }
      } catch (error) {
        console.error('Failed to load stored conversations:', error);
      }

      try {
        const storedModel = await window.assistant.storeLoadModel();
        if (storedModel) {
          setSelectedModel(storedModel);
        }
      } catch (error) {
        console.error('Failed to load stored model:', error);
      }
    };
    loadStoredData();
  }, []);

  useEffect(() => {
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }
    const hasStreaming = conversations.some(c => c.messages.some(m => m.isStreaming));
    if (hasStreaming) return;

    const serialized = conversations.map(serializeConversation);
    window.assistant.storeSaveConversations(serialized).catch(err => {
      console.error('Failed to save conversations:', err);
    });
  }, [conversations]);

  useEffect(() => {
    if (isInitialLoadRef.current) return;

    if (selectedModel) {
      window.assistant.storeSaveModel(selectedModel).catch(err => {
        console.error('Failed to save selected model:', err);
      });
    }
  }, [selectedModel]);

  useEffect(() => {
    const loadVoiceShortcut = async () => {
      try {
        if (!window.assistant?.getVoiceShortcut) {
          return;
        }

        const shortcut = await window.assistant.getVoiceShortcut();
        setVoiceShortcut(shortcut);
      } catch (error) {
        console.error('Failed to load voice shortcut:', error);
      }
    };

    loadVoiceShortcut();
  }, []);

  useEffect(() => {
    if (!window.assistant?.onVoiceTranscript) return;
    
    const cleanup = window.assistant.onVoiceTranscript((payload) => {
      if (payload?.text) {
        setVoiceTranscript({
          id: crypto.randomUUID(),
          text: payload.text,
          autoSubmit: payload.autoSubmit,
        });
      }
    });
    
    return cleanup;
  }, []);

  const handleVoiceTextUsed = useCallback(() => {
    setVoiceTranscript(null);
  }, []);

  useEffect(() => {
    if (!window.assistant?.onVoiceError) return;
    
    const cleanup = window.assistant.onVoiceError((error) => {
      console.error('Voice error:', error);
    });
    
    return cleanup;
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

    const finishStreaming = () => {
      setConversations(prev =>
        prev.map(c => ({
          ...c,
          messages: c.messages.map(m =>
            m.isStreaming ? { ...m, isStreaming: false } : m
          )
        }))
      );
      streamingMessageIdRef.current = null;
      setIsLoading(false);
    };

    const handleDone = () => {
      finishStreaming();
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
            )
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
  }, [currentConversationId]);

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
    
    window.assistant.storeDeleteConversation(id).catch(err => {
      console.error('Failed to delete conversation from store:', err);
    });
    
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

  const handleEditMessage = useCallback((messageId: string) => {
    setEditingMessageId(messageId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleResubmitMessage = useCallback(async (messageId: string, newText: string) => {
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    setEditingMessageId(null);

    const conversation = conversations.find(c => c.id === currentConversationId);
    if (!conversation) return;

    const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const updatedMessages = conversation.messages.slice(0, messageIndex).map(m => ({
      ...m,
      text: m.id === messageId ? newText : m.text
    }));

    const editedMessage: Message = {
      id: messageId,
      text: newText,
      sender: 'user',
      timestamp: new Date(),
    };

    setConversations(prev =>
      prev.map(c =>
        c.id === currentConversationId
          ? { ...c, messages: [...conversation.messages.slice(0, messageIndex), editedMessage] }
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
        c.id === currentConversationId
          ? { ...c, messages: [...conversation.messages.slice(0, messageIndex), editedMessage, assistantMessage] }
          : c
      )
    );

    streamingMessageIdRef.current = assistantMessageId;

    try {
      const conversationMessages = [
        ...conversation.messages.slice(0, messageIndex).map(m => ({
          role: m.sender === 'user' ? 'user' : 'assistant' as const,
          content: m.text,
        })),
        { role: 'user' as const, content: newText },
      ];

      await window.assistant.sendMessageStream(selectedModel, conversationMessages);
    } catch (error) {
      console.error('Error sending message:', error);
      setConversations(prev =>
        prev.map(c =>
          c.id === currentConversationId
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
  }, [currentConversationId, selectedModel, conversations]);

  const handleRegenerateResponse = useCallback(async (messageId: string) => {
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    const conversation = conversations.find(c => c.id === currentConversationId);
    if (!conversation) return;

    const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const userMessageIndex = messageIndex - 1;
    if (userMessageIndex < 0 || conversation.messages[userMessageIndex].sender !== 'user') return;

    const userMessage = conversation.messages[userMessageIndex];

    setConversations(prev =>
      prev.map(c =>
        c.id === currentConversationId
          ? { ...c, messages: conversation.messages.slice(0, messageIndex) }
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
        c.id === currentConversationId
          ? { ...c, messages: [...conversation.messages.slice(0, messageIndex), assistantMessage] }
          : c
      )
    );

    streamingMessageIdRef.current = assistantMessageId;

    try {
      const conversationMessages = [
        ...conversation.messages.slice(0, userMessageIndex).map(m => ({
          role: m.sender === 'user' ? 'user' : 'assistant' as const,
          content: m.text,
        })),
        { role: 'user' as const, content: userMessage.text },
      ];

      await window.assistant.sendMessageStream(selectedModel, conversationMessages);
    } catch (error) {
      console.error('Error regenerating response:', error);
      setConversations(prev =>
        prev.map(c =>
          c.id === currentConversationId
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
  }, [currentConversationId, selectedModel, conversations]);

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
                editingMessageId={editingMessageId}
                onEditMessage={handleEditMessage}
                onCancelEdit={handleCancelEdit}
                onResubmitMessage={handleResubmitMessage}
                onRegenerateResponse={handleRegenerateResponse}
              />
              <MessageTrail messages={messages} onScrollToMessage={handleScrollToMessage} />
              {showScrollButton && <ScrollToBottomButton onClick={handleScrollToBottom} />}
            </div>
            
            <InputArea
              onSendMessage={handleSendMessage}
              onStopStreaming={handleStopStreaming}
              isLoading={isLoading}
              disabled={!selectedModel}
              voiceTranscript={voiceTranscript}
              onVoiceTextUsed={handleVoiceTextUsed}
              voiceShortcut={voiceShortcut}
            />
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
};

export default App;