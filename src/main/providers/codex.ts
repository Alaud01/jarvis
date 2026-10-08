import { createHash } from 'node:crypto';
import {
  CodexAppServerClient,
  CodexTurnError,
  isMissingThreadError,
  type CodexAccountStatus,
  type CodexAppServerOptions,
  type CodexConversationThreadRecord,
  type CodexDynamicTool,
  type CodexTokenUsageBreakdown,
  type CodexUserInput,
  type SharedAccountSnapshot,
} from '../codexAppServer';
import type {
  ChatMessage,
  ModelInfo,
  Provider,
  SendChatOptions,
  StreamChatTurnOptions,
  StreamChunk,
  StreamTurnResult,
  ToolDefinition,
} from './types';

const CODEX_MODEL_PREFIX = 'codex:';
const CODEX_PROVIDER_INSTRUCTIONS = [
  'You are the response engine inside the Jarvis desktop assistant.',
  'Jarvis owns the visible conversation and all user-facing state.',
  'Answer the user directly. Do not inspect files, run commands, or modify files.',
  'You may use dynamic tools in the jarvis namespace when they are provided. Do not use Codex built-in filesystem or command-execution tools.',
  'When citing web sources, write ordinary Markdown links with public URLs. Never emit private citation markers such as citeturn0search0.',
  'Do not mention the private Codex runtime or its thread unless the user explicitly asks about implementation details.',
].join(' ');

export interface BuiltCodexTurnInput {
  input: CodexUserInput[];
  conversationMessageCount: number;
}

/** Lets a request attempt report what the retry policy needs to know. */
interface AccountAttempt {
  /** The attempt streamed output or ran a tool, so retrying would duplicate it. */
  markObserved(): void;
  /**
   * Holds the selected account fixed for the turn that follows. The hold is
   * released when the attempt ends.
   */
  reserveTurnAccount(): Promise<SharedAccountSnapshot>;
}

const MAX_ACCOUNT_PREPARATIONS = 3;

function accountFingerprintSuffix(identity: string | null): string {
  return identity
    ? `:account:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`
    : '';
}

function withLoginRefreshGuidance(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Codex rejected the login.';
  const guided = new Error(
    `${message}\n\nThe login selected in Codex Switcher was rejected. Open Codex Switcher or the Codex app so it can refresh the login, then try again.`,
  );
  (guided as Error & { cause?: unknown }).cause = error;
  return guided;
}

function isCodexAuthenticationError(error: unknown): boolean {
  if (error instanceof CodexTurnError && error.codexErrorInfo !== null) {
    return error.codexErrorInfo === 'unauthorized';
  }
  return error instanceof Error && /\b401 Unauthorized\b/.test(error.message);
}

interface PersistentThreadSelection {
  record: CodexConversationThreadRecord;
  replayRequired: boolean;
}

export function isCodexUsageLimitError(error: unknown): boolean {
  if (error instanceof CodexTurnError && error.codexErrorInfo !== null) {
    return error.codexErrorInfo === 'usageLimitExceeded';
  }
  return error instanceof Error && /usage limit|usage_limit_reached/i.test(error.message);
}

function withSwitcherGuidance(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Codex usage limit reached.';
  const guided = new Error(
    `${message}\n\nSwitch to another account in Codex Switcher and resend; Jarvis uses the newly selected account automatically.`,
  );
  (guided as Error & { cause?: unknown }).cause = error;
  return guided;
}

export function toCodexModelId(model: string): string {
  return `${CODEX_MODEL_PREFIX}${model}`;
}

export function fromCodexModelId(model: string): string {
  return model.startsWith(CODEX_MODEL_PREFIX) ? model.slice(CODEX_MODEL_PREFIX.length) : model;
}

export function toCodexDynamicTools(tools: ToolDefinition[]): CodexDynamicTool[] {
  if (tools.length === 0) return [];
  return [{
    type: 'namespace',
    name: 'jarvis',
    description: 'Tools provided and executed by the Jarvis desktop application.',
    tools: tools.map(tool => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters,
    })),
  }];
}

