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

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TITLE = 'Jarvis';

interface OpenRouterModel {
  id: string;
  name?: string;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

interface OpenAIStreamDelta {
  content?: string;
  reasoning_content?: string;
  thinking?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
}

function convertMessagesToOpenAI(messages: ChatMessage[]): Array<{
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
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
      content: msg.content,
      reasoning_content: msg.role === 'assistant' ? msg.thinking : undefined,
    };
  });
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

function parseOutputModalitiesFromModality(modality?: string): string[] {
  if (!modality || !modality.includes('->')) {
    return [];
  }

  const [, output] = modality.split('->', 2);
  return output
    .split(/[,+]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function hasTextOutput(model: OpenRouterModel): boolean {
  const outputModalities = model.architecture?.output_modalities;
  if (Array.isArray(outputModalities)) {
    return outputModalities.some((modality) => modality.toLowerCase() === 'text');
  }

  return parseOutputModalitiesFromModality(model.architecture?.modality).includes('text');
}

async function buildOpenRouterError(response: Response): Promise<Error> {
  const fallbackMessage = response.statusText.trim() || `HTTP ${response.status}`;
  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) return new Error(`OpenRouter request failed (${response.status}): ${fallbackMessage}`);

    try {
      const parsed = JSON.parse(trimmed);
      const errorMsg = parsed?.error?.message || parsed?.error || parsed?.message || trimmed;
      return new Error(`OpenRouter request failed (${response.status}): ${errorMsg}`);
    } catch {
      return new Error(`OpenRouter request failed (${response.status}): ${trimmed}`);
    }
  } catch {
    return new Error(`OpenRouter request failed (${response.status}): ${fallbackMessage}`);
  }
}

export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl?: string) {
    this.apiKey = apiKey || process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = (baseUrl || process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  getApiKey(): string | null {
    return this.apiKey || null;
  }

  private buildHeaders(includeAuth: boolean = true): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (includeAuth && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const referer = process.env.OPENROUTER_REFERER || process.env.OPENROUTER_SITE_URL;
    const title = process.env.OPENROUTER_TITLE || process.env.OPENROUTER_SITE_NAME || DEFAULT_TITLE;
    if (referer) headers['HTTP-Referer'] = referer;
    if (title) headers['X-OpenRouter-Title'] = title;

    return headers;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models?output_modalities=text`, {
        headers: this.buildHeaders(Boolean(this.apiKey)),
      });

      if (!response.ok) {
        console.error('[OpenRouter] Failed to fetch models:', response.status);
        return [];
      }

      const data = await response.json() as OpenRouterModelsResponse;
      return (data.data || [])
        .filter(hasTextOutput)
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          provider: this.id,
        }));
    } catch (error) {
      console.error('[OpenRouter] Error fetching models:', error);
      return [];
    }
  }

  async sendChat(model: string, messages: ChatMessage[], _options?: SendChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        model,
        messages: convertMessagesToOpenAI(messages),
        stream: false,
      }),
    });

    if (!response.ok) {
      throw await buildOpenRouterError(response);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || 'No response from model';
  }

  async streamChat(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.');
    }

    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];
    const toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }> = new Map();

    const requestBody: Record<string, unknown> = {
      model,
      messages: convertMessagesToOpenAI(messages),
      stream: true,
    };
    if (options?.tools) {
      requestBody.tools = convertToolsToOpenAI(options.tools);
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw await buildOpenRouterError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const finalizeToolCalls = () => {
      for (const [, acc] of toolCallAccumulators) {
        if (!acc.name || toolCalls.some((tc) => tc.id === (acc.id || acc.name))) {
          continue;
        }

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
    };

    const processSSELine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        finalizeToolCalls();
        return;
      }

      try {
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        const choice = chunk.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
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

        if (delta.tool_calls?.length) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const functionName = tc.function?.name || '';
            const functionArguments = tc.function?.arguments || '';
            if (!toolCallAccumulators.has(idx)) {
              toolCallAccumulators.set(idx, {
                id: tc.id || '',
                name: functionName,
                arguments: functionArguments,
              });
            } else {
              const existing = toolCallAccumulators.get(idx)!;
              existing.arguments += functionArguments;
              if (tc.id) existing.id = tc.id;
              if (functionName) existing.name = functionName;
            }
          }
        }

        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
          finalizeToolCalls();
        }
      } catch (error) {
        console.error('[OpenRouter] Error parsing SSE chunk:', error);
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
      finalizeToolCalls();
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw error;
    }

    console.log('[OpenRouter] Stream complete:', {
      model,
      contentLength: accumulatedContent.length,
      thinkingLength: accumulatedThinking.length,
      toolCallCount: toolCalls.length,
    });

    return {
      assistantMessage:
        accumulatedContent || accumulatedThinking || toolCalls.length
          ? {
              role: 'assistant',
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            }
          : undefined,
    };
  }
}
