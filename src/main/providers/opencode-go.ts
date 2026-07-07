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
import { debugLog } from '../logger';

const BASE_URL = 'https://opencode.ai/zen/go/v1';

const OPENAI_COMPATIBLE_MODELS = new Set([
  'glm-5.1',
  'glm-5',
  'kimi-k2.5',
  'kimi-k2.6',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'mimo-v2.5',
  'mimo-v2.5-pro',
]);

const ANTHROPIC_COMPATIBLE_MODELS = new Set([
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.5-plus',
]);

const REASONING_ANTHROPIC_MODELS = new Set([
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.5-plus',
]);

const MODEL_NAMES: Record<string, string> = {
  'glm-5.1': 'GLM-5.1',
  'glm-5': 'GLM-5',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2.6': 'Kimi K2.6',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'mimo-v2.5': 'MiMo-V2.5',
  'mimo-v2.5-pro': 'MiMo-V2.5-Pro',
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m2.5': 'MiniMax M2.5',
  'qwen3.7-max': 'Qwen3.7 Max',
  'qwen3.6-plus': 'Qwen3.6 Plus',
  'qwen3.5-plus': 'Qwen3.5 Plus',
};

const FALLBACK_MODELS: ModelInfo[] = Object.entries(MODEL_NAMES).map(([id, name]) => ({
  id,
  name,
  provider: 'opencode-go',
}));

interface OpenAIStreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  thinking?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
}

interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicMessageStart {
  type: 'message_start';
  message: {
    id: string;
    role: string;
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
}

interface AnthropicContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicContentBlock;
}

interface AnthropicContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

interface AnthropicContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

