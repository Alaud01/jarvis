import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  Folder,
  SerializedConversationDrafts,
} from '../types';
import {
  CONVERSATION_CACHE_LIMIT,
  NEW_CHAT_DRAFT_ID,
  SAVE_DEBOUNCE_MS,
  deserializeConversation,
  deserializeConversationMetadata,
  deserializeFolder,
  getConversationMetadataRevision,
  getConversationRevision,
  getNextFolderName,
  serializeConversation,
  serializeConversationMetadata,
  serializeFolder,
} from '../utils/conversation';
import { isWorkspaceTabId } from '../utils/workspaceTabs';

export interface UseConversationsResult {
  conversations: Conversation[];
  folders: Folder[];
  currentConversationId: string | null;
  openTabIds: string[];
  conversationDrafts: SerializedConversationDrafts;
  unreadCompleteConversationIds: Set<string>;
  hasHydratedStore: boolean;
  setCurrentConversationId: (id: string | null) => void;
  setOpenTabIds: React.Dispatch<React.SetStateAction<string[]>>;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  setConversationDrafts: React.Dispatch<React.SetStateAction<SerializedConversationDrafts>>;
  setUnreadCompleteConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  ensureConversationLoaded: (id: string) => Promise<void>;
  handleComposeChange: (value: string) => void;
  handleCreateFolder: () => string;
  handleRenameFolder: (id: string, name: string) => void;
  handleDeleteFolder: (id: string) => void;
  handleMoveConversation: (conversationId: string, folderId: string | null) => void;
  handleDeleteConversation: (id: string) => void;
  newChatTrigger: number;
  triggerNewChat: () => void;
  clearConversationAccess: (id: string) => void;
}

export function useConversations(): UseConversationsResult {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  const [conversationDrafts, setConversationDrafts] = useState<SerializedConversationDrafts>({});
  const [unreadCompleteConversationIds, setUnreadCompleteConversationIds] = useState<Set<string>>(() => new Set());
  const [hasHydratedStore, setHasHydratedStore] = useState(false);
  const [newChatTrigger, setNewChatTrigger] = useState(0);

  const conversationAccessRef = useRef<Map<string, number>>(new Map());
  const savedConversationRevisionsRef = useRef<Map<string, string>>(new Map());
  const savedConversationMetadataRevisionRef = useRef<string>('');
  const metadataSaveTimerRef = useRef<number | null>(null);
  const conversationSaveTimersRef = useRef<Map<string, number>>(new Map());
  const draftSaveTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (metadataSaveTimerRef.current !== null) {
      window.clearTimeout(metadataSaveTimerRef.current);
    }
    if (draftSaveTimerRef.current !== null) {
      window.clearTimeout(draftSaveTimerRef.current);
    }
    conversationSaveTimersRef.current.forEach(timerId => window.clearTimeout(timerId));
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadStoredData = async () => {
      const [conversationsResult, foldersResult, tabIdsResult, currentConvResult, draftsResult] = await Promise.allSettled([
        window.assistant.storeLoadConversationList(),
        window.assistant.storeLoadFolders(),
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
          const filteredTabs = storedTabIds.filter((id: string) => validIds.has(id) || isWorkspaceTabId(id));
          const filteredConversationTabs = filteredTabs.filter((id: string) => validIds.has(id));
          const resolvedCurrentId = (storedCurrentId && validIds.has(storedCurrentId)) ? storedCurrentId : (filteredConversationTabs.length > 0 ? filteredConversationTabs[filteredConversationTabs.length - 1] : deserialized[deserialized.length - 1].id);
          const warmIds = Array.from(new Set([
            resolvedCurrentId,
            ...filteredConversationTabs,
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
      const filtered = prev.filter(id => validIds.has(id) || isWorkspaceTabId(id));
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

    setConversations(prev => {
      const remainingConversations = prev.filter(c => c.id !== id);
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
          setConversations(prevInner => prevInner.filter(c => c.id !== id));
          setOpenTabIds(prevTabs => {
            const filtered = prevTabs.filter(tabId => tabId !== id);
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

      return prev;
    });
  }, [currentConversationId]);

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

  const triggerNewChat = useCallback(() => {
    setCurrentConversationId(null);
    setNewChatTrigger(prev => prev + 1);
  }, []);

  const clearConversationAccess = useCallback((id: string) => {
    conversationAccessRef.current.delete(id);
    savedConversationRevisionsRef.current.delete(id);
    const timerId = conversationSaveTimersRef.current.get(id);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      conversationSaveTimersRef.current.delete(id);
    }
  }, []);

  return {
    conversations,
    folders,
    currentConversationId,
    openTabIds,
    conversationDrafts,
    unreadCompleteConversationIds,
    hasHydratedStore,
    setCurrentConversationId,
    setOpenTabIds,
    setConversations,
    setFolders,
    setConversationDrafts,
    setUnreadCompleteConversationIds,
    ensureConversationLoaded,
    handleComposeChange,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveConversation,
    handleDeleteConversation,
    newChatTrigger,
    triggerNewChat,
    clearConversationAccess,
  };
}
