import type {
  ChatMessage,
  ModelInfo,
  Provider,
  StreamChatTurnOptions,
  StreamChunk,
  StreamTurnResult,
  ToolDefinition,
} from './types';

const DEFAULT_BASE_URL = 'http://localhost:11434';

interface OllamaTagsResponse {
  models: { name: string }[];
}

interface OllamaChatResponse {
  message: {
    content: string;
    thinking?: string;
    tool_calls?: import('./types').ToolCall[];
  };
}

interface OllamaStreamResponse {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: import('./types').ToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  }

  getApiKey(): string | null {
    return null;
  }

  async fetchModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.statusText}`);
      }
      const data = (await response.json()) as OllamaTagsResponse;
      return (data.models || []).map((m) => ({
        id: m.name,
        name: m.name,
        provider: this.id,
      }));
    } catch (error) {
      console.error('[Ollama] Error fetching models:', error);
      return [];
    }
  }

  async sendChat(model: string, messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
    });

    if (!response.ok) {
      throw await buildOllamaError(response);
    }

    const data = (await response.json()) as OllamaChatResponse;
    return data.message?.content || 'No response from model';
  }

  async streamChat(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];

    const requestTools = options?.tools === undefined ? undefined : options.tools;
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      think: true,
      options: { num_predict: 64000 },
    };

    if (requestTools) {
      requestBody.tools = requestTools;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw await buildOllamaError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processChunk = (data: OllamaStreamResponse) => {
      if (data.message?.thinking) {
        accumulatedThinking += data.message.thinking;
        onChunk({ type: 'thinking', content: data.message.thinking });
      }
      if (data.message?.content) {
        accumulatedContent += data.message.content;
        onChunk({ type: 'content', content: data.message.content });
      }
      if (data.message?.tool_calls?.length) {
        toolCalls.push(...data.message.tool_calls);
      }
    };

    const buildResult = (): StreamTurnResult => ({
      assistantMessage:
        accumulatedContent || accumulatedThinking || toolCalls.length
          ? {
              role: 'assistant',
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              tool_calls: toolCalls.length ? toolCalls : undefined,
            }
          : undefined,
    });

    while (true) {
      if (abortController.signal.aborted) {
        reader.cancel();
        throw new DOMException('Aborted', 'AbortError');
      }

      const readPromise = reader.read();
      const abortPromise = new Promise<never>((_, reject) => {
        const checkAbort = () => {
          if (abortController.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          }
        };
        abortController.signal.addEventListener('abort', checkAbort);
        setTimeout(() => {
          abortController.signal.removeEventListener('abort', checkAbort);
          checkAbort();
        }, 50);
      });

      const { done, value } = await Promise.race([readPromise, abortPromise]);

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line) as OllamaStreamResponse;
            processChunk(data);
            if (data.done === true) {
              logStreamEnd(data, accumulatedContent.length, accumulatedThinking.length, toolCalls.length);
              return buildResult();
            }
          } catch (e) {
            console.error('[Ollama] Error parsing stream line:', e);
          }
        }
      }
    }

    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer) as OllamaStreamResponse;
        processChunk(data);
        if (data.done === true) {
          logStreamEnd(data, accumulatedContent.length, accumulatedThinking.length, toolCalls.length);
          return buildResult();
        }
      } catch (e) {
        console.error('[Ollama] Error parsing final stream line:', e);
      }
    }

    return buildResult();
  }
}

function logStreamEnd(
  data: OllamaStreamResponse,
  contentLength: number,
  thinkingLength: number,
  toolCallCount: number,
) {
  console.log('[Ollama] Stream terminated:', {
    reason: data.done_reason || 'unknown',
    prompt_tokens: data.prompt_eval_count,
    response_tokens: data.eval_count,
    total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
    content_length: contentLength,
    thinking_length: thinkingLength,
    tool_call_count: toolCallCount,
  });
}

function parseOllamaErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // fall back to raw body
  }

  return trimmed;
}

async function buildOllamaError(response: Response): Promise<Error> {
  const fallbackMessage = response.statusText.trim() || `HTTP ${response.status}`;

  try {
    const responseBody = await response.text();
    const details = parseOllamaErrorBody(responseBody);
    if (details) {
      return new Error(`Ollama request failed (${response.status}): ${details}`);
    }
  } catch {
    // ignore body parsing failures
  }

  return new Error(`Ollama request failed (${response.status}): ${fallbackMessage}`);
}