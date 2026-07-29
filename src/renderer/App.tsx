import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import HomePage from './components/HomePage';
import MessageList, { MessageListHandle } from './components/MessageList';
import InputArea from './components/InputArea';
import TopNavbar from './components/TopNavbar';
import CopyNotification from './components/CopyNotification';
import MessageTrail from './components/MessageTrail';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import VoiceSetupPanel from './components/VoiceSetupPanel';
import PersonalDictionary from './components/PersonalDictionary';
import UsageDashboard from './components/UsageDashboard';
import { ThemeProvider } from './context/ThemeContext';
import type { FileAttachment } from '../shared/attachments';
import type {
  Conversation,
  Message,
  PendingVoiceTranscript,
  SendMessageStreamRequest,
} from './types';
import {
  NEW_CHAT_DRAFT_ID,
  deserializeConversation,
  isScrollContainerAtBottom,
  toStreamMessage,
} from './utils/conversation';
import {
  DICTIONARY_TAB_ID,
  SCROLL_KEY_DICTIONARY,
  SCROLL_KEY_HOME,
  SCROLL_KEY_USAGE,
  USAGE_TAB_ID,
  isWorkspaceTabId,
  resolveLastActiveTabId,
  scrollKeyForConversation,
  visibleConversationIdForWorkspace,
  workspaceTabForView,
  workspaceViewForTab,
} from '../shared/workspaceTabs';
import type { WorkspaceView } from '../shared/workspaceTabs';
import { useModels } from './hooks/useModels';
import { useConversations } from './hooks/useConversations';
import { useStreaming } from './hooks/useStreaming';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useVoice } from './hooks/useVoice';
import { usePersistedScrollPosition } from './hooks/usePersistedScrollPosition';

const EMPTY_MESSAGES: Message[] = [];

