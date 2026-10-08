import type {
  ChatMessage,
  ModelInfo,
  ModelDiscoverySource,
  Provider,
  SendChatOptions,
  StreamChatTurnOptions,
  StreamChunk,
  StreamTurnResult,
} from './types';
import { debugLog } from '../logger';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_CLOUD_TAGS_URL = 'https://ollama.com/api/tags';

interface OllamaTagsResponse {
  models: Array<{ name?: string; model?: string }>;
}

interface OllamaShowResponse {
  capabilities?: string[];
  thinking?: { values?: unknown[]; default?: unknown };
}

type OllamaThink = boolean | string;

interface OllamaThinkingSupport {
  values: string[];
  defaultValue: string;
}

// Selector values for Ollama's boolean `think` setting.
const THINK_OFF = 'none';
const THINK_ON = 'on';
const SHOW_TIMEOUT_MS = 3_000;
const SHOW_CONCURRENCY = 6;

function toEffortValue(value: unknown): string | undefined {
  if (value === false) return THINK_OFF;
  if (value === true) return THINK_ON;
  return typeof value === 'string' && value ? value : undefined;
}

function toThinkValue(effort: string): OllamaThink {
  if (effort === THINK_OFF) return false;
  if (effort === THINK_ON) return true;
  return effort;
}

export function parseOllamaThinkingSupport(show: OllamaShowResponse): OllamaThinkingSupport | null {
  const listed = (show.thinking?.values ?? [])
    .map(toEffortValue)
    .filter((value): value is string => Boolean(value));
  const values = listed.length
    ? Array.from(new Set(listed))
    : show.capabilities?.includes('thinking') ? [THINK_OFF, THINK_ON] : [];
  if (values.length < 2) return null;
  const preferred = toEffortValue(show.thinking?.default);
  return {
    values,
    defaultValue: preferred && values.includes(preferred) ? preferred : values.find(value => value !== THINK_OFF) ?? values[0],
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
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

function getOllamaModelName(model: { name?: string; model?: string }): string {
  return (model.name || model.model || '').trim();
}

function toLocalCloudModelName(modelName: string): string {
  if (!modelName.includes(':')) {
    return `${modelName}:cloud`;
  }

  const [baseName, tag] = modelName.split(':', 2);
  if (!tag || tag === 'cloud' || tag.endsWith('-cloud')) {
    return modelName;
  }

  return `${baseName}:${tag}-cloud`;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private baseUrl: string;
  private cloudTagsUrl: string;
  // undefined: capabilities unknown; null: the model cannot think.
  private readonly thinkingSupport = new Map<string, OllamaThinkingSupport | null>();
  readonly modelSources: readonly ModelDiscoverySource[];

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
    this.cloudTagsUrl = process.env.OLLAMA_CLOUD_TAGS_URL || DEFAULT_CLOUD_TAGS_URL;
    this.modelSources = [
      { id: 'local', fetchModels: signal => this.fetchLocalModels(signal) },
      ...(process.env.OLLAMA_INCLUDE_CLOUD_MODELS === 'false' ? [] : [
        { id: 'cloud', fetchModels: (signal?: AbortSignal) => this.fetchCloudModels(signal) },
      ]),
    ];
  }

  getApiKey(): string | null {
    return null;
  }

  async fetchModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    // Direct callers also retain successful sources when another source fails.
    const results = await Promise.allSettled(this.modelSources.map(source => source.fetchModels(signal)));
    const models = new Map<string, ModelInfo>();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const model of result.value) if (!models.has(model.id)) models.set(model.id, model);
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async fetchLocalModels(signal = AbortSignal.timeout(5_000)): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!response.ok) throw new Error(`Failed to fetch local models: ${response.statusText}`);
    const data = await response.json() as OllamaTagsResponse;
    const names = (data.models || []).map(getOllamaModelName).filter(Boolean);
    return this.withThinkingSupport(names.map(name => ({ id: name, showUrl: `${this.baseUrl}/api/show`, showName: name })), signal);
  }

  private async fetchCloudModels(signal = AbortSignal.timeout(5_000)): Promise<ModelInfo[]> {
    const headers: Record<string, string> = {};
    const cloudApiKey = process.env.OLLAMA_API_KEY?.trim();
    if (cloudApiKey) headers.Authorization = `Bearer ${cloudApiKey}`;
    const response = await fetch(this.cloudTagsUrl, { headers, signal });
    if (!response.ok) throw new Error(`Failed to fetch cloud models: ${response.statusText}`);
    const data = await response.json() as OllamaTagsResponse;
    const showUrl = this.cloudTagsUrl.replace(/\/api\/tags\/?$/, '/api/show');
    const names = (data.models || []).map(getOllamaModelName).filter(Boolean);
    return this.withThinkingSupport(
      names.map(name => ({ id: toLocalCloudModelName(name), showUrl, showName: name, headers })),
      signal,
    );
  }

  private async withThinkingSupport(
    models: Array<{ id: string; showUrl: string; showName: string; headers?: Record<string, string> }>,
    signal: AbortSignal,
  ): Promise<ModelInfo[]> {
    // Capability lookups are best effort and must not hold up the model list.
    const showSignal = AbortSignal.any([signal, AbortSignal.timeout(SHOW_TIMEOUT_MS)]);
    return mapWithConcurrency(models, SHOW_CONCURRENCY, async ({ id, showUrl, showName, headers }) => {
      const model: ModelInfo = { id, name: id, provider: this.id };
      try {
        const response = await fetch(showUrl, {
          method: 'POST',
          signal: showSignal,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ model: showName }),
        });
        if (!response.ok) return model;
        const support = parseOllamaThinkingSupport(await response.json() as OllamaShowResponse);
        this.thinkingSupport.set(id, support);
        return support
          ? { ...model, reasoningEfforts: support.values.map(value => ({ value })), defaultReasoningEffort: support.defaultValue }
          : model;
      } catch {
        return model;
      }
    });
  }

  private getThinkValue(model: string, effort: string | undefined): OllamaThink | undefined {
    const support = this.thinkingSupport.get(model);
    // Unknown capabilities keep the previous always-think request.
    if (support === undefined) return true;
    if (support === null) return undefined;
    return toThinkValue(effort && support.values.includes(effort) ? effort : support.defaultValue);
  }

  async sendChat(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    const requestBody: Record<string, unknown> = { model, messages, stream: false };
    if (options?.keepAlive !== undefined) {
      requestBody.keep_alive = options.keepAlive;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      signal: options?.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
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
      options: { num_predict: 64000 },
    };
    const think = this.getThinkValue(model, options?.reasoningEffort);
    if (think !== undefined) {
      requestBody.think = think;
    }

    if (options?.keepAlive !== undefined) {
      requestBody.keep_alive = options.keepAlive;
    }

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

    let latestUsage: StreamTurnResult['usage'];

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
      if (data.done === true) {
        latestUsage = {
          inputTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
          generationMs: data.eval_duration ? Math.round(data.eval_duration / 1e6) : undefined,
        };
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
      usage: latestUsage,
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
  debugLog('[Ollama] Stream terminated:', {
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