interface AnthropicMessageStop {
  type: 'message_stop';
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

interface OpenAICompatibleStreamLike {
  choices?: OpenAIStreamChoice[];
}

type AnthropicStreamEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicContentBlockStop
  | AnthropicMessageStop;

function parseSSEDataLine(line: string): string | null {
  if (line.startsWith('data:')) {
    return line.slice(5).trim();
  }

  // Some compatible gateways stream newline-delimited JSON without SSE prefixes.
  if (line.startsWith('{') && line.endsWith('}')) {
    return line.trim();
  }

  return null;
}

function getAnthropicEventType(parsed: Partial<AnthropicStreamEvent>, sseEventType: string): string {
  return typeof parsed.type === 'string' && parsed.type ? parsed.type : sseEventType;
}

function getAnthropicBlockIndex(parsed: Partial<AnthropicStreamEvent>): number | undefined {
  return 'index' in parsed && typeof parsed.index === 'number' ? parsed.index : undefined;
}

function getTextFromAnthropicContentBlock(contentBlock: AnthropicContentBlock): string {
  if (typeof contentBlock.text === 'string') {
    return contentBlock.text;
  }

  if (typeof contentBlock.thinking === 'string') {
    return contentBlock.thinking;
  }

  return '';
}

function isOpenAIModel(modelId: string): boolean {
  return OPENAI_COMPATIBLE_MODELS.has(modelId);
}

function isAnthropicModel(modelId: string): boolean {
  return ANTHROPIC_COMPATIBLE_MODELS.has(modelId);
}

function shouldRequestAnthropicThinking(modelId: string): boolean {
  return REASONING_ANTHROPIC_MODELS.has(modelId);
}

function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'ai-sdk/anthropic/jarvis',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

type OpenAIMessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

function toImageDataUrl(base64: string, mimeType = 'image/png'): string {
  return base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
}

function toImageBase64(image: string): string {
  return image.startsWith('data:') ? image.split(',', 2)[1] ?? image : image;
}

function convertContentToOpenAI(msg: ChatMessage): OpenAIMessageContent {
  if (!msg.images?.length) {
    return msg.content;
  }

  const content: Exclude<OpenAIMessageContent, string> = [];
  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  msg.images.forEach((image, index) => {
    content.push({
      type: 'image_url',
      image_url: { url: toImageDataUrl(image, msg.imageMimeTypes?.[index]) },
    });
  });

  return content;
}

function convertMessagesToOpenAI(messages: ChatMessage[]): Array<{
  role: string;
  content: OpenAIMessageContent;
  reasoning_content?: string;
  tool_calls?: Array<{
    type: 'function';
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}> {
  return messages.map((msg) => {
    if (msg.role === 'tool') {
      return {
        role: 'tool' as const,
        content: msg.content,
        tool_call_id: msg.tool_call_id || msg.tool_name || '',
      };
    }

    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      return {
        role: 'assistant' as const,
        content: msg.content || '',
        reasoning_content: msg.thinking || undefined,
        tool_calls: msg.tool_calls.map((tc) => ({
          type: 'function' as const,
          id: tc.id || tc.function.name,
          function: {
            name: tc.function.name,
            arguments:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
          },
        })),
      };
    }

    return {
      role: msg.role as string,
      content: convertContentToOpenAI(msg),
      reasoning_content: msg.role === 'assistant' ? msg.thinking : undefined,
    };
  });
}

function convertMessagesToAnthropic(
  messages: ChatMessage[],
): {
  system: string;
  convertedMessages: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }>;
} {
  const systemParts: string[] = [];
  const converted: Array<{
    role: 'user' | 'assistant';
    content: string | Array<Record<string, unknown>>;
  }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      converted.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id || msg.tool_name || '',
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const contentBlocks: Array<Record<string, unknown>> = [];

      if (msg.content) {
        contentBlocks.push({
          type: 'text',
          text: msg.content,
        });
      }

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id || tc.function.name,
            name: tc.function.name,
            input:
              typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments || '{}')
                : tc.function.arguments || {},
          });
        }
      }

      converted.push({
        role: 'assistant',
        content: contentBlocks.length > 0 ? contentBlocks : msg.content,
      });
      continue;
    }

    if (msg.images?.length) {
      const contentBlocks: Array<Record<string, unknown>> = [];
      if (msg.content) {
        contentBlocks.push({
          type: 'text',
          text: msg.content,
        });
      }

      msg.images.forEach((image, index) => {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: msg.imageMimeTypes?.[index] ?? 'image/png',
            data: toImageBase64(image),
          },
        });
      });

      converted.push({
        role: msg.role as 'user',
        content: contentBlocks,
      });
      continue;
    }

    converted.push({
      role: msg.role as 'user',
      content: msg.content,
    });
  }

  return {
    system: systemParts.join('\n\n'),
    convertedMessages: converted,
  };
}

function convertToolsToOpenAI(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));
}

function convertToolsToAnthropic(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

async function buildGoError(response: Response): Promise<Error> {
  const fallbackMessage = response.statusText.trim() || `HTTP ${response.status}`;
  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) return new Error(`OpenCode Go request failed (${response.status}): ${fallbackMessage}`);

    try {
      const parsed = JSON.parse(trimmed);
      const rawProviderError = parsed?.error?.metadata?.raw;
      let providerMessage = '';
      if (typeof rawProviderError === 'string') {
        try {
          const rawParsed = JSON.parse(rawProviderError);
          providerMessage = rawParsed?.error?.message || rawParsed?.message || rawProviderError;
        } catch {
          providerMessage = rawProviderError;
        }
      }
      const errorMsg = providerMessage || parsed?.error?.message || parsed?.error || parsed?.message || trimmed;
      return new Error(`OpenCode Go request failed (${response.status}): ${errorMsg}`);
    } catch {
      return new Error(`OpenCode Go request failed (${response.status}): ${trimmed}`);
    }
  } catch {
    return new Error(`OpenCode Go request failed (${response.status}): ${fallbackMessage}`);
  }
}

export class OpenCodeGoProvider implements Provider {
  readonly id = 'opencode-go';
  readonly name = 'OpenCode Go';
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.OPENCODE_GO_API_KEY || '';
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  getApiKey(): string | null {
    return this.apiKey || null;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      return FALLBACK_MODELS;
    }

