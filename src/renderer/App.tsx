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
import type { BrowserLLMTrace, BrowserScreenshotArtifact, BrowserToolRun } from '../shared/browser';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  toolRuns?: BrowserToolRun[];
}

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  messages: Message[];
  folderId: string | null;
}

interface Folder {
  id: string;
  name: string;
  timestamp: Date;
}

interface SerializedMessage {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: string;
  toolRuns?: BrowserToolRun[];
}

interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
  folderId: string | null;
}

interface SerializedFolder {
  id: string;
  name: string;
  timestamp: string;
}

function serializeConversation(c: Conversation): SerializedConversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: c.timestamp.toISOString(),
    messages: c.messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: m.timestamp.toISOString(),
      toolRuns: m.toolRuns,
    })),
    folderId: c.folderId,
  };
}

function deserializeConversation(c: SerializedConversation): Conversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: new Date(c.timestamp),
    messages: c.messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: new Date(m.timestamp),
      toolRuns: m.toolRuns,
    })),
    folderId: c.folderId ?? null,
  };
}

function serializeFolder(f: Folder): SerializedFolder {
  return {
    id: f.id,
    name: f.name,
    timestamp: f.timestamp.toISOString(),
  };
}

function deserializeFolder(f: SerializedFolder): Folder {
  return {
    id: f.id,
    name: f.name,
    timestamp: new Date(f.timestamp),
  };
}

function getNextFolderName(existingFolders: Folder[]): string {
  const normalizedNames = new Set(
    existingFolders.map(folder => folder.name.trim().toLowerCase())
  );

  if (!normalizedNames.has('new folder')) {
    return 'New Folder';
  }

  let suffix = 2;
  while (normalizedNames.has(`new folder ${suffix}`)) {
    suffix += 1;
  }

  return `New Folder ${suffix}`;
}

function mergeDefinedFields<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<T>;

  return {
    ...base,
    ...definedPatch,
  };
}

interface VoiceTranscriptPayload {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
}

interface PendingVoiceTranscript extends VoiceTranscriptPayload {
  id: string;
}

interface BrowserToolEventPayload {
  conversationId: string;
  assistantMessageId: string;
  runId: string;
  status: BrowserToolRun['status'];
  instruction: string;
  startUrl?: string;
  summary?: string;
  currentUrl?: string;
  pageTitle?: string;
  actionsTaken?: number;
  error?: string;
  processing?: string;
  model?: string;
  mode?: BrowserToolRun['mode'];
  screenshots?: BrowserScreenshotArtifact[];
  llmTrace?: BrowserLLMTrace;
  extractionOutput?: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
}

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

function toStreamMessage(message: Pick<Message, 'sender' | 'text'>): SendMessageStreamRequest['messages'][number] {
  return {
    role: message.sender === 'user' ? 'user' : 'assistant',
    content: message.text,
  };
}

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<string[]>;
      sendMessage: (model: string, messages: { role: string; content: string }[]) => Promise<string>;
      sendMessageStream: (request: SendMessageStreamRequest) => Promise<{ success: boolean; aborted?: boolean }>;
      stopStream: () => Promise<{ success: boolean }>;
      getVoiceShortcut: () => Promise<string>;
      onChunk: (callback: (chunk: string) => void) => () => void;
      onDone: (callback: () => void) => () => void;
      onError: (callback: (error: string) => void) => () => void;
      onBrowserToolEvent: (callback: (payload: BrowserToolEventPayload) => void) => () => void;
      getBrowserArtifactDataUrl: (filePath: string) => Promise<string | null>;
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
      storeLoadFolders: () => Promise<SerializedFolder[]>;
      storeSaveFolders: (folders: SerializedFolder[]) => Promise<{ success: boolean }>;
      storeDeleteFolder: (id: string) => Promise<{ success: boolean }>;
      storeLoadModel: () => Promise<string>;
      storeSaveModel: (model: string) => Promise<{ success: boolean }>;
      setThemeBackground: (isDark: boolean) => void;
    };
  }
}