const App: React.FC = () => {
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [conversationSearchTrigger, setConversationSearchTrigger] = useState(0);

  const messageListRef = useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showTopFade, setShowTopFade] = useState(false);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const homeScrollContainerRef = useRef<HTMLDivElement>(null);
  const dictionaryScrollContainerRef = useRef<HTMLDivElement>(null);
  const usageScrollContainerRef = useRef<HTMLDivElement>(null);
  const lastActiveTabIdRef = useRef<string | null>(null);
  const [newChatTrigger, setNewChatTrigger] = useState(0);

  const conversationsHook = useConversations();
  const {
    conversations,
    folders,
    currentConversationId,
    openTabIds,
    conversationDrafts,
    unreadCompleteConversationIds,
    restoredWorkspaceView,
    scrollPositions,
    hasHydratedStore,
    setCurrentConversationId,
    setOpenTabIds,
    setConversations,
    setConversationDrafts,
    setUnreadCompleteConversationIds,
    setScrollPosition,
    ensureConversationLoaded,
    handleComposeChange,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveConversation,
    handleDeleteConversation,
  } = conversationsHook;

  const modelsHook = useModels(hasHydratedStore);
  const {
    models,
    selectedModel,
    isLoadingModels,
    selectedProvider,
    setSelectedModel,
    refreshModels,
  } = modelsHook;

  useEffect(() => {
    return window.assistant.onModelsRefresh(() => {
      void refreshModels();
    });
  }, [refreshModels]);

  useEffect(() => {
    const refreshModelsOnFocus = () => {
      void refreshModels();
    };
    window.addEventListener('focus', refreshModelsOnFocus);
    return () => window.removeEventListener('focus', refreshModelsOnFocus);
  }, [refreshModels]);

  const visibleConversationId = visibleConversationIdForWorkspace(workspaceView, currentConversationId);
  const streaming = useStreaming(conversations, visibleConversationId, setConversations, setUnreadCompleteConversationIds);
  const {
    registerStreamSession,
    unregisterStreamSession,
    markConversationCompleteUnread,
    handleStopStreaming,
  } = streaming;

  useEffect(() => {
    if (!visibleConversationId) {
      return;
    }

    setUnreadCompleteConversationIds(prev => {
      if (!prev.has(visibleConversationId)) {
        return prev;
      }

      const next = new Set(prev);
      next.delete(visibleConversationId);
      return next;
    });
  }, [setUnreadCompleteConversationIds, visibleConversationId]);

  const handleVoiceTranscriptRef = useRef<(text: string, autoSubmit: boolean, newChat: boolean) => void>(() => {});

  const voiceHook = useVoice((text, autoSubmit, newChat) => {
    handleVoiceTranscriptRef.current(text, autoSubmit, newChat);
  });

  const handleVoiceTranscript = useCallback((text: string, autoSubmit: boolean, newChat: boolean) => {
    if (newChat && autoSubmit) {
      setWorkspaceView('chat');
      voiceHook.pendingJarvisMessageRef.current = text;
      setCurrentConversationId(null);
      setNewChatTrigger(prev => prev + 1);
    } else {
      voiceHook.onVoiceTranscript(text, autoSubmit, newChat);
    }
  }, [setCurrentConversationId, voiceHook]);

  useEffect(() => {
    handleVoiceTranscriptRef.current = handleVoiceTranscript;
  }, [handleVoiceTranscript]);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const messages = currentConversation?.messages ?? EMPTY_MESSAGES;
  const isCurrentConversationLoading = Boolean(currentConversation && !currentConversation.isLoaded);
  const validConversationIds = useMemo(() => new Set(conversations.map(c => c.id)), [conversations]);

  const handleNewChat = useCallback(() => {
    setWorkspaceView('chat');
    setCurrentConversationId(null);
    setNewChatTrigger(prev => prev + 1);
  }, [setCurrentConversationId]);

  const handleGoHome = useCallback(() => {
    const activeTabId = workspaceView === 'dictionary'
      ? DICTIONARY_TAB_ID
      : workspaceView === 'usage'
        ? USAGE_TAB_ID
        : workspaceView === 'chat'
          ? currentConversationId
          : null;

    if (activeTabId) {
      lastActiveTabIdRef.current = activeTabId;
    }
    setWorkspaceView('home');
  }, [currentConversationId, workspaceView]);

  useEffect(() => {
    if (!hasHydratedStore || workspaceView !== null) {
      return;
    }
    setWorkspaceView(restoredWorkspaceView);
  }, [hasHydratedStore, restoredWorkspaceView, workspaceView]);

  useEffect(() => {
    if (
      !hasHydratedStore
      || workspaceView !== 'home'
      || lastActiveTabIdRef.current !== null
    ) {
      return;
    }

    lastActiveTabIdRef.current = resolveLastActiveTabId({
      openTabIds,
      currentConversationId,
      validConversationIds,
    });
  }, [
    currentConversationId,
    hasHydratedStore,
    openTabIds,
    validConversationIds,
    workspaceView,
  ]);

  useEffect(() => {
    if (!hasHydratedStore || workspaceView === null) {
      return;
    }
    window.assistant.storeSaveWorkspaceView(workspaceView).catch(err => {
      console.error('Failed to save workspace view:', err);
    });
  }, [hasHydratedStore, workspaceView]);

  const getSavedScrollPosition = useCallback((key: string) => scrollPositions[key], [scrollPositions]);

  const chatScrollKey = workspaceView === 'chat'
    ? scrollKeyForConversation(currentConversationId)
    : null;
  const homeScrollKey = workspaceView === 'home' ? SCROLL_KEY_HOME : null;
  const dictionaryScrollKey = workspaceView === 'dictionary' ? SCROLL_KEY_DICTIONARY : null;
  const usageScrollKey = workspaceView === 'usage' ? SCROLL_KEY_USAGE : null;
  const chatSettleRevision = `${currentConversationId ?? 'new'}:${messages.length}:${isCurrentConversationLoading ? 'loading' : 'ready'}`;

  usePersistedScrollPosition(
    chatScrollContainerRef,
    chatScrollKey,
    getSavedScrollPosition,
    setScrollPosition,
    chatSettleRevision,
  );
  usePersistedScrollPosition(
    homeScrollContainerRef,
    homeScrollKey,
    getSavedScrollPosition,
    setScrollPosition,
  );
  usePersistedScrollPosition(
    dictionaryScrollContainerRef,
    dictionaryScrollKey,
    getSavedScrollPosition,
    setScrollPosition,
  );
  usePersistedScrollPosition(
    usageScrollContainerRef,
    usageScrollKey,
    getSavedScrollPosition,
    setScrollPosition,
  );
  const handleConversationSelect = useCallback((id: string) => {
    setWorkspaceView('chat');
    setCurrentConversationId(id);
    setOpenTabIds(prev => {
      if (!prev.includes(id)) {
        return [...prev, id];
      }
      return prev;
    });
    void ensureConversationLoaded(id);
  }, [ensureConversationLoaded, setCurrentConversationId, setOpenTabIds]);

  const handleWorkspaceOpen = useCallback((view: Exclude<WorkspaceView, 'chat' | 'home'>) => {
    const tabId = workspaceTabForView(view);
    setOpenTabIds(prev => (
      prev.includes(tabId) ? prev : [...prev, tabId]
    ));
    setWorkspaceView(view);
  }, [setOpenTabIds]);

  const handleTabSelect = useCallback((id: string) => {
    if (isWorkspaceTabId(id)) {
      handleWorkspaceOpen(workspaceViewForTab(id));
      return;
    }
    handleConversationSelect(id);
  }, [handleConversationSelect, handleWorkspaceOpen]);

  const handleToggleHome = useCallback(() => {
    if (workspaceView !== 'home') {
      handleGoHome();
      return;
    }

    const lastActiveTabId = lastActiveTabIdRef.current;
    if (lastActiveTabId && openTabIds.includes(lastActiveTabId)) {
      handleTabSelect(lastActiveTabId);
    }
  }, [handleGoHome, handleTabSelect, openTabIds, workspaceView]);

  const handleTabsReorder = useCallback((reorderedTabIds: string[]) => {
    setOpenTabIds(prev => {
      const reorderedIdSet = new Set(reorderedTabIds);
      let reorderedIndex = 0;

      return prev.map(id => (
        reorderedIdSet.has(id) ? reorderedTabIds[reorderedIndex++] : id
      ));
    });
  }, [setOpenTabIds]);

  const generateTitleFallback = (text: string): string => {
    const words = text.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < text.split(' ').length ? '...' : '');
  };

  const handleTabClose = useCallback((id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isWorkspaceTabId(id)) {
      setOpenTabIds(prev => {
        const newTabs = prev.filter(tabId => tabId !== id);
        if (workspaceView === workspaceViewForTab(id)) {
          const fallbackTabId = newTabs[newTabs.length - 1];
          if (fallbackTabId && isWorkspaceTabId(fallbackTabId)) {
            setWorkspaceView(workspaceViewForTab(fallbackTabId));
          } else if (fallbackTabId) {
            setCurrentConversationId(fallbackTabId);
            setWorkspaceView('chat');
          } else {
            setCurrentConversationId(null);
            setWorkspaceView('home');
          }
        }
        return newTabs;
      });
      return;
    }

    setOpenTabIds(prev => {
      const newTabs = prev.filter(tabId => tabId !== id);
      if (currentConversationId === id) {
        const fallbackTabId = newTabs[newTabs.length - 1];
        if (fallbackTabId && isWorkspaceTabId(fallbackTabId)) {
          setCurrentConversationId(null);
          setWorkspaceView(workspaceViewForTab(fallbackTabId));
        } else if (fallbackTabId) {
          setCurrentConversationId(fallbackTabId);
          setWorkspaceView('chat');
        } else {
          setCurrentConversationId(null);
          setWorkspaceView('home');
        }
      }
      return newTabs;
    });
  }, [currentConversationId, setCurrentConversationId, setOpenTabIds, workspaceView]);

  const handleModelSelect = useCallback((model: string) => {
    setSelectedModel(model);
  }, [setSelectedModel]);

  const handleScrollToMessage = useCallback((messageId: string, headerIndex?: number) => {
    if (headerIndex !== undefined) {
      messageListRef.current?.scrollToMessageHeader(messageId, headerIndex);
      return;
    }

    messageListRef.current?.scrollToMessage(messageId);
  }, []);

  const handleScrollToBottom = useCallback(() => {
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
  }, [currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, conversations, registerStreamSession, unregisterStreamSession, setConversations]);

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
  }, [currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, conversations, registerStreamSession, unregisterStreamSession, setConversations]);

  const clearConversationDraftForSend = useCallback((draftKey: string) => {
    setConversationDrafts(prev => {
      if (!(draftKey in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[draftKey];
      return next;
    });
  }, [setConversationDrafts]);

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
      setOpenTabIds(prev => [...prev, conversationId!]);

      window.assistant.generateTitle(text, selectedModel, selectedProvider)
        .then((title) => {
          setConversations(prev =>
            prev.map(c =>
              c.id === conversationId
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

    clearConversationDraftForSend(draftKey);

    registerStreamSession(conversationId!, assistantMessageId);

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
      markConversationCompleteUnread(conversationId!);
      unregisterStreamSession(assistantMessageId);
    }
  }, [clearConversationDraftForSend, currentConversation, currentConversationId, markConversationCompleteUnread, selectedModel, selectedProvider, messages, registerStreamSession, unregisterStreamSession, setConversations, setCurrentConversationId, setOpenTabIds]);

  useEffect(() => {
    if (currentConversationId === null && voiceHook.pendingJarvisMessageRef.current) {
      const text = voiceHook.pendingJarvisMessageRef.current;
      voiceHook.pendingJarvisMessageRef.current = null;
      handleSendMessage(text);
    }
  }, [currentConversationId, newChatTrigger, handleSendMessage, voiceHook.pendingJarvisMessageRef]);

  const openTabShortcutIds = useMemo(
    () => openTabIds.filter(id => validConversationIds.has(id) || isWorkspaceTabId(id)),
    [openTabIds, validConversationIds],
  );

  useKeyboardShortcuts({
    onSearch: () => setConversationSearchTrigger(trigger => trigger + 1),
    onNewChat: handleNewChat,
    onToggleSidebar: handleToggleHome,
    onDeleteCurrentConversation: () => {
      if (currentConversationId) {
        handleDeleteConversation(currentConversationId);
      }
    },
    tabIds: openTabShortcutIds,
    onTabSelect: handleTabSelect,
    workspaceView: workspaceView ?? 'home',
    hasCurrentConversation: Boolean(currentConversationId),
  });

  useEffect(() => {
    const container = chatScrollContainerRef.current;

    const updateChatScrollState = () => {
      setShowTopFade(Boolean(container && container.scrollTop > 1));

      const isStreaming = messages.some(m => m.isStreaming);
      if (!isStreaming || !container) {
        setShowScrollButton(false);
        return;
      }

      const atBottom = isScrollContainerAtBottom(container);
      const autoScrollEnabled = messageListRef.current?.isAutoScrollEnabled() ?? true;
      setShowScrollButton(!atBottom && !autoScrollEnabled);
    };

    updateChatScrollState();
    const animationFrameId = requestAnimationFrame(updateChatScrollState);

    container?.addEventListener('scroll', updateChatScrollState, { passive: true });
    window.addEventListener('resize', updateChatScrollState);

    return () => {
      cancelAnimationFrame(animationFrameId);
      container?.removeEventListener('scroll', updateChatScrollState);
      window.removeEventListener('resize', updateChatScrollState);
    };
  }, [currentConversationId, messages, workspaceView]);

  useEffect(() => {
    if (!hasHydratedStore || workspaceView === null) return;

    if (workspaceView === 'home') {
      return;
    }

    const currentActiveTabId = workspaceView === 'dictionary'
      ? DICTIONARY_TAB_ID
      : workspaceView === 'usage'
        ? USAGE_TAB_ID
        : currentConversationId;

    if (workspaceView === 'chat' && currentConversationId === null) {
      return;
    }

    if (currentActiveTabId && openTabIds.includes(currentActiveTabId)) {
      return;
    }

    const fallbackTabId = [...openTabIds]
      .reverse()
      .find(id => validConversationIds.has(id) || isWorkspaceTabId(id));

    if (!fallbackTabId) {
      setWorkspaceView('home');
      return;
    }

    if (isWorkspaceTabId(fallbackTabId)) {
      setCurrentConversationId(null);
      setWorkspaceView(workspaceViewForTab(fallbackTabId));
      return;
    }

    setCurrentConversationId(fallbackTabId);
    setWorkspaceView('chat');
  }, [currentConversationId, hasHydratedStore, openTabIds, setCurrentConversationId, validConversationIds, workspaceView]);

  const openTabs = openTabIds
    .filter(id => validConversationIds.has(id) || isWorkspaceTabId(id))
    .map(id => {
      if (id === DICTIONARY_TAB_ID) {
        return { id, title: 'Personal Dictionary', closable: true };
      }
      if (id === USAGE_TAB_ID) {
        return { id, title: 'Usage Dashboard', closable: true };
      }
      const convo = conversations.find(c => c.id === id);
      return {
        id,
        title: convo ? convo.title : 'New Chat',
        closable: true,
        isStreaming: Boolean(convo?.messages.some(message => message.isStreaming)),
        hasUnreadComplete: unreadCompleteConversationIds.has(id),
      };
    });
  const activeTabId = workspaceView === 'dictionary'
    ? DICTIONARY_TAB_ID
    : workspaceView === 'usage'
      ? USAGE_TAB_ID
      : workspaceView === 'home'
        ? null
        : currentConversationId;

  const isCurrentConversationStreaming = messages.some(message => message.isStreaming);
  const composeDraftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
  const composeValue = conversationDrafts[composeDraftKey] ?? '';

  return (
    <ThemeProvider>
      <CopyNotification />
      <div className="flex h-screen min-h-[520px] w-screen min-w-[720px] flex-col bg-bg-primary">
        <TopNavbar
          tabs={openTabs}
          activeTabId={activeTabId}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          onTabsReorder={handleTabsReorder}
          onNewChat={handleNewChat}
          onMenuClick={handleGoHome}
          isHomeActive={workspaceView === 'home'}
        />

        <div className="flex min-h-0 min-w-0 flex-1 bg-bg-primary">
          <main className="relative flex min-w-[360px] flex-1 flex-col bg-bg-primary">
            {workspaceView === null ? null : workspaceView === 'home' ? (
              <HomePage
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
                onDictionaryOpen={() => handleWorkspaceOpen('dictionary')}
                onUsageOpen={() => handleWorkspaceOpen('usage')}
                scrollContainerRef={homeScrollContainerRef}
              />
            ) : workspaceView === 'dictionary' ? (
              <PersonalDictionary scrollContainerRef={dictionaryScrollContainerRef} />
            ) : workspaceView === 'usage' ? (
              <UsageDashboard scrollContainerRef={usageScrollContainerRef} />
            ) : <>
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-x-0 top-0 z-20 h-8 bg-linear-to-b from-bg-primary via-bg-primary/50 to-transparent transition-opacity duration-150 ease-out ${
                showTopFade ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <div ref={chatScrollContainerRef} className="flex flex-1 min-h-0 overflow-y-auto message-scroll-container">
              <MessageTrail
                messages={messages}
                scrollContainerRef={chatScrollContainerRef}
                onScrollToMessage={handleScrollToMessage}
              />
              <MessageList
                ref={messageListRef}
                conversationId={currentConversationId}
                scrollContainerRef={chatScrollContainerRef}
                messages={messages}
                isLoading={isCurrentConversationStreaming}
                emptyStateRefreshKey={newChatTrigger}
                conversationSearchTrigger={conversationSearchTrigger}
                editingMessageId={editingMessageId}
                voiceTranscript={editingMessageId ? voiceHook.voiceTranscript : null}
                onEditMessage={handleEditMessage}
                onCancelEdit={handleCancelEdit}
                onVoiceTextUsed={voiceHook.handleVoiceTextUsed}
                onResubmitMessage={handleResubmitMessage}
                onRegenerateResponse={handleRegenerateResponse}
              />
              {showScrollButton && <ScrollToBottomButton onClick={handleScrollToBottom} />}
            </div>
            <VoiceSetupPanel />

            <InputArea
              onSendMessage={handleSendMessage}
              onStopStreaming={handleStopStreaming}
              value={composeValue}
              onChange={handleComposeChange}
              isLoading={isCurrentConversationStreaming}
              disabled={!selectedModel || isCurrentConversationLoading}
              voiceTranscript={editingMessageId ? null : voiceHook.voiceTranscript as PendingVoiceTranscript | null}
              onVoiceTextUsed={voiceHook.handleVoiceTextUsed}
              voiceShortcut={voiceHook.voiceShortcut}
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