    try {
      const response = await fetch(`${BASE_URL}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        console.error('[OpenCode Go] Failed to fetch models:', response.status);
        return FALLBACK_MODELS;
      }

      const data = await response.json() as {
        data?: Array<{ id: string; name?: string }>;
        models?: Array<{ id: string; name?: string }>;
      };

      const models = data.data || data.models || [];
      if (models.length > 0) {
        return models.map((m) => ({
          id: m.id,
          name: MODEL_NAMES[m.id] || m.name || m.id,
          provider: this.id,
        }));
      }

      return FALLBACK_MODELS;
    } catch (error) {
      console.error('[OpenCode Go] Error fetching models:', error);
      return FALLBACK_MODELS;
    }
  }

  async sendChat(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenCode Go API key not configured. Set OPENCODE_GO_API_KEY environment variable.');
    }

    if (isAnthropicModel(model)) {
      return this.sendChatAnthropic(model, messages, options);
    }
    return this.sendChatOpenAI(model, messages, options);
  }

  private async sendChatOpenAI(model: string, messages: ChatMessage[], _options?: SendChatOptions): Promise<string> {
    const openaiMessages = convertMessagesToOpenAI(messages);
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: openaiMessages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content || 'No response from model';
  }

  private async sendChatAnthropic(model: string, messages: ChatMessage[], _options?: SendChatOptions): Promise<string> {
    const { system, convertedMessages } = convertMessagesToAnthropic(messages);
    const body: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      max_tokens: 64000,
    };
    if (system) {
      body.system = system;
    }

    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(this.apiKey),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const textBlock = data.content?.find((b) => b.type === 'text' && b.text);
    return textBlock?.text || 'No response from model';
  }

  private async completeAnthropicNonStreaming(
    requestBody: Record<string, unknown>,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<ChatMessage | undefined> {
    const retryBody = {
      ...requestBody,
      stream: false,
    };

    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(this.apiKey),
      body: JSON.stringify(retryBody),
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    const data = (await response.json()) as AnthropicMessageResponse;
    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];

    for (const block of data.content || []) {
      if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          type: 'function',
          id: block.id,
          function: {
            name: block.name,
            arguments: block.input || {},
          },
        });
        continue;
      }

      const blockText = getTextFromAnthropicContentBlock(block);
      if (!blockText) continue;

      if (block.type === 'thinking') {
        accumulatedThinking += blockText;
        onChunk?.({ type: 'thinking', content: blockText });
      } else {
        accumulatedContent += blockText;
        onChunk?.({ type: 'content', content: blockText });
      }
    }

    if (!accumulatedContent && !accumulatedThinking && toolCalls.length === 0) {
      return undefined;
    }

    return {
      role: 'assistant',
      content: accumulatedContent,
      thinking: accumulatedThinking || undefined,
      tool_calls: toolCalls.length ? toolCalls : undefined,
    };
  }

  async streamChat(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    if (!this.apiKey) {
      throw new Error('OpenCode Go API key not configured. Set OPENCODE_GO_API_KEY environment variable.');
    }

    if (isAnthropicModel(model)) {
      return this.streamChatAnthropic(model, messages, abortController, onChunk, options);
    }
    return this.streamChatOpenAI(model, messages, abortController, onChunk, options);
  }

  private async streamChatOpenAI(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];
    const toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }> = new Map();

    const openaiMessages = convertMessagesToOpenAI(messages);
    const requestBody: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
    };

    if (options?.tools) {
      requestBody.tools = convertToolsToOpenAI(options.tools);
    }

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processSSELine = (line: string) => {
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        const choice = chunk.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;

        if (delta.reasoning_content) {
          accumulatedThinking += delta.reasoning_content;
          onChunk({ type: 'thinking', content: delta.reasoning_content });
          return;
        }

        if (delta.thinking) {
          accumulatedThinking += delta.thinking;
          onChunk({ type: 'thinking', content: delta.thinking });
          return;
        }

        if (delta.content) {
          accumulatedContent += delta.content;
          onChunk({ type: 'content', content: delta.content });
        }

        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccumulators.has(idx)) {
              toolCallAccumulators.set(idx, {
                id: tc.id || '',
                name: tc.function.name,
                arguments: tc.function.arguments,
              });
            } else {
              const existing = toolCallAccumulators.get(idx)!;
              existing.arguments += tc.function.arguments;
              if (tc.id) existing.id = tc.id;
              if (tc.function.name) existing.name = tc.function.name;
            }
          }
        }

        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
          if (choice.finish_reason === 'tool_calls') {
            for (const [, acc] of toolCallAccumulators) {
              let parsedArgs: Record<string, unknown>;
              try {
                parsedArgs = JSON.parse(acc.arguments || '{}');
              } catch {
                parsedArgs = {};
              }
              toolCalls.push({
                type: 'function',
                id: acc.id || acc.name,
                function: {
                  name: acc.name,
                  arguments: parsedArgs,
                },
              });
            }
          }
        }
      } catch (e) {
        console.error('[OpenCode Go] Error parsing SSE chunk:', e);
      }
    };

    try {
      while (true) {
        if (abortController.signal.aborted) {
          reader.cancel();
          throw new DOMException('Aborted', 'AbortError');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            processSSELine(line.trim());
          }
        }
      }

      if (buffer.trim()) {
        processSSELine(buffer.trim());
      }
    } catch (e) {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw e;
    }

    debugLog('[OpenCode Go] Stream complete:', {
      model,
      contentLength: accumulatedContent.length,
      thinkingLength: accumulatedThinking.length,
      toolCallCount: toolCalls.length,
    });

    return {
      assistantMessage:
        accumulatedContent || accumulatedThinking || toolCalls.length
          ? {
              role: 'assistant' as const,
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            }
          : undefined,
    };
  }

  private async streamChatAnthropic(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];
    const currentToolCalls: Map<string, { id: string; name: string; arguments: string }> = new Map();
    const toolCallIndexToId: Map<number, string> = new Map();

    const { system, convertedMessages } = convertMessagesToAnthropic(messages);
    const requestBody: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      max_tokens: 64000,
      stream: true,
    };

    if (shouldRequestAnthropicThinking(model)) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: 4096,
      };
    }

    if (system) {
      requestBody.system = system;
    }

    if (options?.tools) {
      requestBody.tools = convertToolsToAnthropic(options.tools);
    }

    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(this.apiKey),
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    const observedEventTypes = new Set<string>();
    const observedDeltaTypes = new Set<string>();

    const processSSELine = (line: string) => {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
        return;
      }

      const data = parseSSEDataLine(line);
      if (!data) return;
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data) as Partial<AnthropicStreamEvent> & OpenAICompatibleStreamLike;

        const openAIChoice = parsed.choices?.[0];
        if (openAIChoice?.delta) {
          const delta = openAIChoice.delta;
          observedEventTypes.add('openai_choices');
          if (delta.reasoning_content) {
            accumulatedThinking += delta.reasoning_content;
            onChunk({ type: 'thinking', content: delta.reasoning_content });
          }
          if (delta.thinking) {
            accumulatedThinking += delta.thinking;
            onChunk({ type: 'thinking', content: delta.thinking });
          }
          if (delta.content) {
            accumulatedContent += delta.content;
            onChunk({ type: 'content', content: delta.content });
          }
          return;
        }

        const currentEventType = getAnthropicEventType(parsed, eventType);
        if (currentEventType) {
          observedEventTypes.add(currentEventType);
        }

        if (currentEventType === 'content_block_delta') {
          const delta = 'delta' in parsed ? parsed.delta : undefined;
          if (!delta) return;
          if (delta.type) {
            observedDeltaTypes.add(delta.type);
          }

          if (delta.type === 'text_delta' && delta.text) {
            accumulatedContent += delta.text;
            onChunk({ type: 'content', content: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            accumulatedThinking += delta.thinking;
            onChunk({ type: 'thinking', content: delta.thinking });
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            const blockIndex = getAnthropicBlockIndex(parsed);
            const toolId = blockIndex === undefined ? undefined : toolCallIndexToId.get(blockIndex);
            if (toolId) {
              const existing = currentToolCalls.get(toolId);
              if (existing) {
                existing.arguments += delta.partial_json;
              }
            }
          }
        } else if (currentEventType === 'content_block_start') {
          const contentBlock = 'content_block' in parsed ? parsed.content_block : undefined;
          if (!contentBlock) return;
          observedDeltaTypes.add(`start:${contentBlock.type}`);

          const blockText = getTextFromAnthropicContentBlock(contentBlock);
          if (blockText) {
            if (contentBlock.type === 'thinking') {
              accumulatedThinking += blockText;
              onChunk({ type: 'thinking', content: blockText });
            } else {
              accumulatedContent += blockText;
              onChunk({ type: 'content', content: blockText });
            }
          }

          if (contentBlock.type === 'tool_use' && contentBlock.id && contentBlock.name) {
            const blockIndex = getAnthropicBlockIndex(parsed);
            if (blockIndex !== undefined) {
              toolCallIndexToId.set(blockIndex, contentBlock.id);
            }
            currentToolCalls.set(contentBlock.id, {
              id: contentBlock.id,
              name: contentBlock.name,
              arguments: '',
            });
          }
        } else if (currentEventType === 'content_block_stop') {
          // Tool use blocks are finalized when they stop
        } else if (currentEventType === 'message_stop') {
          // Message complete - finalize tool calls
          for (const [, tc] of currentToolCalls) {
            let parsedArgs: Record<string, unknown>;
            try {
              parsedArgs = JSON.parse(tc.arguments || '{}');
            } catch {
              parsedArgs = {};
            }
            toolCalls.push({
              type: 'function',
              id: tc.id,
              function: {
                name: tc.name,
                arguments: parsedArgs,
              },
            });
          }
        }
      } catch (e) {
        console.error('[OpenCode Go] Error parsing Anthropic SSE:', e);
      } finally {
        eventType = '';
      }
    };

    try {
      while (true) {
        if (abortController.signal.aborted) {
          reader.cancel();
          throw new DOMException('Aborted', 'AbortError');
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            processSSELine(line.trim());
          }
        }
      }

      if (buffer.trim()) {
        processSSELine(buffer.trim());
      }
    } catch (e) {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw e;
    }

    debugLog('[OpenCode Go] Anthropic stream complete:', {
      model,
      contentLength: accumulatedContent.length,
      thinkingLength: accumulatedThinking.length,
      toolCallCount: toolCalls.length,
      observedEventTypes: Array.from(observedEventTypes),
      observedDeltaTypes: Array.from(observedDeltaTypes),
    });

    if (!accumulatedContent && !accumulatedThinking && toolCalls.length === 0) {
      console.warn('[OpenCode Go] Anthropic stream returned no assistant output; retrying without streaming', {
        model,
        observedEventTypes: Array.from(observedEventTypes),
        observedDeltaTypes: Array.from(observedDeltaTypes),
      });

      const fallbackMessage = await this.completeAnthropicNonStreaming(requestBody, onChunk);
      if (fallbackMessage) {
        debugLog('[OpenCode Go] Anthropic non-stream fallback complete:', {
          model,
          contentLength: fallbackMessage.content.length,
          thinkingLength: fallbackMessage.thinking?.length || 0,
          toolCallCount: fallbackMessage.tool_calls?.length || 0,
        });
        return { assistantMessage: fallbackMessage };
      }
    }

    return {
      assistantMessage:
        accumulatedContent || accumulatedThinking || toolCalls.length
          ? {
              role: 'assistant' as const,
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            }
          : undefined,
    };
  }
}