export function fingerprintCodexDynamicTools(tools: CodexDynamicTool[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFingerprintValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalizeFingerprintValue(nestedValue)]),
    );
  }
  return value;
}

function getConversationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(message => message.role !== 'system');
}

export function fingerprintCodexMessagePrefix(
  messages: ChatMessage[],
  messageCount: number,
): string {
  const conversationMessages = getConversationMessages(messages);
  const safeCount = Math.max(0, Math.min(messageCount, conversationMessages.length));
  // Renderer streaming decorates assistant text with transient thinking markers
  // that are not present in the app-server's final message. Assistant messages
  // are immutable in Jarvis, so their role/position is the stable sync signal;
  // user and tool payloads remain fully fingerprinted to detect history edits.
  const canonicalMessages = conversationMessages.slice(0, safeCount).map(message => (
    message.role === 'assistant'
      ? { role: message.role }
      : {
          role: message.role,
          content: message.content,
          images: message.images ?? [],
          imageMimeTypes: message.imageMimeTypes ?? [],
          toolCalls: message.tool_calls ?? [],
          toolCallId: message.tool_call_id ?? null,
          toolName: message.tool_name ?? null,
        }
  ));
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeFingerprintValue(canonicalMessages)))
    .digest('hex');
}

export function isCodexThreadRecordSynchronized(
  record: CodexConversationThreadRecord,
  messages: ChatMessage[],
  toolSchemaFingerprint: string,
): boolean {
  const conversationMessageCount = getConversationMessages(messages).length;
  return record.syncedMessageCount <= conversationMessageCount
    && record.toolSchemaFingerprint === toolSchemaFingerprint
    && record.syncedPrefixFingerprint === fingerprintCodexMessagePrefix(
      messages,
      record.syncedMessageCount,
    );
}

function toImageDataUrl(base64: string, mimeType = 'image/png'): string {
  return base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
}

function formatMessage(message: ChatMessage): string {
  const role = message.role === 'assistant' ? 'Assistant' : message.role === 'user' ? 'User' : 'Tool';
  return `${role}: ${message.content}`;
}

export function buildCodexTurnInput(
  messages: ChatMessage[],
  syncedMessageCount: number,
): BuiltCodexTurnInput {
  const conversationMessages = getConversationMessages(messages);
  let latestUserIndex = -1;
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    if (conversationMessages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    throw new Error('Codex requires a user message.');
  }

  const latestUser = conversationMessages[latestUserIndex];
  const safeSyncedCount = Math.max(0, Math.min(syncedMessageCount, conversationMessages.length));
  const unsyncedMessages = conversationMessages.slice(safeSyncedCount, latestUserIndex + 1);
  const onlyCurrentUserMessage = unsyncedMessages.length === 1 && unsyncedMessages[0] === latestUser;
  const text = onlyCurrentUserMessage
    ? latestUser.content
    : [
        'The following messages were added to the Jarvis conversation since this private Codex thread was last synchronized:',
        '',
        ...unsyncedMessages.slice(0, -1).map(formatMessage),
        '',
        'Current user request:',
        latestUser.content,
      ].join('\n');

  const input: CodexUserInput[] = [{ type: 'text', text, text_elements: [] }];
  latestUser.images?.forEach((image, index) => {
    input.push({
      type: 'image',
      url: toImageDataUrl(image, latestUser.imageMimeTypes?.[index]),
    });
  });

  return { input, conversationMessageCount: conversationMessages.length };
}

function buildDeveloperInstructions(messages: ChatMessage[]): string {
  const jarvisInstructions = messages
    .filter(message => message.role === 'system')
    .map(message => message.content.trim())
    .filter(Boolean)
    .join('\n\n');
  return jarvisInstructions
    ? `Jarvis instructions:\n${jarvisInstructions}\n\nProvider boundary:\n${CODEX_PROVIDER_INSTRUCTIONS}`
    : CODEX_PROVIDER_INSTRUCTIONS;
}

