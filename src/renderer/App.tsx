import React, { useState, useCallback, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import MessageList, { MessageListHandle } from './components/MessageList';
import InputArea from './components/InputArea';
import TopNavbar from './components/TopNavbar';
import CopyNotification from './components/CopyNotification';
import MessageTrail from './components/MessageTrail';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import { ThemeProvider } from './context/ThemeContext';
import type { SearchSourceGroup, SearchSourcesEvent } from '../shared/search';
import type { StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../shared/stream';
import type { AttachmentSelectionResult, FileAttachment } from '../shared/attachments';
import type {
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  PersonalDictionaryState,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
} from '../shared/dictionary';
import PersonalDictionary from './components/PersonalDictionary';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'assistant';
  timestamp: Date;
  isStreaming?: boolean;
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
}

interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
  messages: Message[];
  folderId: string | null;
  isLoaded: boolean;
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
  searchSources?: SearchSourceGroup[];
  attachments?: FileAttachment[];
}

interface SerializedConversation {
  id: string;
  title: string;
  timestamp: string;
  messages: SerializedMessage[];
  folderId: string | null;
}

interface SerializedConversationMetadata {
  id: string;
  title: string;
  timestamp: string;
  folderId: string | null;
}

interface SerializedFolder {
  id: string;
  name: string;
  timestamp: string;
}

type SerializedConversationDrafts = Record<string, string>;

const SCROLL_BUTTON_BOTTOM_THRESHOLD = 8;
const CONVERSATION_CACHE_LIMIT = 6;
const SAVE_DEBOUNCE_MS = 400;
const STREAM_FLUSH_MS = 60;
const NEW_CHAT_DRAFT_ID = '__new_chat__';

const isScrollContainerAtBottom = (container: HTMLElement) => (
  container.scrollHeight - container.scrollTop - container.clientHeight <= SCROLL_BUTTON_BOTTOM_THRESHOLD
);

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
      searchSources: m.searchSources,
      attachments: m.attachments,
    })),
    folderId: c.folderId,
  };
}

function serializeConversationMetadata(c: Conversation): SerializedConversationMetadata {
  return {
    id: c.id,
    title: c.title,
    timestamp: c.timestamp.toISOString(),
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
      searchSources: m.searchSources,
      attachments: m.attachments,
    })),
    folderId: c.folderId ?? null,
    isLoaded: true,
  };
}

