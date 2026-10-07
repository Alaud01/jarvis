import { forkConversation, selectConversationVersion, getConversationVersions } from '../shared/conversationBranches';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import MessageList, { MessageListHandle } from './components/MessageList';
import InputArea from './components/InputArea';
import CopyNotification from './components/CopyNotification';
import MessageTrail from './components/MessageTrail';
import ScrollToBottomButton from './components/ScrollToBottomButton';
import VoiceSetupPanel from './components/VoiceSetupPanel';
import PersonalDictionary from './components/PersonalDictionary';
import UsageDashboard from './components/UsageDashboard';
import RecentlyDeleted from './components/RecentlyDeleted';
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
  SCROLL_KEY_DICTIONARY,
  SCROLL_KEY_USAGE,
  scrollKeyForConversation,
  visibleConversationIdForWorkspace,
} from '../shared/workspaceViews';
import type { WorkspaceView } from '../shared/workspaceViews';
import { useModels } from './hooks/useModels';
import { useReasoningEffort } from './hooks/useReasoningEffort';
import { useConversations } from './hooks/useConversations';
import { useStreaming } from './hooks/useStreaming';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useVoice } from './hooks/useVoice';
import { usePersistedScrollPosition } from './hooks/usePersistedScrollPosition';

const EMPTY_MESSAGES: Message[] = [];
const EDGE_FADE_SCROLL_DISTANCE = 32;

