export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  type: 'function';
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: string[];
  imageMimeTypes?: string[];
  thinking?: string;
  // Main-process-only replay state for stateless Go Responses tool rounds.
  // Keep native item order, encrypted reasoning, call IDs and message phases.
  openCodeGoResponse?: {
    model: string;
    output: Array<Record<string, unknown>>;
  };
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface StreamChunk {
  type: 'thinking' | 'content';
  content: string;
}

export interface StreamTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  generationMs?: number;
  estimated?: boolean;
}

export interface StreamTurnResult {
  assistantMessage?: ChatMessage;
  usage?: StreamTurnUsage;
}

export interface ToolExecutionResult {
  content: string;
  success: boolean;
  imageUrls?: string[];
}

export interface StreamChatTurnOptions {
  tools?: ToolDefinition[] | null;
  keepAlive?: string | number;
  reasoningEffort?: string;
  conversationId?: string;
  contextKey?: string;
  prepareReplayMessages?: (messages: ChatMessage[]) => Promise<ChatMessage[]>;
  executeTool?: (
    name: string,
    argumentsValue: Record<string, unknown>,
  ) => Promise<ToolExecutionResult>;
}

export interface SendChatOptions {
  keepAlive?: string | number;
  signal?: AbortSignal;
  conversationId?: string;
  contextKey?: string;
  sessionId?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
  reasoningEfforts?: ReasoningEffortOption[];
  defaultReasoningEffort?: string;
}

export interface ReasoningEffortOption {
  value: string;
  description?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface ModelDiscoverySource {
  readonly id: string;
  fetchModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly modelSources?: readonly ModelDiscoverySource[];
  readonly conversationMode?: 'stateless' | 'threaded';
  fetchModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  streamChat(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult>;
  sendChat(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string>;
  getApiKey(): string | null;
  deleteConversation?(conversationId: string): Promise<void>;
  shutdown?(): Promise<void>;
}
