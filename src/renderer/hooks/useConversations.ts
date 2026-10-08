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
import { SaveQueue } from '../../shared/saveQueue';
import { resolveWorkspaceView } from '../../shared/workspaceViews';
import { folderDeletionMessage } from '../../shared/folderDeletion';
import type { WorkspaceView } from '../../shared/workspaceViews';

export interface UseConversationsResult {
  conversations: Conversation[];
  folders: Folder[];
  currentConversationId: string | null;
  conversationDrafts: SerializedConversationDrafts;
  unreadCompleteConversationIds: Set<string>;
  restoredWorkspaceView: WorkspaceView;
  hasHydratedStore: boolean;
  storeLoadError: string | null;
  setCurrentConversationId: (id: string | null) => void;
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  setConversationDrafts: React.Dispatch<React.SetStateAction<SerializedConversationDrafts>>;
  setUnreadCompleteConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  getScrollPosition: (key: string) => number | undefined;
  setScrollPosition: (key: string, top: number) => void;
  ensureConversationLoaded: (id: string) => Promise<void>;
  handleComposeChange: (value: string) => void;
  handleCreateFolder: () => string;
  handleRenameFolder: (id: string, name: string) => void;
  handleDeleteFolder: (id: string) => void;
  handleMoveConversation: (conversationId: string, folderId: string | null) => void;
  handlePinConversation: (conversationId: string, isPinned: boolean) => void;
  handleReorderConversation: (
    conversationId: string,
    targetConversationId: string,
    placement: 'before' | 'after',
  ) => void;
  handleRenameConversation: (id: string, title: string) => void;
  handleDeleteConversation: (id: string) => void;
  handleRestoreConversation: (id: string) => Promise<void>;
  isStoreMutationPending: boolean;
  canEditConversation: (id: string | null) => boolean;
  newChatTrigger: number;
  triggerNewChat: () => void;
  clearConversationAccess: (id: string) => void;
}