function deserializeConversationMetadata(c: SerializedConversationMetadata): Conversation {
  return {
    id: c.id,
    title: c.title,
    timestamp: new Date(c.timestamp),
    messages: [],
    folderId: c.folderId ?? null,
    isLoaded: false,
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

function hashString(value: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashUnknown(value: unknown, seed = 2166136261): number {
  if (value === null || value === undefined) {
    return hashString(String(value), seed);
  }

  if (typeof value !== 'object') {
    return hashString(String(value), seed);
  }

  if (Array.isArray(value)) {
    return value.reduce((hash, item, index) => (
      hashUnknown(item, hashString(`[${index}]`, hash))
    ), seed);
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce((hash, key) => (
      hashUnknown((value as Record<string, unknown>)[key], hashString(key, hash))
    ), seed);
}

function getConversationMetadataRevision(conversations: Conversation[]): string {
  const hash = conversations.reduce((metadataHash, conversation) => (
    hashString(
      `${conversation.id}\u0000${conversation.title}\u0000${conversation.timestamp.toISOString()}\u0000${conversation.folderId ?? ''}`,
      metadataHash
    )
  ), 2166136261);
  return `${conversations.length}:${hash}`;
}

function getConversationRevision(conversation: Conversation): string {
  const hash = conversation.messages.reduce((messageHash, message) => {
    let nextHash = hashString(
      `${message.id}\u0000${message.sender}\u0000${message.timestamp.toISOString()}\u0000${message.text.length}`,
      messageHash
    );
    nextHash = hashString(message.text, nextHash);
    nextHash = hashUnknown(message.searchSources, nextHash);
    nextHash = hashUnknown(message.attachments, nextHash);
    return nextHash;
  }, hashString(
    `${conversation.id}\u0000${conversation.title}\u0000${conversation.timestamp.toISOString()}\u0000${conversation.folderId ?? ''}`,
    2166136261
  ));

  return `${conversation.messages.length}:${hash}`;
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

interface VoiceTranscriptPayload {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
}

interface PendingVoiceTranscript extends VoiceTranscriptPayload {
  id: string;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
}

interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
}

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
  messages: {
    role: 'user' | 'assistant';
    content: string;
    images?: string[];
    imageMimeTypes?: string[];
  }[];
}

function getProviderForModel(models: ModelInfo[], modelId: string | null): string {
  if (!modelId) return 'ollama';
  const model = models.find(m => m.id === modelId);
  return model?.provider || 'ollama';
}

function toStreamMessage(message: Pick<Message, 'sender' | 'text' | 'attachments'>): SendMessageStreamRequest['messages'][number] {
  const textAttachments = message.attachments?.filter(attachment => attachment.kind !== 'image') ?? [];
  const imageAttachments = message.attachments?.filter(attachment => attachment.kind === 'image' && attachment.base64) ?? [];
  const attachmentContext = textAttachments.map(attachment => [
    '',
    `--- Attached file: ${attachment.name}${attachment.truncated ? ' (truncated)' : ''} ---`,
    attachment.content,
    `--- End attached file: ${attachment.name} ---`,
  ].join('\n')).join('\n');

  return {
    role: message.sender === 'user' ? 'user' : 'assistant',
    content: `${message.text}${attachmentContext}`,
    images: imageAttachments.map(attachment => attachment.base64!),
    imageMimeTypes: imageAttachments.map(attachment => attachment.mimeType ?? 'image/png'),
  };
}

declare global {
  interface Window {
    assistant: {
      getModels: () => Promise<ModelInfo[]>;
      getModelsForProvider: (providerId: string) => Promise<ModelInfo[]>;
      getProviders: () => Promise<ProviderInfo[]>;
      pickAttachmentPaths: () => Promise<string[]>;
      readAttachments: (filePaths: string[]) => Promise<AttachmentSelectionResult>;
      getPathForFile: (file: File) => string;
      sendMessageStream: (request: SendMessageStreamRequest) => Promise<{ success: boolean; aborted?: boolean }>;
      stopStream: (request: StopStreamRequest) => Promise<{ success: boolean }>;
      getVoiceShortcut: () => Promise<string>;
      onChunk: (callback: (event: StreamChunkEvent) => void) => () => void;
      onDone: (callback: (event: StreamEventContext) => void) => () => void;
      onError: (callback: (event: StreamErrorEvent) => void) => () => void;
      onSearchSources: (callback: (event: SearchSourcesEvent) => void) => () => void;
      startVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      stopVoiceRecording: () => Promise<{ success: boolean; error?: string }>;
      getVoiceRecordingState: () => Promise<'idle' | 'recording' | 'processing'>;
      onVoiceFlowState: (callback: (state: 'idle' | 'recording' | 'processing') => void) => () => void;
      onVoiceTranscript: (callback: (payload: VoiceTranscriptPayload) => void) => () => void;
      onVoiceError: (callback: (error: string) => void) => () => void;
      onMenuNewConversation: (callback: () => void) => () => void;
      connectAudioPort: (port: MessagePort) => void;
      sendAudioData: (chunk: ArrayBuffer | ArrayBufferView) => void;
      storeLoadConversations: () => Promise<SerializedConversation[]>;
      storeLoadConversationList: () => Promise<SerializedConversationMetadata[]>;
      storeLoadConversation: (id: string) => Promise<SerializedConversation | null>;
      storeLoadConversationsById: (ids: string[]) => Promise<SerializedConversation[]>;
      storeSaveConversations: (conversations: SerializedConversation[]) => Promise<{ success: boolean }>;
      storeSaveConversationList: (conversations: SerializedConversationMetadata[]) => Promise<{ success: boolean }>;
      storeSaveConversation: (conversation: SerializedConversation) => Promise<{ success: boolean }>;
      storeDeleteConversation: (id: string) => Promise<{ success: boolean }>;
      storeLoadFolders: () => Promise<SerializedFolder[]>;
      storeSaveFolders: (folders: SerializedFolder[]) => Promise<{ success: boolean }>;
      storeDeleteFolder: (id: string) => Promise<{ success: boolean }>;
      storeLoadModel: () => Promise<string>;
      storeSaveModel: (model: string) => Promise<{ success: boolean }>;
      storeLoadProvider: () => Promise<string>;
      storeSaveProvider: (provider: string) => Promise<{ success: boolean }>;
      storeLoadOpenCodeGoApiKey: () => Promise<string>;
      storeSaveOpenCodeGoApiKey: (key: string) => Promise<{ success: boolean }>;
      storeLoadOpenRouterApiKey: () => Promise<string>;
      storeSaveOpenRouterApiKey: (key: string) => Promise<{ success: boolean }>;
      storeLoadOpenTabIds: () => Promise<string[]>;
      storeSaveOpenTabIds: (tabIds: string[]) => Promise<{ success: boolean }>;
      storeLoadCurrentConversationId: () => Promise<string | null>;
      storeSaveCurrentConversationId: (id: string | null) => Promise<{ success: boolean }>;
      storeLoadConversationDrafts: () => Promise<SerializedConversationDrafts>;
      storeSaveConversationDrafts: (drafts: SerializedConversationDrafts) => Promise<{ success: boolean }>;
      dictionaryList: () => Promise<PersonalDictionaryState>;
      dictionaryCreate: (input: CreateDictionaryEntryInput) => Promise<PersonalDictionaryState>;
      dictionaryUpdate: (id: string, input: UpdateDictionaryEntryInput) => Promise<PersonalDictionaryState>;
      dictionaryDelete: (id: string) => Promise<PersonalDictionaryState>;
      dictionaryRuleCreate: (input: CreateReplacementRuleInput) => Promise<PersonalDictionaryState>;
      dictionaryRuleUpdate: (id: string, input: UpdateReplacementRuleInput) => Promise<PersonalDictionaryState>;
      dictionaryRuleDelete: (id: string) => Promise<PersonalDictionaryState>;
      dictionaryCandidateUpdate: (id: string, input: UpdateVocabularyCandidateInput) => Promise<PersonalDictionaryState>;
      generateTitle: (message: string, model: string, provider: string) => Promise<string>;
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
  const [conversationDrafts, setConversationDrafts] = useState<SerializedConversationDrafts>({});
  const [unreadCompleteConversationIds, setUnreadCompleteConversationIds] = useState<Set<string>>(() => new Set());
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const selectedProvider = getProviderForModel(models, selectedModel);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [voiceTranscript, setVoiceTranscript] = useState<PendingVoiceTranscript | null>(null);
  const [voiceShortcut, setVoiceShortcut] = useState<string>('');
  const [workspaceView, setWorkspaceView] = useState<'chat' | 'dictionary'>('chat');
  
  const streamingSessionsRef = useRef<Map<string, { conversationId: string }>>(new Map());
  const cleanupFunctionsRef = useRef<(() => void)[]>([]);
  const messageListRef = useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasHydratedStore, setHasHydratedStore] = useState(false);
  const pendingJarvisMessageRef = useRef<string | null>(null);
  const [newChatTrigger, setNewChatTrigger] = useState(0);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const conversationAccessRef = useRef<Map<string, number>>(new Map());
  const savedConversationRevisionsRef = useRef<Map<string, string>>(new Map());
  const savedConversationMetadataRevisionRef = useRef<string>('');
  const metadataSaveTimerRef = useRef<number | null>(null);
  const conversationSaveTimersRef = useRef<Map<string, number>>(new Map());
  const draftSaveTimerRef = useRef<number | null>(null);
  const streamChunkBuffersRef = useRef<Map<string, string[]>>(new Map());
  const streamFlushTimersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    // provider is now derived from the selected model
  }, []);

  useEffect(() => () => {
    if (metadataSaveTimerRef.current !== null) {
      window.clearTimeout(metadataSaveTimerRef.current);
    }
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
    }
    conversationSaveTimersRef.current.forEach(timerId => window.clearTimeout(timerId));
    streamFlushTimersRef.current.forEach(timerId => window.clearTimeout(timerId));
  }, []);

  const refreshModels = useCallback(async () => {
    setIsLoadingModels(true);
    try {
      const [fetchedProviders, fetchedModels] = await Promise.all([
        window.assistant.getProviders(),
        window.assistant.getModels(),
      ]);
      setProviders(fetchedProviders);
      setModels(fetchedModels);
      const currentStillValid = fetchedModels.some(m => m.id === selectedModel);
      if (!currentStillValid && fetchedModels.length > 0) {
        setSelectedModel(fetchedModels[0].id);
      } else if (fetchedModels.length === 0) {
        setSelectedModel(null);
      }
    } catch (error) {
      console.error('Failed to refresh models:', error);
      setModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  }, [selectedModel]);

  useEffect(() => {
    const loadProvidersAndModels = async () => {
      setIsLoadingModels(true);
      try {
        const [fetchedProviders, fetchedModels] = await Promise.all([
          window.assistant.getProviders(),
          window.assistant.getModels(),
        ]);
        setProviders(fetchedProviders);
        setModels(fetchedModels);
        if (fetchedModels.length > 0) {
          setSelectedModel(prev => prev ?? fetchedModels[0].id);
        }
      } catch (error) {
        console.error('Failed to load providers/models:', error);
        setModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    loadProvidersAndModels();
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadStoredData = async () => {
      const [conversationsResult, foldersResult, modelResult, providerResult, tabIdsResult, currentConvResult, draftsResult] = await Promise.allSettled([
        window.assistant.storeLoadConversationList(),
        window.assistant.storeLoadFolders(),
        window.assistant.storeLoadModel(),
        window.assistant.storeLoadProvider(),
        window.assistant.storeLoadOpenTabIds(),
        window.assistant.storeLoadCurrentConversationId(),
        window.assistant.storeLoadConversationDrafts(),
      ]);

      if (!isMounted) {
        return;
      }

      if (conversationsResult.status === 'fulfilled') {
        const storedMetadata = conversationsResult.value;
        const deserialized = storedMetadata.map(deserializeConversationMetadata);
        if (storedMetadata.length > 0) {
          const validIds = new Set(deserialized.map(c => c.id));
          const storedTabIds = tabIdsResult.status === 'fulfilled' ? tabIdsResult.value : [];
          const storedCurrentId = currentConvResult.status === 'fulfilled' ? currentConvResult.value : null;
          const filteredTabs = storedTabIds.filter((id: string) => validIds.has(id));
          const resolvedCurrentId = (storedCurrentId && validIds.has(storedCurrentId)) ? storedCurrentId : (filteredTabs.length > 0 ? filteredTabs[filteredTabs.length - 1] : deserialized[deserialized.length - 1].id);
          const warmIds = Array.from(new Set([
            resolvedCurrentId,
            ...filteredTabs,
            ...deserialized.slice(0, CONVERSATION_CACHE_LIMIT).map(c => c.id),
          ].filter((id): id is string => Boolean(id)))).slice(0, CONVERSATION_CACHE_LIMIT);
          const warmConversations = warmIds.length > 0
            ? await window.assistant.storeLoadConversationsById(warmIds)
            : [];
          const warmConversationMap = new Map(
            warmConversations.map(c => [c.id, deserializeConversation(c)])
          );
          const hydratedConversations = deserialized.map(conversation =>
            warmConversationMap.get(conversation.id) ?? conversation
          );

          warmIds.forEach((id, index) => {
            conversationAccessRef.current.set(id, Date.now() - index);
          });
          savedConversationMetadataRevisionRef.current = getConversationMetadataRevision(hydratedConversations);
          warmConversationMap.forEach(conversation => {
            savedConversationRevisionsRef.current.set(conversation.id, getConversationRevision(conversation));
          });

          setConversations(hydratedConversations);
          setCurrentConversationId(resolvedCurrentId);
          setOpenTabIds(filteredTabs.length > 0 ? filteredTabs : [resolvedCurrentId]);
        } else {
          savedConversationMetadataRevisionRef.current = getConversationMetadataRevision([]);
          setConversations([]);
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

      if (providerResult.status === 'fulfilled') {
        // Provider is derived from selected model, no separate hydration needed
      } else {
        console.error('Failed to load stored provider:', providerResult.reason);
      }

      if (draftsResult.status === 'fulfilled') {
        setConversationDrafts(draftsResult.value);
      } else {
        console.error('Failed to load stored conversation drafts:', draftsResult.reason);
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

    const metadataRevision = getConversationMetadataRevision(conversations);
    if (metadataRevision !== savedConversationMetadataRevisionRef.current) {
      savedConversationMetadataRevisionRef.current = metadataRevision;
      if (metadataSaveTimerRef.current !== null) {
        window.clearTimeout(metadataSaveTimerRef.current);
      }
      metadataSaveTimerRef.current = window.setTimeout(() => {
        metadataSaveTimerRef.current = null;
        window.assistant.storeSaveConversationList(conversations.map(serializeConversationMetadata)).catch(err => {
          console.error('Failed to save conversation metadata:', err);
        });
      }, SAVE_DEBOUNCE_MS);
    }

    conversations.forEach(conversation => {
      if (!conversation.isLoaded) {
        return;
      }

      const revision = getConversationRevision(conversation);
      if (revision === savedConversationRevisionsRef.current.get(conversation.id)) {
        return;
      }

      savedConversationRevisionsRef.current.set(conversation.id, revision);
      const existingTimer = conversationSaveTimersRef.current.get(conversation.id);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      const timerId = window.setTimeout(() => {
        conversationSaveTimersRef.current.delete(conversation.id);
        window.assistant.storeSaveConversation(serializeConversation(conversation)).catch(err => {
          console.error('Failed to save conversation:', err);
        });
      }, SAVE_DEBOUNCE_MS);
      conversationSaveTimersRef.current.set(conversation.id, timerId);
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

    setUnreadCompleteConversationIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id) && id !== currentConversationId));
      return next.size === prev.size ? prev : next;
    });
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
      const provider = getProviderForModel(models, selectedModel);
      window.assistant.storeSaveProvider(provider).catch(err => {
        console.error('Failed to save selected provider:', err);
      });
    }
  }, [selectedModel, models, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    window.assistant.storeSaveOpenTabIds(openTabIds).catch(err => {
      console.error('Failed to save open tab IDs:', err);
    });
  }, [openTabIds, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    window.assistant.storeSaveCurrentConversationId(currentConversationId).catch(err => {
      console.error('Failed to save current conversation ID:', err);
    });
  }, [currentConversationId, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
    }

    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      window.assistant.storeSaveConversationDrafts(conversationDrafts).catch(err => {
        console.error('Failed to save conversation drafts:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }, [conversationDrafts, hasHydratedStore]);

  const ensureConversationLoaded = useCallback(async (id: string) => {
    conversationAccessRef.current.set(id, Date.now());

    const alreadyLoaded = conversations.some(c => c.id === id && c.isLoaded);
    if (alreadyLoaded) {
      return;
    }

    try {
      const storedConversation = await window.assistant.storeLoadConversation(id);
      if (!storedConversation) {
        return;
      }

      const loadedConversation = deserializeConversation(storedConversation);
      savedConversationRevisionsRef.current.set(id, getConversationRevision(loadedConversation));
      setConversations(prev =>
        prev.map(conversation =>
          conversation.id === id
            ? loadedConversation
            : conversation
        )
      );
    } catch (error) {
      console.error('Failed to load conversation:', error);
    }
  }, [conversations]);

  useEffect(() => {
    if (!hasHydratedStore || !currentConversationId) {
      return;
    }

    void ensureConversationLoaded(currentConversationId);
  }, [currentConversationId, ensureConversationLoaded, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) {
      return;
    }

    const pinnedIds = new Set<string>([
      ...openTabIds,
      ...(currentConversationId ? [currentConversationId] : []),
    ]);
    const loadedConversations = conversations.filter(c => c.isLoaded);

    if (loadedConversations.length <= CONVERSATION_CACHE_LIMIT) {
      return;
    }

    const evictable = loadedConversations
      .filter(c => !pinnedIds.has(c.id) && !c.messages.some(m => m.isStreaming))
      .sort((a, b) =>
        (conversationAccessRef.current.get(a.id) ?? 0) - (conversationAccessRef.current.get(b.id) ?? 0)
      );
    const evictCount = loadedConversations.length - CONVERSATION_CACHE_LIMIT;
    const evictIds = new Set(evictable.slice(0, evictCount).map(c => c.id));

    if (evictIds.size === 0) {
      return;
    }

    setConversations(prev =>
      prev.map(conversation =>
        evictIds.has(conversation.id)
          ? { ...conversation, messages: [], isLoaded: false }
          : conversation
      )
    );
  }, [conversations, currentConversationId, hasHydratedStore, openTabIds]);

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
          setWorkspaceView('chat');
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

  const updateMessageInConversation = useCallback((
    conversationId: string | null,
    messageId: string,
    updater: (message: Message) => Message
  ) => {
    if (!conversationId) {
      return;
    }

    setConversations(prev =>
      prev.map(conversation =>
        conversation.id === conversationId
          ? {
              ...conversation,
              messages: conversation.messages.map(message =>
                message.id === messageId ? updater(message) : message
              ),
            }
          : conversation
      )
    );
  }, []);

  const unregisterStreamSession = useCallback((assistantMessageId: string) => {
    streamingSessionsRef.current.delete(assistantMessageId);
    streamChunkBuffersRef.current.delete(assistantMessageId);
    const timerId = streamFlushTimersRef.current.get(assistantMessageId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      streamFlushTimersRef.current.delete(assistantMessageId);
    }
  }, []);

  const registerStreamSession = useCallback((conversationId: string, assistantMessageId: string) => {
    streamingSessionsRef.current.set(assistantMessageId, { conversationId });
  }, []);

  const markConversationCompleteUnread = useCallback((conversationId: string) => {
    if (conversationId === currentConversationId) {
      return;
    }

    setUnreadCompleteConversationIds(prev => {
      if (prev.has(conversationId)) {
        return prev;
      }

      const next = new Set(prev);
      next.add(conversationId);
      return next;
    });
  }, [currentConversationId]);

  const flushStreamChunkBuffer = useCallback((assistantMessageId: string) => {
    const timerId = streamFlushTimersRef.current.get(assistantMessageId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      streamFlushTimersRef.current.delete(assistantMessageId);
    }

    const buffer = streamChunkBuffersRef.current.get(assistantMessageId) ?? [];
    streamChunkBuffersRef.current.delete(assistantMessageId);
    const chunk = buffer.join('');
    if (!chunk) {
      return;
    }

    const session = streamingSessionsRef.current.get(assistantMessageId);
    if (!session) {
      return;
    }

    updateMessageInConversation(
      session.conversationId,
      assistantMessageId,
      message => ({ ...message, text: message.text + chunk })
    );
  }, [updateMessageInConversation]);

  const scheduleStreamFlush = useCallback((assistantMessageId: string) => {
    if (streamFlushTimersRef.current.has(assistantMessageId)) {
      return;
    }

    const timerId = window.setTimeout(() => {
      streamFlushTimersRef.current.delete(assistantMessageId);
      flushStreamChunkBuffer(assistantMessageId);
    }, STREAM_FLUSH_MS);
    streamFlushTimersRef.current.set(assistantMessageId, timerId);
  }, [flushStreamChunkBuffer]);

  const finishStreaming = useCallback((conversationId: string, assistantMessageId: string) => {
    if (!streamingSessionsRef.current.has(assistantMessageId)) {
      return;
    }

    flushStreamChunkBuffer(assistantMessageId);
    updateMessageInConversation(
      conversationId,
      assistantMessageId,
      message => ({ ...message, isStreaming: false })
    );
    markConversationCompleteUnread(conversationId);
    unregisterStreamSession(assistantMessageId);
  }, [flushStreamChunkBuffer, markConversationCompleteUnread, unregisterStreamSession, updateMessageInConversation]);

  useEffect(() => {
    const handleChunk = (event: StreamChunkEvent) => {
      if (!streamingSessionsRef.current.has(event.assistantMessageId)) {
        return;
      }

      const buffer = streamChunkBuffersRef.current.get(event.assistantMessageId) ?? [];
      buffer.push(event.chunk);
      streamChunkBuffersRef.current.set(event.assistantMessageId, buffer);
      scheduleStreamFlush(event.assistantMessageId);
    };

    const handleDone = (event: StreamEventContext) => {
      finishStreaming(event.conversationId, event.assistantMessageId);
    };

    const handleError = (event: StreamErrorEvent) => {
      console.error('Streaming error:', event.error);
      if (!streamingSessionsRef.current.has(event.assistantMessageId)) {
        return;
      }

      flushStreamChunkBuffer(event.assistantMessageId);
      updateMessageInConversation(
        event.conversationId,
        event.assistantMessageId,
        message => ({
          ...message,
          text: `Error: ${event.error}. Make sure your selected provider is running and configured.`,
          isStreaming: false,
        })
      );
      markConversationCompleteUnread(event.conversationId);
      unregisterStreamSession(event.assistantMessageId);
    };

    const getConversationIdForMessage = (assistantMessageId: string): string | null => {
      return streamingSessionsRef.current.get(assistantMessageId)?.conversationId ?? null;
    };

    const handleSearchSources = (event: SearchSourcesEvent) => {
      const conversationId = getConversationIdForMessage(event.assistantMessageId);
      if (!conversationId) {
        return;
      }

      updateMessageInConversation(
        conversationId,
        event.assistantMessageId,
        message => {
          const currentGroups = message.searchSources ?? [];
          if (currentGroups.some(group => group.id === event.group.id)) {
            return message;
          }

          return {
            ...message,
            searchSources: [...currentGroups, event.group],
          };
        }
      );
    };

    const chunkCleanup = window.assistant.onChunk(handleChunk);
    const doneCleanup = window.assistant.onDone(handleDone);
    const errorCleanup = window.assistant.onError(handleError);
    const searchSourcesCleanup = window.assistant.onSearchSources(handleSearchSources);

    cleanupFunctionsRef.current = [chunkCleanup, doneCleanup, errorCleanup, searchSourcesCleanup];

    return () => {
      cleanupFunctionsRef.current.forEach(cleanup => cleanup());
    };
  }, [finishStreaming, flushStreamChunkBuffer, markConversationCompleteUnread, scheduleStreamFlush, unregisterStreamSession, updateMessageInConversation]);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const messages = currentConversation?.messages || [];

  useEffect(() => {
    const container = chatScrollContainerRef.current;

    const updateScrollButton = () => {
      const isStreaming = messages.some(m => m.isStreaming);
      if (!isStreaming || !container) {
        setShowScrollButton(false);
        return;
      }

      const atBottom = isScrollContainerAtBottom(container);
      if (atBottom) {
        messageListRef.current?.enableAutoScroll();
      }

      const autoScrollEnabled = messageListRef.current?.isAutoScrollEnabled() ?? true;
      setShowScrollButton(!atBottom && !autoScrollEnabled);
    };

    updateScrollButton();
    const animationFrameId = requestAnimationFrame(updateScrollButton);

    container?.addEventListener('scroll', updateScrollButton, { passive: true });
    window.addEventListener('resize', updateScrollButton);

    return () => {
      cancelAnimationFrame(animationFrameId);
      container?.removeEventListener('scroll', updateScrollButton);
      window.removeEventListener('resize', updateScrollButton);
    };
  }, [messages]);

  const generateTitleFallback = (text: string): string => {
    const words = text.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < text.split(' ').length ? '...' : '');
  };

  const handleNewChat = useCallback(() => {
    setWorkspaceView('chat');
    setCurrentConversationId(null);
    setNewChatTrigger(prev => prev + 1);
  }, []);

  const handleConversationSelect = useCallback((id: string) => {
    setWorkspaceView('chat');
    conversationAccessRef.current.set(id, Date.now());
    setCurrentConversationId(id);
    setOpenTabIds(prev => {
      if (!prev.includes(id)) {
        return [...prev, id];
      }
      return prev;
    });
    void ensureConversationLoaded(id);
  }, [ensureConversationLoaded]);

  const handleComposeChange = useCallback((value: string) => {
    const draftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
    setConversationDrafts(prev => {
      if ((prev[draftKey] ?? '') === value) {
        return prev;
      }

      const next = { ...prev };
      if (value) {
        next[draftKey] = value;
      } else {
        delete next[draftKey];
      }
      return next;
    });
  }, [currentConversationId]);

  const handleDeleteConversation = useCallback((id: string) => {
    if (!window.confirm('Delete this conversation?')) return;

    const remainingConversations = conversations.filter(c => c.id !== id);
    const nextConversationId = currentConversationId === id
      ? remainingConversations[0]?.id ?? null
      : currentConversationId;

    void window.assistant.storeDeleteConversation(id)
      .then(() => {
        conversationAccessRef.current.delete(id);
        savedConversationRevisionsRef.current.delete(id);
        const timerId = conversationSaveTimersRef.current.get(id);
        if (timerId !== undefined) {
          window.clearTimeout(timerId);
          conversationSaveTimersRef.current.delete(id);
        }
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
        deletedIds.forEach(conversationId => {
          conversationAccessRef.current.delete(conversationId);
          savedConversationRevisionsRef.current.delete(conversationId);
          const timerId = conversationSaveTimersRef.current.get(conversationId);
          if (timerId !== undefined) {
            window.clearTimeout(timerId);
            conversationSaveTimersRef.current.delete(conversationId);
          }
        });
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
      if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarOpen(prev => !prev);
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

  useEffect(() => {
    if (!window.assistant?.onMenuNewConversation) return;
    return window.assistant.onMenuNewConversation(() => handleNewChat());
  }, [handleNewChat]);

  const handleTabClose = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
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
    if (!currentConversationId) {
      return;
    }

    const conversation = conversations.find(c => c.id === currentConversationId);
    const streamingMessage = conversation?.messages.find(message => message.isStreaming);
    if (!streamingMessage) {
      return;
    }

    flushStreamChunkBuffer(streamingMessage.id);
    updateMessageInConversation(
      currentConversationId,
      streamingMessage.id,
      message => ({ ...message, isStreaming: false })
    );
    unregisterStreamSession(streamingMessage.id);

    await window.assistant.stopStream({
      conversationId: currentConversationId,
      assistantMessageId: streamingMessage.id,
    }).catch((error) => {
      console.error('Error stopping stream:', error);
    });
  }, [conversations, currentConversationId, flushStreamChunkBuffer, unregisterStreamSession, updateMessageInConversation]);

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

    const editedMessage: Message = {
      id: messageId,
      text: newText,
      sender: 'user',
      timestamp: new Date(),
      attachments: conversation.messages[messageIndex].attachments,
    };

    setConversations(prev =>
      prev.map(c =>
        c.id === currentConversationId
          ? { ...c, messages: [...conversation.messages.slice(0, messageIndex), editedMessage] }
          : c
      )
    );

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

    if (messageIndex === 0) {
      window.assistant.generateTitle(newText, selectedModel, selectedProvider)
        .then((title) => {
          setConversations(prev =>
            prev.map(c =>
              c.id === conversation.id
                ? { ...c, title }
                : c
            )
          );
        })
        .catch(() => {});
    }

    registerStreamSession(conversation.id, assistantMessageId);

    try {
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...conversation.messages.slice(0, messageIndex).map(toStreamMessage),
        toStreamMessage(editedMessage),
      ];

      await window.assistant.sendMessageStream({
        conversationId: conversation.id,
        assistantMessageId,
        model: selectedModel!,
        provider: selectedProvider,
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
                        text: `Error: ${error}. Make sure your selected provider is running and configured.`,
                        isStreaming: false,
                      }
                    : m
                ),
              }
            : c
        )
      );
      markConversationCompleteUnread(conversation.id);
      unregisterStreamSession(assistantMessageId);
    }
  }, [currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, conversations, registerStreamSession, unregisterStreamSession]);

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

    registerStreamSession(conversation.id, assistantMessageId);

    try {
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...conversation.messages.slice(0, userMessageIndex).map(toStreamMessage),
        toStreamMessage(userMessage),
      ];

      await window.assistant.sendMessageStream({
        conversationId: conversation.id,
        assistantMessageId,
        model: selectedModel!,
        provider: selectedProvider,
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
                        text: `Error: ${error instanceof Error ? error.message : 'Failed to get response from model'}. Make sure your selected provider is running and configured.`,
                        isStreaming: false,
                      }
                    : m
                ),
              }
            : c
        )
      );
      markConversationCompleteUnread(conversation.id);
      unregisterStreamSession(assistantMessageId);
    }
  }, [currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, conversations, registerStreamSession, unregisterStreamSession]);

  const handleSendMessage = useCallback(async (text: string, attachments: FileAttachment[] = []) => {
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    const draftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
    let conversationId = currentConversationId;
    let conversationMessagesForRequest = messages;
    
    if (!conversationId) {
      conversationId = Date.now().toString();
      const newConversation: Conversation = {
        id: conversationId,
        title: generateTitleFallback(text),
        timestamp: new Date(),
        messages: [],
        folderId: null,
        isLoaded: true,
      };
      setConversations(prev => [newConversation, ...prev]);
      setCurrentConversationId(conversationId);
      conversationAccessRef.current.set(conversationId, Date.now());
      
      const cid = conversationId;
      setOpenTabIds(prev => [...prev, cid]);

      window.assistant.generateTitle(text, selectedModel, selectedProvider)
        .then((title) => {
          setConversations(prev =>
            prev.map(c =>
              c.id === cid
                ? { ...c, title }
                : c
            )
          );
        })
        .catch(() => {});
    } else if (currentConversation && !currentConversation.isLoaded) {
      const storedConversation = await window.assistant.storeLoadConversation(conversationId);
      if (storedConversation) {
        const loadedConversation = deserializeConversation(storedConversation);
        conversationMessagesForRequest = loadedConversation.messages;
        savedConversationRevisionsRef.current.set(conversationId, getConversationRevision(loadedConversation));
        setConversations(prev =>
          prev.map(conversation =>
            conversation.id === conversationId
              ? loadedConversation
              : conversation
          )
        );
      }
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      text,
      sender: 'user',
      timestamp: new Date(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    setConversationDrafts(prev => {
      if (!(draftKey in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[draftKey];
      return next;
    });

    setConversations(prev =>
      prev.map(c =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, userMessage] }
          : c
      )
    );

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

    registerStreamSession(conversationId, assistantMessageId);

    try {
      const conversationMessages: SendMessageStreamRequest['messages'] = [
        ...conversationMessagesForRequest.map(toStreamMessage),
        toStreamMessage(userMessage),
      ];

      await window.assistant.sendMessageStream({
        conversationId: conversationId!,
        assistantMessageId,
        model: selectedModel!,
        provider: selectedProvider,
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
                        text: `Error: ${error instanceof Error ? error.message : 'Failed to get response from model'}. Make sure your selected provider is running and configured.`,
                        isStreaming: false,
                      }
                    : m
                ),
              }
            : c
        )
      );
      markConversationCompleteUnread(conversationId);
      unregisterStreamSession(assistantMessageId);
    }
  }, [currentConversation, currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, messages, registerStreamSession, unregisterStreamSession]);

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
  const isCurrentConversationLoading = Boolean(activeConversation && !activeConversation.isLoaded);
  const isCurrentConversationStreaming = messages.some(message => message.isStreaming);
  const composeDraftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
  const composeValue = conversationDrafts[composeDraftKey] ?? '';

  return (
    <ThemeProvider>
      <CopyNotification />
      <div className="flex flex-col h-screen w-screen bg-bg-primary">
        <TopNavbar 
          tabs={openTabs}
          activeTabId={currentConversationId}
          onTabSelect={handleConversationSelect}
          onTabClose={handleTabClose}
          onMenuClick={() => setSidebarOpen(!sidebarOpen)}
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
              isStreaming: c.messages.some(message => message.isStreaming),
              hasUnreadComplete: unreadCompleteConversationIds.has(c.id),
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
            activeWorkspace={workspaceView}
            onDictionaryOpen={() => setWorkspaceView('dictionary')}
          />
          
          <main className="relative flex flex-col flex-1 min-w-0 bg-bg-primary">
            {workspaceView === 'dictionary' ? (
              <PersonalDictionary />
            ) : <>
            <div ref={chatScrollContainerRef} className="flex flex-1 min-h-0 overflow-y-auto message-scroll-container">
              <MessageList 
                ref={messageListRef} 
                scrollContainerRef={chatScrollContainerRef}
                messages={messages} 
                isLoading={isCurrentConversationStreaming}
                editingMessageId={editingMessageId}
                onEditMessage={handleEditMessage}
                onCancelEdit={handleCancelEdit}
                onResubmitMessage={handleResubmitMessage}
                onRegenerateResponse={handleRegenerateResponse}
              />
              <MessageTrail
                messages={messages}
                scrollContainerRef={chatScrollContainerRef}
                onScrollToMessage={handleScrollToMessage}
              />
              {showScrollButton && <ScrollToBottomButton onClick={handleScrollToBottom} />}
            </div>
            
            <InputArea
              onSendMessage={handleSendMessage}
              onStopStreaming={handleStopStreaming}
              value={composeValue}
              onChange={handleComposeChange}
              isLoading={isCurrentConversationStreaming}
              disabled={!selectedModel || isCurrentConversationLoading}
              voiceTranscript={voiceTranscript}
              onVoiceTextUsed={handleVoiceTextUsed}
              voiceShortcut={voiceShortcut}
              models={models}
              selectedModel={selectedModel}
              onModelSelect={handleModelSelect}
              isLoadingModels={isLoadingModels}
              onRefreshModels={refreshModels}
              composeFocusKey={newChatTrigger}
            />
            </>}
          </main>
        </div>
      </div>
    </ThemeProvider>
  );
};

export default App;
