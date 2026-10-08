import type { ChatMessage, Provider } from './providers/types';
import { estimateTokenCount as estimateUsageTokens, recordUsageEvent } from './usageService';

const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_CONTEXT_LENGTH_TOKENS = 128_000;
const CONTEXT_USAGE_THRESHOLD = 0.9;
const COMPACTION_SUMMARY_MAX_TOKENS = 1_500;

interface CompactionOptions {
  provider: Provider;
  model: string;
  signal?: AbortSignal;
  modelContextLength?: number;
  reserveFraction?: number;
  conversationId?: string;
  onCompactionStart?: () => void;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function estimateMessageTokens(message: ChatMessage): number {
  let text = message.content ?? '';
  if (message.thinking) {
    text += `\n${message.thinking}`;
  }
  if (message.tool_calls?.length) {
    for (const tc of message.tool_calls) {
      text += `\n${tc.function.name} ${JSON.stringify(tc.function.arguments ?? {})}`;
    }
  }
  return estimateTokenCount(text);
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

function getEffectiveContextLength(modelContextLength?: number): number {
  return modelContextLength && Number.isFinite(modelContextLength) && modelContextLength > 0
    ? modelContextLength
    : DEFAULT_CONTEXT_LENGTH_TOKENS;
}

function findSystemMessage(messages: ChatMessage[]): { system: ChatMessage | undefined; rest: ChatMessage[] } {
  if (messages.length > 0 && messages[0].role === 'system') {
    return { system: messages[0], rest: messages.slice(1) };
  }
  return { system: undefined, rest: messages };
}

function formatMessageForSummary(message: ChatMessage, index: number): string {
  const prefix = `[${index + 1}] ${message.role}`;
  let body = message.content ?? '';

  if (message.role === 'assistant' && message.tool_calls?.length) {
    const toolCalls = message.tool_calls
      .map((tc) => `tool_call(${tc.function.name}): ${JSON.stringify(tc.function.arguments ?? {})}`)
      .join('\n');
    body = [body, toolCalls].filter(Boolean).join('\n');
  }

  if (message.role === 'tool') {
    body = `[tool ${message.tool_name ?? message.tool_call_id ?? 'unknown'} result]\n${body}`;
  }

  return `${prefix}:\n${body}`;
}

function formatHistoryForSummary(messages: ChatMessage[]): string {
  return messages.map((msg, idx) => formatMessageForSummary(msg, idx)).join('\n\n---\n\n');
}

async function summarizeHistoryWithLLM(
  provider: Provider,
  model: string,
  messagesToSummarize: ChatMessage[],
  latestUserRequest: string,
  signal?: AbortSignal,
  conversationId?: string,
): Promise<string> {
  const historyText = formatHistoryForSummary(messagesToSummarize);
  const summaryMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'You are a conversation compressor. Summarize the provided chat history into a concise, information-dense recap.',
        'Preserve key facts, decisions, tool results, URLs, numbers, names, and the user\'s overall goal.',
        'Discard filler, greetings, and redundant wording.',
        'Do not address the user directly. Output only the summary in bullet form.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Latest user request (keep in mind, but do not answer it yet): ${latestUserRequest}`,
        '',
        'History to summarize:',
        historyText,
      ].join('\n'),
    },
  ];

  const startedAtMs = Date.now();
  const rawSummary = await provider.sendChat(model, summaryMessages, { signal, conversationId });
  const summary = rawSummary.trim();
  recordUsageEvent({
    model,
    provider: provider.id,
    inputTokens: estimateMessagesTokens(summaryMessages),
    outputTokens: estimateUsageTokens(summary),
    generationMs: Math.max(1, Date.now() - startedAtMs),
    estimated: true,
  });
  return summary;
}

/**
 * Compacts a message list when it nears the model's context-window threshold.
 *
 * Strategy:
 * - Keep the system prompt untouched.
 * - Keep the latest user message (and any immediately pending tool results/assistant messages
 *   involved in the current turn) so the model can continue its active work.
 * - Summarize older history with an LLM call and replace it with a single user message
 *   containing the summary.
 */
export async function compactMessagesIfNeeded(
  messages: ChatMessage[],
  options: CompactionOptions,
): Promise<ChatMessage[]> {
  const contextLength = getEffectiveContextLength(options.modelContextLength);
  const tokenBudget = Math.floor(contextLength * (options.reserveFraction ?? CONTEXT_USAGE_THRESHOLD));
  const currentTokens = estimateMessagesTokens(messages);

  if (currentTokens <= tokenBudget) {
    return messages;
  }

  const { system, rest } = findSystemMessage(messages);
  const systemTokens = system ? estimateMessageTokens(system) : 0;
  const availableForHistory = tokenBudget - systemTokens - COMPACTION_SUMMARY_MAX_TOKENS;

  if (availableForHistory <= 0 || rest.length < 3) {
    return messages;
  }

  let latestUserIndex = rest.length - 1;
  while (latestUserIndex >= 0 && rest[latestUserIndex].role !== 'user') {
    latestUserIndex -= 1;
  }
  if (latestUserIndex < 0) {
    latestUserIndex = Math.max(0, rest.length - 1);
  }

  const recentMessages = rest.slice(latestUserIndex);
  const recentTokens = estimateMessagesTokens(recentMessages);
  const historyBudget = availableForHistory - recentTokens;

  if (historyBudget <= 0) {
    return messages;
  }

  const messagesToSummarize = rest.slice(0, latestUserIndex);
  const messagesToSummarizeTokens = estimateMessagesTokens(messagesToSummarize);

  if (messagesToSummarizeTokens <= historyBudget) {
    return messages;
  }

  const latestUserRequest = rest[latestUserIndex]?.content ?? 'Continue the task.';
  options.onCompactionStart?.();
  const summary = await summarizeHistoryWithLLM(
    options.provider,
    options.model,
    messagesToSummarize,
    latestUserRequest,
    options.signal,
    options.conversationId,
  );

  const compacted: ChatMessage[] = [
    ...(system ? [system] : []),
    {
      role: 'user',
      content: `Earlier conversation summary:\n${summary}`,
    },
    ...recentMessages,
  ];

  return compacted;
}

export function estimateTotalTokens(messages: ChatMessage[]): number {
  return estimateMessagesTokens(messages);
}

export function getContextThresholdTokens(modelContextLength?: number, reserveFraction?: number): number {
  const contextLength = getEffectiveContextLength(modelContextLength);
  return Math.floor(contextLength * (reserveFraction ?? CONTEXT_USAGE_THRESHOLD));
}