export function useConversations(): UseConversationsResult {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [conversationDrafts, setConversationDrafts] = useState<SerializedConversationDrafts>({});
  const [unreadCompleteConversationIds, setUnreadCompleteConversationIds] = useState<Set<string>>(() => new Set());
  const [restoredWorkspaceView, setRestoredWorkspaceView] = useState<WorkspaceView>('chat');
  const [hasHydratedStore, setHasHydratedStore] = useState(false);
  const [storeLoadError, setStoreLoadError] = useState<string | null>(null);
  const [newChatTrigger, setNewChatTrigger] = useState(0);

  const conversationAccessRef = useRef<Map<string, number>>(new Map());
  const savedStreamingSnapshotsRef = useRef<Map<string, string>>(new Map());
  const [saveQueue] = useState(() => new SaveQueue(SAVE_DEBOUNCE_MS, (key, error) => {
    console.error(`Failed to save ${key}; retaining snapshot for retry:`, error);
  }));
  const deletingIdsRef = useRef(new Set<string>());
  const committedDeletionIdsRef = useRef(new Set<string>());
  const storeSyncFailedRef = useRef(false);
  const loadingIdsRef = useRef(new Map<string, symbol>());
  const storeMutationRef = useRef(false);
  const [isStoreMutationPending, setIsStoreMutationPending] = useState(false);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const scrollPositionsRef = useRef<Record<string, number>>({});
  const scrollPositionsDirtyRef = useRef(false);
  const latestSaveStateRef = useRef({ conversations, hasHydratedStore });

  useEffect(() => {
    latestSaveStateRef.current = { conversations, hasHydratedStore };
  }, [conversations, hasHydratedStore]);

  const flushScrollPositions = useCallback(() => {
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = null;
    }
    if (!scrollPositionsDirtyRef.current) {
      return;
    }

    const positionsToSave = scrollPositionsRef.current;
    scrollPositionsDirtyRef.current = false;
    window.assistant.storeSaveScrollPositions(positionsToSave).catch(err => {
      if (scrollPositionsRef.current === positionsToSave) {
        scrollPositionsDirtyRef.current = true;
      }
      console.error('Failed to save scroll positions:', err);
    });
  }, []);

  useEffect(() => {
    const flush = () => {
      flushScrollPositions();
      void saveQueue.flush().catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    const cleanup = window.assistant.onBeforeQuit(async () => {
      flushScrollPositions();
      // Streaming intentionally skips intermediate disk writes. Capture the
      // latest rendered transcript before acknowledging a normal quit.
      const latest = latestSaveStateRef.current;
      if (latest.hasHydratedStore) {
        for (const conversation of latest.conversations) {
          if (!conversation.isLoaded || deletingIdsRef.current.has(conversation.id)) continue;
          saveQueue.schedule(conversation.id, getConversationRevision(conversation), () => (
            window.assistant.storeSaveConversation(serializeConversation(conversation))
          ));
        }
      }
      await saveQueue.flush();
    });
    return () => {
      window.removeEventListener('pagehide', flush);
      cleanup();
      flush();
    };
  }, [flushScrollPositions, saveQueue]);

  useEffect(() => {
    let isMounted = true;

    const loadStoredData = async () => {
      const [
        conversationsResult,
        foldersResult,
        currentConvResult,
        draftsResult,
        workspaceViewResult,
        scrollPositionsResult,
      ] = await Promise.allSettled([
        window.assistant.storeLoadConversationList(),
        window.assistant.storeLoadFolders(),
        window.assistant.storeLoadCurrentConversationId(),
        window.assistant.storeLoadConversationDrafts(),
        window.assistant.storeLoadWorkspaceView(),
        window.assistant.storeLoadScrollPositions(),
      ]);

      if (!isMounted) {
        return;
      }

      if (conversationsResult.status === 'fulfilled') {
        const storedMetadata = conversationsResult.value;
        const deserialized = storedMetadata.map(deserializeConversationMetadata);
        if (storedMetadata.length > 0) {
          const validIds = new Set(deserialized.map(c => c.id));
          const storedCurrentId = currentConvResult.status === 'fulfilled' ? currentConvResult.value : null;
          const resolvedCurrentId = storedCurrentId && validIds.has(storedCurrentId)
            ? storedCurrentId
            : deserialized[deserialized.length - 1].id;
          const warmIds = Array.from(new Set([
            resolvedCurrentId,
            ...deserialized.slice(0, CONVERSATION_CACHE_LIMIT).map(c => c.id),
          ].filter((id): id is string => Boolean(id)))).slice(0, CONVERSATION_CACHE_LIMIT);
          const warmResults = await Promise.allSettled(warmIds.map(id => window.assistant.storeLoadConversation(id)));
          if (!isMounted) return;
          const failedWarmIds = new Set<string>();
          const warmConversations = warmResults.flatMap((result, index) => {
            if (result.status === 'fulfilled') return result.value ? [result.value] : [];
            failedWarmIds.add(warmIds[index]);
            console.error('Failed to load conversation:', result.reason);
            return [];
          });
          const warmConversationMap = new Map(
            warmConversations.map(c => [c.id, deserializeConversation(c)])
          );
          const hydratedConversations = deserialized.map(conversation => {
            const warmConversation = warmConversationMap.get(conversation.id);
            return warmConversation
              ? {
                  ...warmConversation,
                  folderId: conversation.folderId,
                  isPinned: conversation.isPinned,
                }
              : failedWarmIds.has(conversation.id)
                ? { ...conversation, loadError: 'This conversation could not be loaded. Its stored history has been preserved.' }
                : conversation;
          });

          warmIds.forEach((id, index) => {
            conversationAccessRef.current.set(id, Date.now() - index);
          });
          saveQueue.seed('metadata', getConversationMetadataRevision(hydratedConversations));
          warmConversationMap.forEach(conversation => {
            saveQueue.seed(conversation.id, getConversationRevision(conversation));
          });

          setConversations(hydratedConversations);
          setCurrentConversationId(resolvedCurrentId);
        } else {
          saveQueue.seed('metadata', getConversationMetadataRevision([]));
          setConversations([]);
          setCurrentConversationId(null);
        }
      } else {
        console.error('Failed to load stored conversations:', conversationsResult.reason);
        setStoreLoadError('Your conversation list could not be loaded. Restart Jarvis to retry. Existing conversations have been preserved.');
        // An empty renderer must never overwrite a list that failed to load.
        return;
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

      const storedWorkspaceView = workspaceViewResult.status === 'fulfilled'
        ? workspaceViewResult.value
        : 'chat';
      if (workspaceViewResult.status === 'rejected') {
        console.error('Failed to load stored workspace view:', workspaceViewResult.reason);
      }

      setRestoredWorkspaceView(resolveWorkspaceView(storedWorkspaceView));

      if (scrollPositionsResult.status === 'fulfilled') {
        scrollPositionsRef.current = scrollPositionsResult.value;
      } else {
        console.error('Failed to load stored scroll positions:', scrollPositionsResult.reason);
      }

      setHasHydratedStore(true);
    };

    void loadStoredData();

    return () => {
      isMounted = false;
    };
  }, [saveQueue]);

  useEffect(() => {
    if (!hasHydratedStore) {
      return;
    }

    if (!storeMutationRef.current) {
      const metadata = conversations.filter(c => !deletingIdsRef.current.has(c.id));
      saveQueue.schedule('metadata', getConversationMetadataRevision(metadata), () => (
        window.assistant.storeSaveConversationList(metadata.map(serializeConversationMetadata))
      ));
    }

    conversations.forEach(conversation => {
      if (!conversation.isLoaded || deletingIdsRef.current.has(conversation.id)) {
        return;
      }

      const streamingMessage = conversation.messages.find(message => message.isStreaming);
      if (streamingMessage) {
        // Save the initial transcript before waiting for generation; avoid hashing and
        // writing the transcript on every streamed token.
        if (savedStreamingSnapshotsRef.current.get(conversation.id) === streamingMessage.id) return;
        savedStreamingSnapshotsRef.current.set(conversation.id, streamingMessage.id);
      } else {
        savedStreamingSnapshotsRef.current.delete(conversation.id);
      }

      saveQueue.schedule(conversation.id, getConversationRevision(conversation), () => (
        window.assistant.storeSaveConversation(serializeConversation(conversation))
      ));
    });
  }, [conversations, hasHydratedStore, isStoreMutationPending, saveQueue]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    const validIds = new Set(conversations.map(c => c.id));

    if (currentConversationId && !validIds.has(currentConversationId)) {
      setCurrentConversationId(conversations[0]?.id ?? null);
    }

    setUnreadCompleteConversationIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [conversations, currentConversationId, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore || storeMutationRef.current) return;

    const serialized = folders.map(serializeFolder);
    saveQueue.schedule('folders', JSON.stringify(serialized), () => window.assistant.storeSaveFolders(serialized));
  }, [folders, hasHydratedStore, isStoreMutationPending, saveQueue]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    window.assistant.storeSaveCurrentConversationId(currentConversationId).catch(err => {
      console.error('Failed to save current conversation ID:', err);
    });
  }, [currentConversationId, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) return;

    saveQueue.schedule('drafts', JSON.stringify(conversationDrafts), () => (
      window.assistant.storeSaveConversationDrafts(conversationDrafts)
    ));
  }, [conversationDrafts, hasHydratedStore, saveQueue]);

  const ensureConversationLoaded = useCallback(async (id: string) => {
    conversationAccessRef.current.set(id, Date.now());

    const alreadyLoaded = conversations.some(c => c.id === id && c.isLoaded);
    if (alreadyLoaded || loadingIdsRef.current.has(id) || deletingIdsRef.current.has(id)) {
      return;
    }

    const loadToken = Symbol(id);
    loadingIdsRef.current.set(id, loadToken);
    try {
      const storedConversation = await window.assistant.storeLoadConversation(id);
      if (!storedConversation || loadingIdsRef.current.get(id) !== loadToken || deletingIdsRef.current.has(id)) {
        return;
      }

      const loadedConversation = deserializeConversation(storedConversation);
      saveQueue.seed(id, getConversationRevision(loadedConversation));
      setConversations(prev =>
        prev.map(conversation =>
          conversation.id === id
            ? {
                ...loadedConversation,
                title: conversation.title,
                timestamp: conversation.timestamp,
                folderId: conversation.folderId,
                isPinned: conversation.isPinned,
                loadError: undefined,
              }
            : conversation
        )
      );
    } catch (error) {
      if (loadingIdsRef.current.get(id) !== loadToken) return;
      console.error('Failed to load conversation:', error);
      setConversations(prev => prev.map(c => c.id === id ? {
        ...c, loadError: 'This conversation could not be loaded. Its stored history has been preserved.',
      } : c));
    } finally {
      if (loadingIdsRef.current.get(id) === loadToken) loadingIdsRef.current.delete(id);
    }
  }, [conversations, saveQueue]);

  useEffect(() => {
    if (!hasHydratedStore || !currentConversationId || conversations.find(c => c.id === currentConversationId)?.loadError) {
      return;
    }

    void ensureConversationLoaded(currentConversationId);
  }, [conversations, currentConversationId, ensureConversationLoaded, hasHydratedStore]);

  useEffect(() => {
    if (!hasHydratedStore) {
      return;
    }

    const pinnedIds = new Set<string>(currentConversationId ? [currentConversationId] : []);
    const loadedConversations = conversations.filter(c => c.isLoaded);

    if (loadedConversations.length <= CONVERSATION_CACHE_LIMIT) {
      return;
    }

    const evictable = loadedConversations
      .filter(c => !pinnedIds.has(c.id) && !deletingIdsRef.current.has(c.id) && !saveQueue.hasPending(c.id) && !c.messages.some(m => m.isStreaming))
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
          ? { ...conversation, messages: [], branches: undefined, isLoaded: false }
          : conversation
      )
    );
  }, [conversations, currentConversationId, hasHydratedStore, saveQueue]);

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

  const canEditConversation = useCallback((id: string | null) => (
    hasHydratedStore && !storeSyncFailedRef.current && !storeMutationRef.current && (!id || !deletingIdsRef.current.has(id))
  ), [hasHydratedStore]);

  const runStoreMutation = useCallback(async (write: () => Promise<void>) => {
    if (!hasHydratedStore || storeMutationRef.current) throw new Error('Please wait for the current operation to finish.');
    storeMutationRef.current = true;
    setIsStoreMutationPending(true);
    let mutationStarted = false;
    try {
      // Drain in-flight metadata before changing store membership. Scheduling stays
      // paused until the renderer has merged the result of this operation.
      await saveQueue.flush();
      mutationStarted = true;
      await write();
    } catch (error) {
      if (mutationStarted) {
        // A durable deletion/restore may precede a failing index write. Read
        // authoritative membership before allowing the renderer to edit again.
        try {
          const [metadata, storedFolders] = await Promise.all([
            window.assistant.storeLoadConversationList(),
            window.assistant.storeLoadFolders(),
          ]);
          const activeIds = new Set(metadata.map(entry => entry.id));
          for (const conversation of latestSaveStateRef.current.conversations) {
            if (activeIds.has(conversation.id)) continue;
            committedDeletionIdsRef.current.add(conversation.id);
            deletingIdsRef.current.add(conversation.id);
            loadingIdsRef.current.delete(conversation.id);
            saveQueue.cancel(conversation.id);
          }
          setConversations(prev => {
            const existingIds = new Set(prev.map(conversation => conversation.id));
            return [
              ...prev.filter(conversation => activeIds.has(conversation.id)),
              ...metadata.filter(entry => !existingIds.has(entry.id)).map(deserializeConversationMetadata),
            ];
          });
          setFolders(storedFolders.map(deserializeFolder));
        } catch (reconcileError) {
          storeSyncFailedRef.current = true;
          setHasHydratedStore(false);
          setStoreLoadError('Conversation storage could not be reconciled. Restart Jarvis to retry. Existing histories have been preserved.');
          console.error('Failed to reconcile conversation storage:', reconcileError);
        }
      }
      throw error;
    } finally {
      storeMutationRef.current = false;
      setIsStoreMutationPending(false);
    }
  }, [hasHydratedStore, saveQueue]);

  const handleRestoreConversation = useCallback(async (id: string) => {
    await runStoreMutation(async () => {
      const restored = deserializeConversation(await window.assistant.storeRestoreConversation(id));
      loadingIdsRef.current.delete(id);
      deletingIdsRef.current.delete(restored.id);
      committedDeletionIdsRef.current.delete(restored.id);
      saveQueue.seed(restored.id, getConversationRevision(restored));
      setConversations(prev => prev.some(c => c.id === restored.id) ? prev : [restored, ...prev]);
    });
  }, [runStoreMutation, saveQueue]);

  const handleDeleteConversation = useCallback((id: string) => {
    const conversation = conversations.find(c => c.id === id);
    if (!conversation || !canEditConversation(id)) return;
    if (conversation.messages.some(m => m.isStreaming)) {
      window.alert('Stop the response before deleting this conversation.');
      return;
    }
    if (!window.confirm('Delete this conversation? You can restore it from Recently Deleted for 30 days.')) return;
    deletingIdsRef.current.add(id);
    loadingIdsRef.current.delete(id);
    void runStoreMutation(async () => {
      // The last render may not have reached the debounced save effect yet.
      await window.assistant.storeSaveConversationList(conversations.map(serializeConversationMetadata));
      if (conversation.isLoaded) await window.assistant.storeSaveConversation(serializeConversation(conversation));
      const result = await window.assistant.storeDeleteConversation(id);
      if (!result.success) throw new Error('Deletion failed');
      saveQueue.cancel(id);
      conversationAccessRef.current.delete(id);
      savedStreamingSnapshotsRef.current.delete(id);
      setConversations(prev => prev.filter(c => c.id !== id));
    })
      .catch(err => {
        if (!committedDeletionIdsRef.current.has(id)) deletingIdsRef.current.delete(id);
        setConversations(prev => [...prev]);
        console.error('Failed to delete conversation from store:', err);
        window.alert('Failed to delete conversation. Please try again.');
      });
  }, [canEditConversation, conversations, runStoreMutation, saveQueue]);

  const handleCreateFolder = useCallback(() => {
    if (!canEditConversation(null)) return '';
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      name: getNextFolderName(folders),
      timestamp: new Date(),
    };
    setFolders(prev => [newFolder, ...prev]);
    return newFolder.id;
  }, [canEditConversation, folders]);

  const handleRenameFolder = useCallback((id: string, name: string) => {
    if (!canEditConversation(null)) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setFolders(prev => prev.map(f => f.id === id ? { ...f, name: trimmedName } : f));
  }, [canEditConversation]);

  const handleDeleteFolder = useCallback((id: string) => {
    const folder = folders.find(f => f.id === id);
    if (!folder) return;
    const convosInFolder = conversations.filter(c => c.folderId === id);
    if (!canEditConversation(null)) return;
    if (convosInFolder.some(c => c.messages.some(m => m.isStreaming))) {
      window.alert('Stop all responses in this folder before deleting it.');
      return;
    }
    const deletedIds = new Set(convosInFolder.map(c => c.id));
    if (!window.confirm(folderDeletionMessage(folder.name, convosInFolder))) return;

    const remainingConversations = conversations.filter(c => c.folderId !== id);
    const nextConversationId = currentConversationId && deletedIds.has(currentConversationId)
      ? remainingConversations[0]?.id ?? null
      : currentConversationId;

    deletedIds.forEach(conversationId => {
      deletingIdsRef.current.add(conversationId);
      loadingIdsRef.current.delete(conversationId);
    });
    void runStoreMutation(async () => {
      await window.assistant.storeSaveConversationList(conversations.map(serializeConversationMetadata));
      for (const conversation of convosInFolder) {
        if (conversation.isLoaded) await window.assistant.storeSaveConversation(serializeConversation(conversation));
      }
      const result = await window.assistant.storeDeleteFolder(id);
      if (!result.success) throw new Error('Folder deletion failed');
      deletedIds.forEach(conversationId => saveQueue.cancel(conversationId));
      deletedIds.forEach(conversationId => {
        conversationAccessRef.current.delete(conversationId);
        savedStreamingSnapshotsRef.current.delete(conversationId);
      });
      setConversations(prev => prev.filter(c => !deletedIds.has(c.id)));
      setFolders(prev => prev.filter(f => f.id !== id));
      setCurrentConversationId(prev => prev && deletedIds.has(prev) ? nextConversationId : prev);
    })
      .catch(err => {
        deletedIds.forEach(conversationId => {
          if (!committedDeletionIdsRef.current.has(conversationId)) deletingIdsRef.current.delete(conversationId);
        });
        setConversations(prev => [...prev]);
        console.error('Failed to delete folder from store:', err);
        window.alert('Failed to delete folder. Please try again.');
      });
  }, [folders, conversations, currentConversationId, canEditConversation, runStoreMutation, saveQueue]);

  const handleMoveConversation = useCallback((conversationId: string, folderId: string | null) => {
    if (!canEditConversation(conversationId)) return;
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, folderId } : c
    ));
  }, [canEditConversation]);

  const handlePinConversation = useCallback((conversationId: string, isPinned: boolean) => {
    if (!canEditConversation(conversationId)) return;
    setConversations(prev => prev.map(conversation =>
      conversation.id === conversationId
        ? { ...conversation, isPinned }
        : conversation
    ));
  }, [canEditConversation]);

  const handleReorderConversation = useCallback((
    conversationId: string,
    targetConversationId: string,
    placement: 'before' | 'after',
  ) => {
    if (!canEditConversation(conversationId) || !canEditConversation(targetConversationId)) return;
    if (conversationId === targetConversationId) {
      return;
    }

    setConversations(prev => {
      const source = prev.find(conversation => conversation.id === conversationId);
      const target = prev.find(conversation => conversation.id === targetConversationId);
      if (!source || !target) {
        return prev;
      }

      const remaining = prev.filter(conversation => conversation.id !== conversationId);
      const targetIndex = remaining.findIndex(conversation => conversation.id === targetConversationId);
      const repositioned = {
        ...source,
        folderId: target.isPinned ? source.folderId : target.folderId,
        isPinned: target.isPinned,
      };
      remaining.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, repositioned);
      return remaining;
    });
  }, [canEditConversation]);

  const handleRenameConversation = useCallback((id: string, title: string) => {
    if (!canEditConversation(id)) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return;
    }

    setConversations(prev => prev.map(c => c.id === id ? { ...c, title: trimmedTitle } : c));
  }, [canEditConversation]);

  const triggerNewChat = useCallback(() => {
    setCurrentConversationId(null);
    setNewChatTrigger(prev => prev + 1);
  }, []);

  const clearConversationAccess = useCallback((id: string) => {
    conversationAccessRef.current.delete(id);
    saveQueue.cancel(id);
  }, [saveQueue]);

  const getScrollPosition = useCallback((key: string) => (
    scrollPositionsRef.current[key]
  ), []);

  const setScrollPosition = useCallback((key: string, top: number) => {
    const nextTop = Math.max(0, top);
    const currentTop = scrollPositionsRef.current[key];
    if (currentTop === nextTop) {
      return;
    }

    const nextPositions = {
      ...scrollPositionsRef.current,
      [key]: nextTop,
    };
    scrollPositionsRef.current = nextPositions;

    if (!hasHydratedStore) {
      return;
    }

    scrollPositionsDirtyRef.current = true;
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
    }
    scrollSaveTimerRef.current = window.setTimeout(flushScrollPositions, SAVE_DEBOUNCE_MS);
  }, [flushScrollPositions, hasHydratedStore]);

  return {
    conversations,
    folders,
    currentConversationId,
    conversationDrafts,
    unreadCompleteConversationIds,
    restoredWorkspaceView,
    hasHydratedStore,
    storeLoadError,
    setCurrentConversationId,
    setConversations,
    setFolders,
    setConversationDrafts,
    setUnreadCompleteConversationIds,
    getScrollPosition,
    setScrollPosition,
    ensureConversationLoaded,
    handleComposeChange,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveConversation,
    handlePinConversation,
    handleReorderConversation,
    handleRenameConversation,
    handleDeleteConversation,
    handleRestoreConversation,
    isStoreMutationPending,
    canEditConversation,
    newChatTrigger,
    triggerNewChat,
    clearConversationAccess,
  };
}