const App: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView | null>(null);
  const [conversationSearchTrigger, setConversationSearchTrigger] = useState(0);

  const messageListRef = useRef<MessageListHandle>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [topFadeOpacity, setTopFadeOpacity] = useState(0);
  const [bottomFadeOpacity, setBottomFadeOpacity] = useState(0);
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const overlay = composerOverlayRef.current;
    const main = overlay?.parentElement;
    if (!overlay || !main) return;
    const updateHeight = () => {
      main.style.setProperty('--composer-height', `${overlay.getBoundingClientRect().height}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [workspaceView]);

  const dictionaryScrollContainerRef = useRef<HTMLDivElement>(null);
  const usageScrollContainerRef = useRef<HTMLDivElement>(null);
  const [newChatTrigger, setNewChatTrigger] = useState(0);

  const conversationsHook = useConversations();
  const {
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
  const { selectedReasoningEffort, setSelectedReasoningEffort } = useReasoningEffort(
    models,
    selectedModel,
    hasHydratedStore,
  );

  useEffect(() => {
    if (newChatTrigger === 0) return;
    void refreshModels();
  }, [newChatTrigger, refreshModels]);

  const visibleConversationId = visibleConversationIdForWorkspace(workspaceView, currentConversationId);
  const streaming = useStreaming(conversations, visibleConversationId, setConversations, setUnreadCompleteConversationIds);
  const {
    registerStreamSession,
    handleStreamFailure,
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
  const { pendingJarvisMessageRef } = voiceHook;

  const handleVoiceTranscript = useCallback((text: string, autoSubmit: boolean, newChat: boolean) => {
    if (newChat && autoSubmit) {
      setWorkspaceView('chat');
      pendingJarvisMessageRef.current = text;
      setCurrentConversationId(null);
      setNewChatTrigger(prev => prev + 1);
    } else {
      voiceHook.onVoiceTranscript(text, autoSubmit, newChat);
    }
  }, [pendingJarvisMessageRef, setCurrentConversationId, voiceHook]);

  useEffect(() => {
    handleVoiceTranscriptRef.current = handleVoiceTranscript;
  }, [handleVoiceTranscript]);

  const currentConversation = conversations.find(c => c.id === currentConversationId);
  const messages = currentConversation?.messages ?? EMPTY_MESSAGES;
  const isCurrentConversationLoading = Boolean(currentConversation && !currentConversation.isLoaded);

  const handleNewChat = useCallback(() => {
    setWorkspaceView('chat');
    setCurrentConversationId(null);
    setNewChatTrigger(prev => prev + 1);
  }, [setCurrentConversationId]);

  useEffect(() => {
    if (!hasHydratedStore || workspaceView !== null) {
      return;
    }
    setWorkspaceView(restoredWorkspaceView);
  }, [hasHydratedStore, restoredWorkspaceView, workspaceView]);

  useEffect(() => {
    if (!hasHydratedStore || workspaceView === null) {
      return;
    }
    window.assistant.storeSaveWorkspaceView(workspaceView).catch(err => {
      console.error('Failed to save workspace view:', err);
    });
  }, [hasHydratedStore, workspaceView]);

  const chatScrollKey = workspaceView === 'chat'
    ? scrollKeyForConversation(currentConversationId)
    : null;
  const dictionaryScrollKey = workspaceView === 'dictionary' ? SCROLL_KEY_DICTIONARY : null;
  const usageScrollKey = workspaceView === 'usage' ? SCROLL_KEY_USAGE : null;
  const chatSettleRevision = `${currentConversationId ?? 'new'}:${messages.length}:${isCurrentConversationLoading ? 'loading' : 'ready'}`;

  usePersistedScrollPosition(
    chatScrollContainerRef,
    chatScrollKey,
    getScrollPosition,
    setScrollPosition,
    chatSettleRevision,
  );
  usePersistedScrollPosition(
    dictionaryScrollContainerRef,
    dictionaryScrollKey,
    getScrollPosition,
    setScrollPosition,
  );
  usePersistedScrollPosition(
    usageScrollContainerRef,
    usageScrollKey,
    getScrollPosition,
    setScrollPosition,
  );
  const handleConversationSelect = useCallback((id: string) => {
    setWorkspaceView('chat');
    setCurrentConversationId(id);
    void ensureConversationLoaded(id);
  }, [ensureConversationLoaded, setCurrentConversationId]);

  const handleWorkspaceOpen = useCallback((view: Exclude<WorkspaceView, 'chat'>) => {
    setWorkspaceView(view);
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (sidebarOpen && document.activeElement?.closest('[data-sidebar]')) {
      sidebarToggleRef.current?.focus();
    }
    setSidebarOpen(open => !open);
  }, [sidebarOpen]);

  const generateTitleFallback = (text: string): string => {
    const words = text.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < text.split(' ').length ? '...' : '');
  };

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

  const messageVersions = useMemo(() => currentConversation ? getConversationVersions(currentConversation) : undefined, [currentConversation]);

  const handleSelectVersion = useCallback((messageId: string, targetId: string) => {
    if (!canEditConversation(currentConversationId)) return;
    setEditingMessageId(null);
    setConversations(prev => prev.map(c => c.id === currentConversationId
      ? selectConversationVersion(c, messageId, targetId) : c));
  }, [canEditConversation, currentConversationId, setConversations]);

  const handleResubmitMessage = useCallback(async (messageId: string, newText: string) => {
    if (!canEditConversation(currentConversationId)) return;
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    setEditingMessageId(null);

    const conversation = conversations.find(c => c.id === currentConversationId);
    if (!conversation || conversation.messages.some(m => m.isStreaming)) return;

    const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1 || conversation.messages[messageIndex].sender !== 'user' || !newText.trim()) return;
    if (conversation.messages[messageIndex].text === newText) return;

    const editedMessage: Message = {
      id: crypto.randomUUID(),
      text: newText,
      sender: 'user',
      timestamp: new Date(),
      attachments: conversation.messages[messageIndex].attachments,
    };

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
          ? forkConversation(c, messageIndex, [editedMessage, assistantMessage])
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
        contextKey: editedMessage.id,
        model: selectedModel!,
        provider: selectedProvider,
        reasoningEffort: selectedReasoningEffort ?? undefined,
        messages: conversationMessages,
      });
    } catch (error) {
      console.error('Error sending message:', error);
      handleStreamFailure(conversation.id, assistantMessageId, error instanceof Error ? error.message : String(error));
    }
  }, [canEditConversation, currentConversationId, handleStreamFailure, selectedModel, selectedProvider, selectedReasoningEffort, conversations, registerStreamSession, setConversations]);

  const handleRegenerateResponse = useCallback(async (messageId: string) => {
    if (!canEditConversation(currentConversationId)) return;
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    const conversation = conversations.find(c => c.id === currentConversationId);
    if (!conversation || conversation.messages.some(m => m.isStreaming)) return;

    const messageIndex = conversation.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const userMessageIndex = messageIndex - 1;
    if (userMessageIndex < 0 || conversation.messages[userMessageIndex].sender !== 'user') return;

    const userMessage = conversation.messages[userMessageIndex];

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
          ? forkConversation(c, messageIndex, [assistantMessage])
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
        contextKey: assistantMessage.id,
        model: selectedModel!,
        provider: selectedProvider,
        reasoningEffort: selectedReasoningEffort ?? undefined,
        messages: conversationMessages,
      });
    } catch (error) {
      console.error('Error regenerating response:', error);
      handleStreamFailure(conversation.id, assistantMessageId, error instanceof Error ? error.message : String(error));
    }
  }, [canEditConversation, currentConversationId, handleStreamFailure, selectedModel, selectedProvider, selectedReasoningEffort, conversations, registerStreamSession, setConversations]);

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
    if (!canEditConversation(currentConversationId)) return;
    if (!selectedModel) {
      alert('Please select a model first');
      return;
    }

    const draftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
    let conversationId = currentConversationId;
    let conversationMessagesForRequest = messages;
    let contextKey = currentConversation?.branches?.contextKey;

    if (!conversationId) {
      conversationId = Date.now().toString();
      const newConversation: Conversation = {
        id: conversationId,
        title: generateTitleFallback(text),
        timestamp: new Date(),
        messages: [],
        folderId: null,
        isPinned: false,
        isLoaded: true,
      };
      setConversations(prev => [newConversation, ...prev]);
      setCurrentConversationId(conversationId);

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
      if (!canEditConversation(conversationId)) return;
      if (storedConversation) {
        const loadedConversation = deserializeConversation(storedConversation);
        conversationMessagesForRequest = loadedConversation.messages;
        contextKey = loadedConversation.branches?.contextKey;
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

    // A new turn always starts pinned to the bottom: re-enable auto-scroll for
    // the message container (fresh thinking sections follow on mount by default).
    messageListRef.current?.scrollToBottom();

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
        contextKey,
        model: selectedModel!,
        provider: selectedProvider,
        reasoningEffort: selectedReasoningEffort ?? undefined,
        messages: conversationMessages,
      });
    } catch (error) {
      console.error('Error sending message:', error);
      handleStreamFailure(conversationId!, assistantMessageId, error instanceof Error ? error.message : String(error));
    }
  }, [canEditConversation, clearConversationDraftForSend, currentConversation, currentConversationId, handleStreamFailure, selectedModel, selectedProvider, selectedReasoningEffort, messages, registerStreamSession, setConversations, setCurrentConversationId]);

  useEffect(() => {
    if (currentConversationId === null && pendingJarvisMessageRef.current) {
      const text = pendingJarvisMessageRef.current;
      pendingJarvisMessageRef.current = null;
      handleSendMessage(text);
    }
  }, [currentConversationId, newChatTrigger, handleSendMessage, pendingJarvisMessageRef]);

  useKeyboardShortcuts({
    onSearch: () => setConversationSearchTrigger(trigger => trigger + 1),
    onNewChat: handleNewChat,
    onToggleSidebar: handleSidebarToggle,
    onDeleteCurrentConversation: () => {
      if (currentConversationId) {
        handleDeleteConversation(currentConversationId);
      }
    },
    workspaceView: workspaceView ?? 'chat',
    hasCurrentConversation: Boolean(currentConversationId),
  });

  useEffect(() => {
    const container = chatScrollContainerRef.current;

    const updateChatScrollState = () => {
      setTopFadeOpacity(
        container
          ? Math.min(Math.max(container.scrollTop / EDGE_FADE_SCROLL_DISTANCE, 0), 1)
          : 0
      );
      setBottomFadeOpacity(
        container
          ? Math.min(Math.max(
              (container.scrollHeight - container.scrollTop - container.clientHeight)
                / EDGE_FADE_SCROLL_DISTANCE,
              0,
            ), 1)
          : 0
      );

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

  const isCurrentConversationStreaming = messages.some(message => message.isStreaming);
  const composeDraftKey = currentConversationId ?? NEW_CHAT_DRAFT_ID;
  const composeValue = conversationDrafts[composeDraftKey] ?? '';

  return (
    <ThemeProvider>
      <CopyNotification />
      <div className="relative flex h-screen min-h-[520px] w-screen min-w-[720px] bg-bg-primary">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-40 h-7 [-webkit-app-region:drag]"
        />
        <button
          type="button"
          className="fixed left-19 top-1 z-50 flex h-7 w-8 items-center justify-center text-text-tertiary transition-colors duration-150 hover:text-text-primary focus-visible:text-text-primary focus-visible:outline-none [-webkit-app-region:no-drag]"
          onClick={handleSidebarToggle}
          ref={sidebarToggleRef}
          title="Toggle sidebar (Cmd+B)"
          aria-label={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          aria-pressed={sidebarOpen}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>

        <Sidebar
          isOpen={sidebarOpen}
          conversations={conversations.map(c => ({
            id: c.id,
            title: c.title,
            timestamp: c.timestamp,
            folderId: c.folderId,
            isPinned: c.isPinned,
            isStreaming: c.messages.some(message => message.isStreaming),
            hasUnreadComplete: unreadCompleteConversationIds.has(c.id),
          }))}
          folders={folders}
          currentConversationId={currentConversationId}
          onConversationSelect={handleConversationSelect}
          onConversationDelete={handleDeleteConversation}
          onConversationRename={handleRenameConversation}
          onNewChat={handleNewChat}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onMoveConversation={handleMoveConversation}
          onConversationPin={handlePinConversation}
          onConversationReorder={handleReorderConversation}
          activeWorkspace={workspaceView ?? 'chat'}
          onDictionaryOpen={() => handleWorkspaceOpen('dictionary')}
          onUsageOpen={() => handleWorkspaceOpen('usage')}
          onRecentlyDeletedOpen={() => handleWorkspaceOpen('recently-deleted')}
        />

        <main className="chat-layout relative flex min-w-[360px] flex-1 flex-col bg-bg-primary">
            {(storeLoadError || (workspaceView === 'chat' && currentConversation?.loadError)) && (
              <div role="alert" className="m-4 rounded-lg border border-red-500/40 p-3 text-sm text-text-primary">
                {storeLoadError || currentConversation?.loadError}
                {!storeLoadError && currentConversationId && (
                  <button type="button" className="ml-3 underline" onClick={() => void ensureConversationLoaded(currentConversationId)}>Retry</button>
                )}
              </div>
            )}
            {workspaceView === null ? null : workspaceView === 'dictionary' ? (
              <PersonalDictionary scrollContainerRef={dictionaryScrollContainerRef} />
            ) : workspaceView === 'usage' ? (
              <UsageDashboard scrollContainerRef={usageScrollContainerRef} />
            ) : workspaceView === 'recently-deleted' ? (
              <RecentlyDeleted onRestore={handleRestoreConversation} isStoreMutationPending={isStoreMutationPending} />
            ) : <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 z-20 h-8 bg-linear-to-b from-bg-primary/70 via-bg-primary/35 to-transparent"
              style={{ opacity: topFadeOpacity }}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-linear-to-t from-bg-primary/70 via-bg-primary/35 to-transparent"
              style={{ opacity: bottomFadeOpacity }}
            />
            <div ref={chatScrollContainerRef} className="flex flex-1 min-h-0 overflow-y-auto message-scroll-container">
              <MessageTrail
                conversationId={currentConversationId}
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
                versions={messageVersions}
                onSelectVersion={handleSelectVersion}
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
            <div ref={composerOverlayRef} className="composer-overlay">
            <VoiceSetupPanel />

            <InputArea
              onSendMessage={handleSendMessage}
              onStopStreaming={handleStopStreaming}
              value={composeValue}
              onChange={handleComposeChange}
              isLoading={isCurrentConversationStreaming}
              disabled={!selectedModel || isCurrentConversationLoading || isStoreMutationPending || Boolean(storeLoadError)}
              voiceTranscript={editingMessageId ? null : voiceHook.voiceTranscript as PendingVoiceTranscript | null}
              onVoiceTextUsed={voiceHook.handleVoiceTextUsed}
              voiceShortcut={voiceHook.voiceShortcut}
              models={models}
              selectedModel={selectedModel}
              onModelSelect={handleModelSelect}
              isLoadingModels={isLoadingModels}
              onRefreshModels={refreshModels}
              selectedReasoningEffort={selectedReasoningEffort}
              onReasoningEffortSelect={setSelectedReasoningEffort}
              composeFocusKey={newChatTrigger}
            />
            </div>
            </>}
        </main>
      </div>
    </ThemeProvider>
  );
};

export default App;