const App: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
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
  const [hasHydratedStore, setHasHydratedStore] = useState(false);
  const pendingJarvisMessageRef = useRef<string | null>(null);
  const [newChatTrigger, setNewChatTrigger] = useState(0);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        const fetchedModels = await window.assistant.getModels();
        setModels(fetchedModels);
        if (fetchedModels.length > 0) {
          setSelectedModel(prev => prev ?? fetchedModels[0]);
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
    let isMounted = true;

    const loadStoredData = async () => {
      const [conversationsResult, foldersResult, modelResult] = await Promise.allSettled([
        window.assistant.storeLoadConversations(),
        window.assistant.storeLoadFolders(),
        window.assistant.storeLoadModel(),
      ]);

      if (!isMounted) {
        return;
      }

      if (conversationsResult.status === 'fulfilled') {
        const storedConversations = conversationsResult.value;
        setConversations(storedConversations.map(deserializeConversation));
        if (storedConversations.length > 0) {
          const lastId = storedConversations[storedConversations.length - 1].id;
          setCurrentConversationId(lastId);
          setOpenTabIds([lastId]);
        } else {
          setCurrentConversationId(null);
          setOpenTabIds([]);
        }
      } else {
        console.error('Failed to load stored conversations:', conversationsResult.reason);
      }

      if (foldersResult.status === 'fulfilled') {
        setFolders(foldersResult.value.map(deserializeFolder));
      } else {
        console.error('Failed to load stored folders:', foldersResult.reason);
      }

      if (modelResult.status === 'fulfilled') {
        if (modelResult.value) {
          setSelectedModel(modelResult.value);
        }
      } else {
        console.error('Failed to load stored model:', modelResult.reason);
      }

      setHasHydratedStore(true);
    };

    void loadStoredData();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedStore) {
      return;
    }

    const hasStreaming = conversations.some(c => c.messages.some(m => m.isStreaming));
    if (hasStreaming) return;

    const serialized = conversations.map(serializeConversation);
    window.assistant.storeSaveConversations(serialized).catch(err => {
      console.error('Failed to save conversations:', err);
    });
  }, [conversations, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    const validIds = new Set(conversations.map(c => c.id));

    setOpenTabIds(prev => {
      const filtered = prev.filter(id => validIds.has(id));
      return filtered.length !== prev.length ? filtered : prev;
    });

    if (currentConversationId && !validIds.has(currentConversationId)) {
      setCurrentConversationId(conversations[0]?.id ?? null);
    }
  }, [conversations, currentConversationId, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    const serialized = folders.map(serializeFolder);
    window.assistant.storeSaveFolders(serialized).catch(err => {
      console.error('Failed to save folders:', err);
    });
  }, [folders, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    if (selectedModel) {
      window.assistant.storeSaveModel(selectedModel).catch(err => {
        console.error('Failed to save selected model:', err);
      });
    }
  }, [selectedModel, hasHydratedStore]);

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
        if (payload.newChat && payload.autoSubmit) {
          pendingJarvisMessageRef.current = payload.text;
          setCurrentConversationId(null);
          setNewChatTrigger(prev => prev + 1);
        } else {
          setVoiceTranscript({
            id: crypto.randomUUID(),
            text: payload.text,
            autoSubmit: payload.autoSubmit,
            newChat: payload.newChat,
          });
        }
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

    const handleBrowserToolEvent = (payload: BrowserToolEventPayload) => {
      const toolRunPatch: Partial<BrowserToolRun> & Pick<BrowserToolRun, 'id' | 'status' | 'instruction' | 'startedAt'> = {
        id: payload.runId,
        status: payload.status,
        instruction: payload.instruction,
        startedAt: payload.startedAt,
      };

      if (payload.startUrl !== undefined) {
        toolRunPatch.startUrl = payload.startUrl;
      }
      if (payload.summary !== undefined) {
        toolRunPatch.summary = payload.summary;
      }
      if (payload.currentUrl !== undefined) {
        toolRunPatch.currentUrl = payload.currentUrl;
      }
      if (payload.pageTitle !== undefined) {
        toolRunPatch.pageTitle = payload.pageTitle;
      }
      if (payload.actionsTaken !== undefined) {
        toolRunPatch.actionsTaken = payload.actionsTaken;
      }
      if (payload.error !== undefined) {
        toolRunPatch.error = payload.error;
      }
      if (payload.processing !== undefined) {
        toolRunPatch.processing = payload.processing;
      }
      if (payload.model !== undefined) {
        toolRunPatch.model = payload.model;
      }
      if (payload.mode !== undefined) {
        toolRunPatch.mode = payload.mode;
      }
      if (payload.screenshots !== undefined) {
        toolRunPatch.screenshots = payload.screenshots;
      }
      if (payload.llmTrace !== undefined) {
        toolRunPatch.llmTrace = payload.llmTrace;
      }
      if (payload.extractionOutput !== undefined) {
        toolRunPatch.extractionOutput = payload.extractionOutput;
      }
      if (payload.finishedAt !== undefined) {
        toolRunPatch.finishedAt = payload.finishedAt;
      }
      if (payload.textOffset !== undefined) {
        toolRunPatch.textOffset = payload.textOffset;
      }

      setConversations(prev => {
        const matchingConversation = prev.find(c =>
          c.messages.some(m => m.id === payload.assistantMessageId)
        );
        const matchingMessage = matchingConversation?.messages.find(m => m.id === payload.assistantMessageId);

        const isNewToolRun = matchingMessage
          ? !(matchingMessage.toolRuns ?? []).some(run => run.id === payload.runId)
          : false;

        if (isNewToolRun && matchingMessage) {
          toolRunPatch.textOffset ??= matchingMessage.text.length;
        }

        return prev.map(c => ({
          ...c,
          messages: c.messages.map(m => {
            if (m.id !== payload.assistantMessageId) {
              return m;
            }

            const existingToolRuns = m.toolRuns ?? [];
            const existingToolRunIndex = existingToolRuns.findIndex(run => run.id === payload.runId);

            if (existingToolRunIndex === -1) {
              return {
                ...m,
                toolRuns: [...existingToolRuns, toolRunPatch as BrowserToolRun],
              };
            }

            return {
              ...m,
              toolRuns: existingToolRuns.map(run =>
                run.id === payload.runId ? mergeDefinedFields(run as unknown as Record<string, unknown>, toolRunPatch as unknown as Record<string, unknown>) as unknown as BrowserToolRun : run
              ),
            };
          }),
        }));
      });
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
    const browserToolCleanup = window.assistant.onBrowserToolEvent(handleBrowserToolEvent);

    cleanupFunctionsRef.current = [chunkCleanup, doneCleanup, errorCleanup, browserToolCleanup];

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
    setNewChatTrigger(prev => prev + 1);
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

    const remainingConversations = conversations.filter(c => c.id !== id);
    const nextConversationId = currentConversationId === id
      ? remainingConversations[0]?.id ?? null
      : currentConversationId;

    void window.assistant.storeDeleteConversation(id)
      .then(() => {
        setConversations(prev => prev.filter(c => c.id !== id));
        setOpenTabIds(prev => {
          const filtered = prev.filter(tabId => tabId !== id);
          return nextConversationId && !filtered.includes(nextConversationId)
            ? [...filtered, nextConversationId]
            : filtered;
        });

        if (currentConversationId === id) {
          setCurrentConversationId(nextConversationId);
        }
      })
      .catch(err => {
        console.error('Failed to delete conversation from store:', err);
        window.alert('Failed to delete conversation. Please try again.');
      });
  }, [currentConversationId, conversations]);

  const handleCreateFolder = useCallback(() => {
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      name: getNextFolderName(folders),
      timestamp: new Date(),
    };
    setFolders(prev => [newFolder, ...prev]);
    return newFolder.id;
  }, [folders]);

  const handleRenameFolder = useCallback((id: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setFolders(prev => prev.map(f => f.id === id ? { ...f, name: trimmedName } : f));
  }, []);

  const handleDeleteFolder = useCallback((id: string) => {
    const folder = folders.find(f => f.id === id);
    if (!folder) return;
    const convosInFolder = conversations.filter(c => c.folderId === id);
    const count = convosInFolder.length;
    const deletedIds = new Set(convosInFolder.map(c => c.id));
    const confirmationMessage = count === 0
      ? `Delete empty folder "${folder.name}"?`
      : `Delete folder "${folder.name}"? This will permanently delete ${count} conversation${count !== 1 ? 's' : ''} inside it.`;
    if (!window.confirm(confirmationMessage)) return;

    const remainingConversations = conversations.filter(c => c.folderId !== id);
    const nextConversationId = currentConversationId && deletedIds.has(currentConversationId)
      ? remainingConversations[0]?.id ?? null
      : currentConversationId;

    void window.assistant.storeDeleteFolder(id)
      .then(() => {
        setConversations(prev => prev.filter(c => c.folderId !== id));
        setFolders(prev => prev.filter(f => f.id !== id));
        setOpenTabIds(prev => {
          const filtered = prev.filter(tabId => !deletedIds.has(tabId));
          return nextConversationId && !filtered.includes(nextConversationId)
            ? [...filtered, nextConversationId]
            : filtered;
        });

        if (currentConversationId && deletedIds.has(currentConversationId)) {
          setCurrentConversationId(nextConversationId);
        }
      })
      .catch(err => {
        console.error('Failed to delete folder from store:', err);
        window.alert('Failed to delete folder. Please try again.');
      });
  }, [folders, conversations, currentConversationId]);

  const handleMoveConversation = useCallback((conversationId: string, folderId: string | null) => {
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, folderId } : c
    ));
  }, []);

  useEffect(() => {
    const handleKeyboardShortcut = (e: KeyboardEvent) => {
      if (e.metaKey && e.shiftKey && e.key === 'o') {
        e.preventDefault();
        handleNewChat();
      }
      if (e.metaKey && e.shiftKey && e.key === 'Backspace') {
        e.preventDefault();
        if (currentConversationId) {
          handleDeleteConversation(currentConversationId);
        }
      }
    };
    window.addEventListener('keydown', handleKeyboardShortcut);
    return () => window.removeEventListener('keydown', handleKeyboardShortcut);
  }, [handleNewChat, handleDeleteConversation, currentConversationId]);

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

  const handleScrollToMessage = useCallback((messageId: string, headerIndex?: number) => {
    if (headerIndex !== undefined) {
      messageListRef.current?.scrollToMessageHeader(messageId, headerIndex);
      return;
    }

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
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...conversation.messages.slice(0, messageIndex).map(toStreamMessage),
        { role: 'user', content: newText },
      ];

      await window.assistant.sendMessageStream({
        conversationId: conversation.id,
        assistantMessageId,
        model: selectedModel,
        messages: conversationMessages,
      });
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
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...conversation.messages.slice(0, userMessageIndex).map(toStreamMessage),
        { role: 'user', content: userMessage.text },
      ];

      await window.assistant.sendMessageStream({
        conversationId: conversation.id,
        assistantMessageId,
        model: selectedModel,
        messages: conversationMessages,
      });
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
        folderId: null,
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
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...messages.map(toStreamMessage),
        { role: 'user', content: text },
      ];

      await window.assistant.sendMessageStream({
        conversationId,
        assistantMessageId,
        model: selectedModel,
        messages: conversationMessages,
      });
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

  useEffect(() => {
    if (currentConversationId === null && pendingJarvisMessageRef.current) {
      const text = pendingJarvisMessageRef.current;
      pendingJarvisMessageRef.current = null;
      handleSendMessage(text);
    }
  }, [currentConversationId, newChatTrigger, handleSendMessage]);

  const validConversationIds = new Set(conversations.map(c => c.id));

  const openTabs = openTabIds
    .filter(id => validConversationIds.has(id))
    .map(id => {
      const convo = conversations.find(c => c.id === id);
      return {
        id,
        title: convo ? convo.title : 'New Chat'
      };
    });

  const activeConversation = currentConversationId && validConversationIds.has(currentConversationId)
    ? conversations.find(c => c.id === currentConversationId) ?? null
    : null;

  return (
    <ThemeProvider>
      <CopyNotification />
      <div className="flex flex-col h-screen w-screen bg-bg-primary">
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
              timestamp: c.timestamp,
              folderId: c.folderId,
            }))}
            folders={folders}
            currentConversationId={currentConversationId}
            onConversationSelect={handleConversationSelect}
            onConversationDelete={handleDeleteConversation}
            onNewChat={handleNewChat}
            onCreateFolder={handleCreateFolder}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onMoveConversation={handleMoveConversation}
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
            
            <div ref={chatScrollContainerRef} className="flex flex-1 min-h-0 overflow-y-auto message-scroll-container">
              <MessageList 
                ref={messageListRef} 
                scrollContainerRef={chatScrollContainerRef}
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
              composeFocusKey={newChatTrigger}
            />
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
};

export default App;