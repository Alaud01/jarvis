import { useCallback, useEffect, useRef } from 'react';
import type { Conversation, Message } from '../types';
import type { CompactionEvent, StreamChunkEvent, StreamErrorEvent, StreamEventContext } from '../../shared/stream';
import type { SearchSourcesEvent } from '../../shared/search';
import { STREAM_FLUSH_MS } from '../utils/conversation';

export interface UseStreamingResult {
  registerStreamSession: (conversationId: string, assistantMessageId: string) => void;
  unregisterStreamSession: (assistantMessageId: string) => void;
  flushStreamChunkBuffer: (assistantMessageId: string) => void;
  finishStreaming: (conversationId: string, assistantMessageId: string) => void;
  markConversationCompleteUnread: (conversationId: string) => void;
  updateMessageInConversation: (
    conversationId: string | null,
    messageId: string,
    updater: (message: Message) => Message
  ) => void;
  scheduleStreamFlush: (assistantMessageId: string) => void;
  handleStopStreaming: () => Promise<void>;
}

interface StreamingSession {
  conversationId: string;
}

export function useStreaming(
  conversations: Conversation[],
  currentConversationId: string | null,
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>,
  setUnreadCompleteConversationIds: React.Dispatch<React.SetStateAction<Set<string>>>,
): UseStreamingResult {
  const streamingSessionsRef = useRef<Map<string, StreamingSession>>(new Map());
  const streamChunkBuffersRef = useRef<Map<string, string[]>>(new Map());
  const streamFlushTimersRef = useRef<Map<string, number>>(new Map());

  const currentConversationIdRef = useRef<string | null>(currentConversationId);
  const conversationsRef = useRef<Conversation[]>(conversations);
  useEffect(() => {
    currentConversationIdRef.current = currentConversationId;
  }, [currentConversationId]);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

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
  }, [setConversations]);

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
    if (conversationId === currentConversationIdRef.current) {
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
  }, [setUnreadCompleteConversationIds]);

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

    const handleCompaction = (event: CompactionEvent) => {
      const conversationId = getConversationIdForMessage(event.assistantMessageId);
      if (!conversationId) return;

      updateMessageInConversation(
        conversationId,
        event.assistantMessageId,
        message => {
          const compactions = message.compactions ?? [];
          if (event.phase === 'started') {
            if (compactions.some(compaction => compaction.id === event.compactionId)) return message;
            return {
              ...message,
              compactions: [...compactions, {
                id: event.compactionId,
                status: 'in_progress',
                startedAt: new Date(event.timestamp),
              }],
            };
          }

          return {
            ...message,
            compactions: compactions.map(compaction => (
              compaction.id === event.compactionId
                ? {
                    ...compaction,
                    status: event.phase === 'completed' ? 'completed' : 'failed',
                    completedAt: new Date(event.timestamp),
                  }
                : compaction
            )),
          };
        }
      );
    };

    const chunkCleanup = window.assistant.onChunk(handleChunk);
    const doneCleanup = window.assistant.onDone(handleDone);
    const errorCleanup = window.assistant.onError(handleError);
    const searchSourcesCleanup = window.assistant.onSearchSources(handleSearchSources);
    const compactionCleanup = window.assistant.onCompaction(handleCompaction);

    return () => {
      chunkCleanup();
      doneCleanup();
      errorCleanup();
      searchSourcesCleanup();
      compactionCleanup();
    };
  }, [finishStreaming, flushStreamChunkBuffer, markConversationCompleteUnread, scheduleStreamFlush, unregisterStreamSession, updateMessageInConversation]);

  const handleStopStreaming = useCallback(async () => {
    if (!currentConversationIdRef.current) {
      return;
    }

    const conversation = conversationsRef.current.find(c => c.id === currentConversationIdRef.current);
    const streamingMessage = conversation?.messages.find(message => message.isStreaming);
    if (!streamingMessage) {
      return;
    }

    flushStreamChunkBuffer(streamingMessage.id);
    updateMessageInConversation(
      currentConversationIdRef.current,
      streamingMessage.id,
      message => ({ ...message, isStreaming: false })
    );
    unregisterStreamSession(streamingMessage.id);

    await window.assistant.stopStream({
      conversationId: currentConversationIdRef.current,
      assistantMessageId: streamingMessage.id,
    }).catch((error) => {
      console.error('Error stopping stream:', error);
    });
  }, [flushStreamChunkBuffer, unregisterStreamSession, updateMessageInConversation]);

  return {
    registerStreamSession,
    unregisterStreamSession,
    flushStreamChunkBuffer,
    finishStreaming,
    markConversationCompleteUnread,
    updateMessageInConversation,
    scheduleStreamFlush,
    handleStopStreaming,
  };
}
