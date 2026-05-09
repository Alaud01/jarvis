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
  thinking?: string;
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

export interface StreamTurnResult {
  assistantMessage?: ChatMessage;
}

export interface StreamChatTurnOptions {
  tools?: ToolDefinition[] | null;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  fetchModels(): Promise<ModelInfo[]>;
  streamChat(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult>;
  sendChat(model: string, messages: ChatMessage[]): Promise<string>;
  getApiKey(): string | null;
}