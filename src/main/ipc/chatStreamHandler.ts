import { ipcMain } from 'electron';
import type { StreamChunkEvent, StreamErrorEvent, StreamEventContext, StopStreamRequest } from '../../shared/stream';
import type { SearchSourcesEvent } from '../../shared/search';
import { getAllModels, getProvider } from '../providers/registry';
import type { ChatMessage, ModelInfo, StreamChunk, ToolExecutionResult } from '../providers/types';
import { compactMessagesIfNeeded, estimateTotalTokens, getContextThresholdTokens } from '../contextCompaction';
import { closeBrowserControl } from '../browserControlService';
import {
  buildSystemPrompt,
} from '../systemPrompt';
import {
  getChatTools,
  BROWSER_CONTROL_TOOL_NAMES,
  NOTION_TOOL_NAMES,
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
import { executeNotionMcpTool } from '../notionMcpService';
import { tavilySearch } from '../tavilySearchService';
import { fetchUrlContent } from '../fetchService';
import { logMainProcess, CHAT_MODEL_KEEP_ALIVE } from '../app/lifecycle';
import { recordResolvedTurnUsage } from '../usageService';

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
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

    try {
      const abortController = new AbortController();
      activeStreams.set(streamKey, abortController);
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

      let allModels: ModelInfo[] = [];
      try {
        allModels = await getAllModels();
      } catch (error) {
        console.error('[Context Compaction] Failed to load model list for context limit lookup:', error);
      }
      const selectedModelInfo = allModels.find((m) => m.id === request.model);
      const modelContextLength = selectedModelInfo?.contextLength;
      const contextThresholdTokens = getContextThresholdTokens(modelContextLength);

      const executeTool = async (
        toolName: string,
        rawArguments: Record<string, unknown> | string,
      ): Promise<ToolExecutionResult> => {
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
          const searchResult = await tavilySearch(args);
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
          const fetchResult = await fetchUrlContent(args);
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
            return { success: browserResult.success, content: browserContent };
          } catch (error) {
            if (isAbortLikeError(error)) throw error;
            const errorMessage = error instanceof Error ? error.message : 'Invalid Browser Control tool arguments.';
            return {
              success: false,
              content: `Browser Control failed.\nTool: ${toolName}\nError: ${errorMessage}`,
            };
          }
        }

        if (NOTION_TOOL_NAMES.has(toolName)) {
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
        const compacted = await compactMessagesIfNeeded(messages, {
          provider,
          model: request.model,
          modelContextLength,
        });
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
        if (provider.conversationMode !== 'threaded') {
          const compacted = await compactMessagesForContext(baseMessages, 'active-context');
          if (compacted !== baseMessages) {
            baseMessages.splice(0, baseMessages.length, ...compacted);
          }
        }

        const turnStartedAtMs = Date.now();
        const turnResult = await provider.streamChat(
          request.model,
          baseMessages,
          abortController,
          emitStreamChunk,
          {
            tools: chatTools,
            keepAlive: CHAT_MODEL_KEEP_ALIVE,
            conversationId: request.conversationId,
            prepareReplayMessages: replayMessages => (
              compactMessagesForContext(replayMessages, 'thread-replay')
            ),
            executeTool: (toolName, argumentsValue) => executeTool(toolName, argumentsValue),
          }
        );
        const turnEndedAtMs = Date.now();
        const assistantMessage = turnResult.assistantMessage;
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
          const result = await executeTool(toolCall.function.name, toolCall.function.arguments);
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: result.content,
          });
        }

        if (requiresToolResultSynthesis(request.model)) {
          logMainProcess('LLM', 'Using tool-result synthesis fallback', {
            conversationId: request.conversationId,
            model: request.model,
            toolCallCount: toolCalls.length,
          });
          let synthesisMessages = buildToolResultSynthesisMessages(baseMessages, assistantMessage, toolResultMessages);
          const synthesisEstimatedTokens = estimateTotalTokens(synthesisMessages);
          if (synthesisEstimatedTokens > contextThresholdTokens) {
            logMainProcess('LLM', 'Synthesis messages near context limit; compacting before fallback', {
              conversationId: request.conversationId,
              model: request.model,
              synthesisEstimatedTokens,
              contextThresholdTokens,
            });
            const compactedSynthesis = await compactMessagesIfNeeded(synthesisMessages, {
              provider,
              model: request.model,
              modelContextLength,
            });
            synthesisMessages = compactedSynthesis;
          }
          const synthesisStartedAtMs = Date.now();
          const synthesisResult = await provider.streamChat(
            request.model,
            synthesisMessages,
            abortController,
            emitStreamChunk,
            { tools: null, keepAlive: CHAT_MODEL_KEEP_ALIVE },
          );
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
      flushThinkingConsoleBuffer('stream-error');
      if (isAbortLikeError(error)) {
        closeThinkingSection('stream-abort');
        sendToRenderer('ollama-done', streamContext);
        return { success: true, aborted: true };
      }
      const errorMessage = error instanceof Error ? error.message : 'Unknown error during streaming';
      const errorPayload: StreamErrorEvent = { ...streamContext, error: errorMessage };
      sendToRenderer('ollama-error', errorPayload);
      throw error;
    } finally {
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