export class CodexProvider implements Provider {
  readonly id = 'codex';
  readonly name = 'Codex (ChatGPT)';
  readonly conversationMode = 'threaded' as const;
  private readonly client: CodexAppServerClient;

  constructor(options: CodexAppServerOptions) {
    this.client = new CodexAppServerClient(options);
  }

  get followsCodexSwitcher(): boolean {
    return this.client.followsSharedAuth;
  }

  getApiKey(): string | null {
    return null;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    const models = await this.client.listModels();
    return models
      .filter(model => !model.hidden)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
      .map(model => ({
        id: toCodexModelId(model.model),
        name: model.displayName,
        provider: this.id,
        ...(model.supportedReasoningEfforts?.length ? {
          reasoningEfforts: model.supportedReasoningEfforts.map(({ reasoningEffort, description }) => ({
            value: reasoningEffort,
            description,
          })),
          defaultReasoningEffort: model.defaultReasoningEffort,
        } : {}),
      }));
  }

  async connectAccount(): Promise<CodexAccountStatus> {
    return this.client.loginChatGpt();
  }

  async getAccountStatus(): Promise<CodexAccountStatus> {
    return this.client.getAccountStatus();
  }

  async disconnectAccount(): Promise<void> {
    await this.client.logout();
  }

  private async startPersistentThread(
    conversationId: string,
    model: string,
    developerInstructions: string,
    dynamicTools: CodexDynamicTool[],
    toolSchemaFingerprint: string,
  ): Promise<CodexConversationThreadRecord> {
    const threadId = await this.client.startThread({
      model,
      developerInstructions,
      ephemeral: false,
      dynamicTools,
    });
    const record = {
      threadId,
      syncedMessageCount: 0,
      syncedPrefixFingerprint: fingerprintCodexMessagePrefix([], 0),
      toolSchemaFingerprint,
    };
    await this.client.replaceConversationThread(conversationId, record);
    return record;
  }

  private async getOrStartPersistentThread(
    conversationId: string,
    model: string,
    developerInstructions: string,
    messages: ChatMessage[],
    dynamicTools: CodexDynamicTool[],
    toolSchemaFingerprint: string,
  ): Promise<PersistentThreadSelection> {
    let record = await this.client.getConversationThread(conversationId);
    if (record && !isCodexThreadRecordSynchronized(record, messages, toolSchemaFingerprint)) {
      record = await this.startPersistentThread(
        conversationId,
        model,
        developerInstructions,
        dynamicTools,
        toolSchemaFingerprint,
      );
      return { record, replayRequired: true };
    }
    if (!record) {
      record = await this.startPersistentThread(
        conversationId,
        model,
        developerInstructions,
        dynamicTools,
        toolSchemaFingerprint,
      );
      return { record, replayRequired: true };
    }

    try {
      await this.client.resumeThread(record.threadId, model, developerInstructions);
      return { record, replayRequired: record.syncedMessageCount === 0 };
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
      record = await this.startPersistentThread(
        conversationId,
        model,
        developerInstructions,
        dynamicTools,
        toolSchemaFingerprint,
      );
      return { record, replayRequired: true };
    }
  }

