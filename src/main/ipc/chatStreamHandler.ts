import { ipcMain } from 'electron';
import type { CompactionEvent, StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../../shared/stream';
import type { SearchSourcesEvent } from '../../shared/search';
import { getCachedModel, getProvider } from '../providers/registry';
import type { ChatMessage, StreamChunk, ToolExecutionResult } from '../providers/types';
import { hasToolImages, isImageInputUnsupportedError, stripToolImages, toToolImageFields } from '../providers/toolImages';
import { compactMessagesIfNeeded, estimateTotalTokens, getContextThresholdTokens } from '../contextCompaction';
import { closeBrowserControl } from '../browserControlService';
import {
  buildSystemPrompt,
} from '../systemPrompt';
import {
  getChatTools,
  BROWSER_CONTROL_TOOL_NAMES,
  MAX_TAVILY_SEARCH_CALLS_PER_TURN,
  MAX_FETCH_URL_CALLS_PER_TURN,
  MAX_NOTION_CALLS_PER_TURN,
} from '../tools/chatTools';
import {
  buildToolResultSynthesisMessages,
  createSearchSourceGroup,
  formatBrowserControlResult,
  formatFetchToolResult,
  formatTavilySearchToolResult,
  isAbortLikeError,
  parseFetchToolArgs,
  parseTavilySearchToolArgs,
  parseToolArgumentsObject,
  requiresToolResultSynthesis,
  runBrowserControlTool,
} from '../tools/dispatcher';
import { executeNotionMcpTool, isNotionToolName } from '../notionMcpService';
import { tavilySearch } from '../tavilySearchService';
import { fetchUrlContent } from '../fetchService';
import { logMainProcess, CHAT_MODEL_KEEP_ALIVE } from '../app/lifecycle';
import { recordResolvedTurnUsage } from '../usageService';
import { MAX_TURN_DURATION_MS, TOOL_BUDGET_MESSAGE, TurnBudget } from '../tools/turnBudget';

// Truncated previews keep model output and tool calls readable in Jarvis logs.
const LOG_PREVIEW_CHARS = 500;

function truncateForLog(value: unknown, limit: number = LOG_PREVIEW_CHARS): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  if (limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  contextKey?: string;
  model: string;
  provider: string;
  reasoningEffort?: string;
  messages: ChatMessage[];
}

export function registerChatStreamHandler(activeStreams: Map<string, AbortController>): void {
  ipcMain.handle('send-message-stream', async (event, request: SendMessageStreamRequest) => {
    let flushThinkingConsoleBuffer = (_reason: string) => undefined;
    let closeThinkingSection = (_reason: string) => undefined;
    const streamKey = request.assistantMessageId;
    const streamContext: StreamEventContext = {
      conversationId: request.conversationId,
      assistantMessageId: request.assistantMessageId,
    };
    const activeCompactionIds = new Set<string>();
    let budgetStopMessage: string | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const sendToRenderer = (channel: string, ...args: unknown[]) => {
      try {
        if (!event.sender.isDestroyed()) {
          event.sender.send(channel, ...args);
        } else {
          activeStreams.get(streamKey)?.abort();
        }
      } catch {
        activeStreams.get(streamKey)?.abort();
      }
    };

    const beginCompaction = (): string => {
      const compactionId = `${request.assistantMessageId}-${Date.now()}-${activeCompactionIds.size}`;
      activeCompactionIds.add(compactionId);
      const payload: CompactionEvent = {
        ...streamContext,
        compactionId,
        phase: 'started',
        timestamp: new Date().toISOString(),
      };
      sendToRenderer('context-compaction', payload);
      return compactionId;
    };

    const finishCompaction = (compactionId: string, phase: 'completed' | 'failed') => {
      if (!activeCompactionIds.delete(compactionId)) return;
      const payload: CompactionEvent = {
        ...streamContext,
        compactionId,
        phase,
        timestamp: new Date().toISOString(),
      };
      sendToRenderer('context-compaction', payload);
    };

    try {
      const abortController = new AbortController();
      activeStreams.set(streamKey, abortController);
      const budget = new TurnBudget();
      deadlineTimer = setTimeout(() => {
        budgetStopMessage = 'This response reached its time limit. You can continue from the results above.';
        abortController.abort();
      }, MAX_TURN_DURATION_MS);
      let inThinking = false;
      let thinkingConsoleBuffer = '';

      const sendChatChunk = (chunk: string) => {
        const payload: StreamChunkEvent = { ...streamContext, chunk };
        sendToRenderer('ollama-chunk', payload);
      };

      const provider = getProvider(request.provider);
      if (!provider) {
        throw new Error(`Unknown provider: ${request.provider}`);
      }

      flushThinkingConsoleBuffer = (reason: string) => {
        const normalizedThinking = thinkingConsoleBuffer.trim();
        if (!normalizedThinking) {
          thinkingConsoleBuffer = '';
          return;
        }

        logMainProcess(
          'LLM',
          `Thinking block (${reason})\n${normalizedThinking}`,
          {
            conversationId: request.conversationId,
            model: request.model,
            characters: normalizedThinking.length,
          }
        );
        thinkingConsoleBuffer = '';
      };

      const emitStreamChunk = (chunk: StreamChunk) => {
        if (chunk.type === 'thinking') {
          if (!inThinking) {
            sendChatChunk('Thinking...\n');
            inThinking = true;
          }
          thinkingConsoleBuffer += chunk.content;
          sendChatChunk(chunk.content);
          return;
        }

        if (inThinking) {
          flushThinkingConsoleBuffer('before-content');
          sendChatChunk('\n...done thinking.\n');
          inThinking = false;
        }

        sendChatChunk(chunk.content);
      };

      closeThinkingSection = (reason: string) => {
        if (!inThinking) {
          flushThinkingConsoleBuffer(reason);
          return;
        }

        flushThinkingConsoleBuffer(reason);
        sendChatChunk('\n...done thinking.\n');
        inThinking = false;
      };

      const baseMessages: ChatMessage[] = [
        await buildSystemPrompt(request.conversationId),
        ...request.messages,
      ];
      const chatTools = getChatTools();
      let tavilySearchCallsThisTurn = 0;
      let fetchUrlCallsThisTurn = 0;
      let notionCallsThisTurn = 0;

      const selectedModelInfo = getCachedModel(request.provider, request.model);
      const modelContextLength = selectedModelInfo?.contextLength;
      const contextThresholdTokens = getContextThresholdTokens(modelContextLength);

      const executeTool = async (
        toolName: string,
        rawArguments: Record<string, unknown> | string,
      ): Promise<ToolExecutionResult> => {
        abortController.signal.throwIfAborted();
        if (!budget.takeToolCall()) {
          if (provider.conversationMode === 'threaded') {
            // Codex owns its internal loop. Interrupt it rather than starting a
            // second model turn outside the existing dynamic-tool bridge.
            budgetStopMessage = 'This response reached its tool limit. You can continue from the results above.';
            abortController.abort();
            abortController.signal.throwIfAborted();
          }
          return { success: false, content: TOOL_BUDGET_MESSAGE };
        }
        console.warn('[LLM] Tool call:', {
          tool: toolName,
          argumentsHead: truncateForLog(rawArguments),
        });
        if (toolName === 'tavily_search') {
          if (tavilySearchCallsThisTurn >= MAX_TAVILY_SEARCH_CALLS_PER_TURN) {
            return {
              success: false,
              content: [
                'Tavily search skipped.',
                `Error: Search limit reached for this user turn (${MAX_TAVILY_SEARCH_CALLS_PER_TURN}).`,
                'Use the existing search results to answer directly, or ask the user whether to run more searches.',
              ].join('\n'),
            };
          }

          let args;
          try {
            args = parseTavilySearchToolArgs(rawArguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid tavily_search arguments.';
            return { success: false, content: `Tavily search failed.\nError: ${errorMessage}` };
          }

          tavilySearchCallsThisTurn += 1;
          const searchResult = await tavilySearch(args, abortController.signal);
          const searchContent = formatTavilySearchToolResult(searchResult);
          const sourceGroup = createSearchSourceGroup(searchResult);
          if (sourceGroup) {
            const payload: SearchSourcesEvent = {
              assistantMessageId: request.assistantMessageId,
              group: sourceGroup,
            };
            sendToRenderer('search-sources-event', payload);
          }
          logMainProcess('LLM', 'Tavily search result returned to LLM', {
            query: args.query,
            success: searchResult.success,
            resultCount: searchResult.results?.length,
            error: searchResult.error?.slice(0, 300),
          });
          return { success: searchResult.success, content: searchContent };
        }

        if (toolName === 'fetch_url') {
          if (fetchUrlCallsThisTurn >= MAX_FETCH_URL_CALLS_PER_TURN) {
            return {
              success: false,
              content: [
                'Fetch skipped.',
                `Error: Fetch limit reached for this user turn (${MAX_FETCH_URL_CALLS_PER_TURN}).`,
                'Use the search snippets, previous fetch results, or cited source URLs to answer directly.',
              ].join('\n'),
            };
          }

          let args;
          try {
            args = parseFetchToolArgs(rawArguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid fetch_url arguments.';
            return { success: false, content: `Fetch failed.\nError: ${errorMessage}` };
          }

          fetchUrlCallsThisTurn += 1;
          const fetchResult = await fetchUrlContent(args, abortController.signal);
          const fetchContent = formatFetchToolResult(fetchResult);
          logMainProcess('LLM', 'Fetch tool result returned to LLM', {
            url: args.url,
            success: fetchResult.success,
            status: fetchResult.status,
            contentLength: fetchResult.content?.length ?? 0,
            error: fetchResult.error?.slice(0, 300),
            preview: fetchContent.slice(0, 600),
          });
          return { success: fetchResult.success, content: fetchContent };
        }

        if (BROWSER_CONTROL_TOOL_NAMES.has(toolName)) {
          try {
            const args = parseToolArgumentsObject(toolName, rawArguments);
            const browserResult = await runBrowserControlTool(
              toolName,
              args,
              abortController.signal,
              request.conversationId,
            );
            const browserContent = formatBrowserControlResult(toolName, browserResult);
            logMainProcess('BrowserControl', 'Browser Control tool result returned to LLM', {
              tool: toolName,
              success: browserResult.success,
              url: browserResult.state?.url,
              title: browserResult.state?.title,
              error: browserResult.error?.slice(0, 300),
            });
            return {
              success: browserResult.success,
              content: browserContent,
              imageUrls: browserResult.imageDataUrl ? [browserResult.imageDataUrl] : undefined,
            };
          } catch (error) {
            if (isAbortLikeError(error)) throw error;
            const errorMessage = error instanceof Error ? error.message : 'Invalid Browser Control tool arguments.';
            return {
              success: false,
              content: `Browser Control failed.\nTool: ${toolName}\nError: ${errorMessage}`,
            };
          }
        }

        if (isNotionToolName(toolName)) {
          if (notionCallsThisTurn >= MAX_NOTION_CALLS_PER_TURN) {
            return {
              success: false,
              content: [
                'Notion tool skipped.',
                `Error: Notion call limit reached for this user turn (${MAX_NOTION_CALLS_PER_TURN}).`,
                'Use the results already returned to answer, or ask the user whether to continue with more Notion operations.',
              ].join('\n'),
            };
          }

          notionCallsThisTurn += 1;
          try {
            const args = parseToolArgumentsObject(toolName, rawArguments);
            const notionResult = await executeNotionMcpTool(toolName, args, abortController.signal);
            logMainProcess('LLM', 'Notion tool result returned to LLM', {
              tool: toolName,
              success: notionResult.success,
              contentPreview: notionResult.content.slice(0, 600),
            });
            return notionResult;
          } catch (error) {
            if (isAbortLikeError(error)) throw error;
            const errorMessage = error instanceof Error ? error.message : 'Invalid Notion tool arguments.';
            return {
              success: false,
              content: `Notion failed.\nTool: ${toolName}\nError: ${errorMessage}`,
            };
          }
        }

        return { success: false, content: `Unknown tool: ${toolName}` };
      };

      const compactMessagesForContext = async (
        messages: ChatMessage[],
        reason: 'active-context' | 'thread-replay',
      ): Promise<ChatMessage[]> => {
        const estimatedTokens = estimateTotalTokens(messages);
        if (estimatedTokens <= contextThresholdTokens) return messages;

        logMainProcess('LLM', 'Context window approaching limit; compacting conversation history', {
          conversationId: request.conversationId,
          model: request.model,
          reason,
          estimatedTokens,
          contextThresholdTokens,
          modelContextLength: modelContextLength ?? 'default (128k)',
        });
        let compactionId: string | null = null;
        const compacted = await compactMessagesIfNeeded(messages, {
          provider,
          model: request.model,
          modelContextLength,
          signal: abortController.signal,
          conversationId: request.conversationId,
          onCompactionStart: () => {
            compactionId = beginCompaction();
          },
        });
        if (compactionId) finishCompaction(compactionId, 'completed');
        if (compacted.length < messages.length || estimateTotalTokens(compacted) < estimatedTokens) {
          logMainProcess('LLM', 'Conversation history compacted', {
            conversationId: request.conversationId,
            reason,
            previousMessageCount: messages.length,
            compactedMessageCount: compacted.length,
            estimatedTokensAfter: estimateTotalTokens(compacted),
          });
        }
        return compacted;
      };

      while (true) {
        abortController.signal.throwIfAborted();
        budget.startRound();
        if (provider.conversationMode !== 'threaded') {
          const compacted = await compactMessagesForContext(baseMessages, 'active-context');
          if (compacted !== baseMessages) {
            baseMessages.splice(0, baseMessages.length, ...compacted);
          }
        }

        const turnStartedAtMs = Date.now();
        abortController.signal.throwIfAborted();
        const streamTurn = () => provider.streamChat(
          request.model,
          baseMessages,
          abortController,
          emitStreamChunk,
          {
            tools: chatTools,
            keepAlive: CHAT_MODEL_KEEP_ALIVE,
            reasoningEffort: request.reasoningEffort,
            conversationId: request.conversationId,
            contextKey: request.contextKey,
            prepareReplayMessages: replayMessages => (
              compactMessagesForContext(replayMessages, 'thread-replay')
            ),
            executeTool: (toolName, argumentsValue) => executeTool(toolName, argumentsValue),
          }
        );
        let turnResult;
        try {
          turnResult = await streamTurn();
        } catch (error) {
          if (isAbortLikeError(error) || !hasToolImages(baseMessages) || !isImageInputUnsupportedError(error)) {
            throw error;
          }
          logMainProcess('LLM', 'Model rejected tool screenshot; retrying without images', {
            conversationId: request.conversationId,
            model: request.model,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
          stripToolImages(baseMessages, 'unsupported');
          turnResult = await streamTurn();
        }
        const turnEndedAtMs = Date.now();
        abortController.signal.throwIfAborted();
        const assistantMessage = turnResult.assistantMessage;
        console.warn('[LLM] Model output:', {
          model: request.model,
          contentHead: truncateForLog(assistantMessage?.content ?? ''),
          toolCallCount: assistantMessage?.tool_calls?.length ?? 0,
        });
        recordResolvedTurnUsage({
          model: request.model,
          provider: request.provider,
          usage: turnResult.usage,
          messages: baseMessages,
          assistantContent: assistantMessage?.content,
          assistantThinking: assistantMessage?.thinking,
          startedAtMs: turnStartedAtMs,
          endedAtMs: turnEndedAtMs,
        });
        const toolCalls = assistantMessage?.tool_calls ?? [];
        if (!toolCalls.length) {
          closeThinkingSection('turn-complete');
          sendToRenderer('ollama-done', streamContext);
          return { success: true };
        }

        closeThinkingSection('before-tool-call');
        const toolResultMessages: ChatMessage[] = [];

        for (const toolCall of toolCalls) {
          abortController.signal.throwIfAborted();
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments);
          abortController.signal.throwIfAborted();
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: result.content,
            ...toToolImageFields(result.imageUrls),
          });
        }
        // Only the newest screenshots stay in context; older ones are resent
        // every round and quickly dominate the request size.
        if (hasToolImages(toolResultMessages)) {
          stripToolImages(baseMessages, 'superseded');
        }

        if (budget.exhausted || requiresToolResultSynthesis(request.model)) {
          logMainProcess('LLM', 'Using tool-result synthesis fallback', {
            conversationId: request.conversationId,
            model: request.model,
            toolCallCount: toolCalls.length,
          });
          const prepareSynthesisMessages = async () => {
            let messages = buildToolResultSynthesisMessages(baseMessages, assistantMessage, toolResultMessages);
            if (budget.exhausted) {
              messages.push({ role: 'user', content: TOOL_BUDGET_MESSAGE });
            }
            const synthesisEstimatedTokens = estimateTotalTokens(messages);
            if (synthesisEstimatedTokens > contextThresholdTokens) {
              logMainProcess('LLM', 'Synthesis messages near context limit; compacting before fallback', {
                conversationId: request.conversationId,
                model: request.model,
                synthesisEstimatedTokens,
                contextThresholdTokens,
              });
              let compactionId: string | null = null;
              const compactedSynthesis = await compactMessagesIfNeeded(messages, {
                provider,
                model: request.model,
                modelContextLength,
                signal: abortController.signal,
                conversationId: request.conversationId,
                onCompactionStart: () => {
                  compactionId = beginCompaction();
                },
              });
              if (compactionId) finishCompaction(compactionId, 'completed');
              messages = compactedSynthesis;
            }
            return messages;
          };
          let synthesisMessages = await prepareSynthesisMessages();
          const synthesisStartedAtMs = Date.now();
          abortController.signal.throwIfAborted();
          const streamSynthesis = () => provider.streamChat(
            request.model,
            synthesisMessages,
            abortController,
            emitStreamChunk,
            {
              tools: null,
              keepAlive: CHAT_MODEL_KEEP_ALIVE,
              reasoningEffort: request.reasoningEffort,
              conversationId: request.conversationId,
              contextKey: request.contextKey,
            },
          );
          let synthesisResult;
          try {
            synthesisResult = await streamSynthesis();
          } catch (error) {
            if (
              isAbortLikeError(error)
              || (!hasToolImages(baseMessages) && !hasToolImages(toolResultMessages))
              || !isImageInputUnsupportedError(error)
            ) {
              throw error;
            }
            logMainProcess('LLM', 'Model rejected synthesis screenshot; retrying without images', {
              conversationId: request.conversationId,
              model: request.model,
              error: error instanceof Error ? error.message.slice(0, 300) : String(error),
            });
            stripToolImages(baseMessages, 'unsupported');
            stripToolImages(toolResultMessages, 'unsupported');
            synthesisMessages = await prepareSynthesisMessages();
            abortController.signal.throwIfAborted();
            synthesisResult = await streamSynthesis();
          }
          abortController.signal.throwIfAborted();
          recordResolvedTurnUsage({
            model: request.model,
            provider: request.provider,
            usage: synthesisResult.usage,
            messages: synthesisMessages,
            assistantContent: synthesisResult.assistantMessage?.content,
            assistantThinking: synthesisResult.assistantMessage?.thinking,
            startedAtMs: synthesisStartedAtMs,
            endedAtMs: Date.now(),
          });
          console.warn('[LLM] Model output (synthesis):', {
            model: request.model,
            contentHead: truncateForLog(synthesisResult.assistantMessage?.content ?? ''),
          });

          if (synthesisResult.assistantMessage?.tool_calls?.length) {
            logMainProcess('LLM', 'Ignoring unexpected tool calls during synthesis fallback', {
              conversationId: request.conversationId,
              model: request.model,
              toolCallCount: synthesisResult.assistantMessage.tool_calls.length,
            });
          }

          closeThinkingSection('tool-synthesis-complete');
          sendToRenderer('ollama-done', streamContext);
          return { success: true };
        }

        if (assistantMessage) {
          baseMessages.push(assistantMessage);
        }
        baseMessages.push(...toolResultMessages);
      }
    } catch (error) {
      for (const compactionId of [...activeCompactionIds]) {
        finishCompaction(compactionId, 'failed');
      }
      flushThinkingConsoleBuffer('stream-error');
      if (isAbortLikeError(error)) {
        closeThinkingSection('stream-abort');
        if (budgetStopMessage) {
          sendToRenderer('ollama-chunk', { ...streamContext, chunk: `\n\n${budgetStopMessage}` });
        }
        sendToRenderer('ollama-done', streamContext);
        return { success: true, aborted: true };
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during streaming';
      const errorPayload: StreamErrorEvent = { ...streamContext, error: errorMessage };
      sendToRenderer('ollama-error', errorPayload);
      throw error;
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      activeStreams.delete(streamKey);
    }
  });
}

export function registerStopStreamHandler(activeStreams: Map<string, AbortController>): void {
  ipcMain.handle('stop-stream', async (_event, request: StopStreamRequest) => {
    activeStreams.get(request.assistantMessageId)?.abort();
    await closeBrowserControl(request.conversationId).catch((error) => {
      console.error('[BrowserControl] Failed to close Browser Control after stop:', error);
    });
    return { success: true };
  });
}