  /**
   * Runs a request on the account selected in Codex Switcher. When the turn
   * hits its usage limit and Switcher has since selected a different account,
   * the request is retried once, but only if the failed attempt streamed no
   * output and ran no tools, so nothing is duplicated.
   */
  private async runOnActiveAccount<T>(
    run: (attempt: AccountAttempt) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let observed = false;
    let turnIdentity: string | null = null;
    const attemptOnce = async (onObserved: () => void): Promise<T> => {
      let release: () => void = () => undefined;
      try {
        return await run({
          markObserved: onObserved,
          reserveTurnAccount: async () => {
            release();
            const reservation = await this.client.reserveSharedAccountForTurn();
            release = reservation.release;
            turnIdentity = reservation.identity;
            return reservation;
          },
        });
      } finally {
        release();
      }
    };

    if (!this.client.followsSharedAuth) return attemptOnce(() => undefined);

    try {
      return await attemptOnce(() => {
        observed = true;
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isCodexAuthenticationError(error)) throw withLoginRefreshGuidance(error);
      if (!isCodexUsageLimitError(error)) throw error;
      const currentIdentity = await this.client.readSharedAccountIdentity().catch(() => null);
      if (observed || !turnIdentity || !currentIdentity || currentIdentity === turnIdentity) {
        throw withSwitcherGuidance(error);
      }
    }

    try {
      return await attemptOnce(() => undefined);
    } catch (error) {
      if (isCodexAuthenticationError(error)) throw withLoginRefreshGuidance(error);
      throw isCodexUsageLimitError(error) ? withSwitcherGuidance(error) : error;
    }
  }

  /**
   * Prepares a thread for the selected account, then reserves that account
   * for the turn. Codex opens a thread's model connection when the thread is
   * created or resumed, as whichever account is supplied at that moment. If
   * the supplied account changed at all during preparation, even if it then
   * changed back, the prepared thread may hold another account's connection,
   * so it is discarded and the thread is prepared again.
   */
  private async prepareOnReservedAccount<T>(
    attempt: AccountAttempt,
    prepare: (accountIdentity: string | null) => Promise<T>,
    discard: (result: T) => Promise<void>,
  ): Promise<T> {
    for (let preparation = 1; ; preparation += 1) {
      const prepared = await this.client.syncSharedAccount();
      const result = await prepare(prepared.identity);
      if ((await attempt.reserveTurnAccount()).generation === prepared.generation) return result;
      await discard(result);
      if (preparation >= MAX_ACCOUNT_PREPARATIONS) {
        throw new Error('The Codex Switcher account kept changing while Jarvis prepared this request. Try again.');
      }
    }
  }

  async streamChat(
    modelId: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    const executeTool = options?.executeTool;
    return this.runOnActiveAccount(attempt => this.streamChatOnActiveAccount(
      attempt,
      modelId,
      messages,
      abortController,
      chunk => {
        attempt.markObserved();
        onChunk(chunk);
      },
      options && {
        ...options,
        executeTool: executeTool && ((tool, argumentsValue) => {
          attempt.markObserved();
          return executeTool(tool, argumentsValue);
        }),
      },
    ), abortController.signal);
  }

  private async streamChatOnActiveAccount(
    attempt: AccountAttempt,
    modelId: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    const account = await this.client.ensureChatGptAccount();
    if (account.type !== 'chatgpt') {
      throw new Error('Jarvis Codex requires ChatGPT subscription authentication; API-key billing is disabled.');
    }
    const model = fromCodexModelId(modelId);
    const developerInstructions = buildDeveloperInstructions(messages);
    const conversationId = options?.conversationId;
    const executeTool = options?.executeTool;
    const dynamicTools = executeTool
      ? toCodexDynamicTools(options.tools ?? [])
      : [];
    const toolAndBranchFingerprint = fingerprintCodexDynamicTools(dynamicTools)
      + (options?.contextKey ? `:branch:${options.contextKey}` : '');
    const onToolCall = executeTool
      ? (tool: string, argumentsValue: Record<string, unknown>) => (
          executeTool(tool, argumentsValue)
        )
      : undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let hasReportedUsage = false;
    const onTokenUsage = (usage: CodexTokenUsageBreakdown) => {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      hasReportedUsage = true;
    };
    const resultUsage = () => (hasReportedUsage ? {
      inputTokens,
      outputTokens,
      estimated: false,
    } : undefined);

    if (!conversationId) {
      const builtInput = buildCodexTurnInput(messages, 0);
      const threadId = await this.prepareOnReservedAccount(attempt, () => this.client.startThread({
        model,
        developerInstructions,
        ephemeral: true,
        dynamicTools,
      }), async () => undefined);
      const content = await this.client.runTurn({
        threadId,
        model,
        effort: options?.reasoningEffort,
        input: builtInput.input,
        signal: abortController.signal,
        onToolCall,
        onTokenUsage,
        onDelta: (delta, phase) => onChunk({
          type: phase === 'commentary' ? 'thinking' : 'content',
          content: delta,
        }),
      });
      return { assistantMessage: { role: 'assistant', content }, usage: resultUsage() };
    }

    const sourceConversationMessages = getConversationMessages(messages);
    const { selection, builtInput, toolSchemaFingerprint } = await this.prepareOnReservedAccount(
      attempt,
      async accountIdentity => {
        // Codex keeps a thread's model connection open across turns, so a
        // thread must not outlive an account switch. Binding the account into
        // the fingerprint replays the conversation into a fresh thread.
        const toolSchemaFingerprint = toolAndBranchFingerprint + accountFingerprintSuffix(accountIdentity);
        const selection = await this.getOrStartPersistentThread(
          conversationId,
          model,
          developerInstructions,
          messages,
          dynamicTools,
          toolSchemaFingerprint,
        );
        const turnMessages = selection.replayRequired
          ? await options?.prepareReplayMessages?.(messages) ?? messages
          : messages;
        const builtInput = buildCodexTurnInput(
          turnMessages,
          selection.replayRequired ? 0 : selection.record.syncedMessageCount,
        );
        return { selection, builtInput, toolSchemaFingerprint };
      },
      () => this.client.deleteConversationThread(conversationId),
    );

    try {
      const content = await this.client.runTurn({
        threadId: selection.record.threadId,
        model,
        effort: options?.reasoningEffort,
        input: builtInput.input,
        signal: abortController.signal,
        onToolCall,
        onTokenUsage,
        onDelta: (delta, phase) => onChunk({
          type: phase === 'commentary' ? 'thinking' : 'content',
          content: delta,
        }),
      });
      const synchronizedMessages: ChatMessage[] = [
        ...sourceConversationMessages,
        { role: 'assistant', content },
      ];
      await this.client.saveConversationThread(conversationId, {
        threadId: selection.record.threadId,
        // The app-server already owns the assistant message it just generated.
        // A compacted replay semantically represents the complete original
        // Jarvis prefix, so synchronization is tracked against that source.
        syncedMessageCount: synchronizedMessages.length,
        syncedPrefixFingerprint: fingerprintCodexMessagePrefix(
          synchronizedMessages,
          synchronizedMessages.length,
        ),
        toolSchemaFingerprint,
      });
      return { assistantMessage: { role: 'assistant', content }, usage: resultUsage() };
    } catch (error) {
      // An interrupted or failed app-server turn may contain partial state.
      // Remove the mapping so the next Jarvis request starts cleanly.
      await this.client.deleteConversationThread(conversationId).catch(() => undefined);
      throw error;
    }
  }

  async sendChat(
    modelId: string,
    messages: ChatMessage[],
    options?: SendChatOptions,
  ): Promise<string> {
    // sendChat streams nothing and runs no tools, so a retry duplicates nothing.
    return this.runOnActiveAccount(attempt => this.sendChatOnActiveAccount(attempt, modelId, messages, options), options?.signal);
  }

  private async sendChatOnActiveAccount(
    attempt: AccountAttempt,
    modelId: string,
    messages: ChatMessage[],
    options?: SendChatOptions,
  ): Promise<string> {
    const account = await this.client.ensureChatGptAccount();
    if (account.type !== 'chatgpt') {
      throw new Error('Jarvis Codex requires ChatGPT subscription authentication; API-key billing is disabled.');
    }
    const model = fromCodexModelId(modelId);
    const developerInstructions = buildDeveloperInstructions(messages);
    const builtInput = buildCodexTurnInput(messages, 0);
    const threadId = await this.prepareOnReservedAccount(attempt, () => this.client.startThread({
      model,
      developerInstructions,
      ephemeral: true,
      dynamicTools: [],
    }), async () => undefined);
    return this.client.runTurn({
      threadId,
      model,
      input: builtInput.input,
      onDelta: () => undefined,
      signal: options?.signal,
    });
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.client.deleteConversationThread(conversationId);
  }

  async shutdown(): Promise<void> {
    await this.client.stop();
  }
}
