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
import { TOOL_IMAGE_FOLLOW_UP_TEXT, withToolImageFollowUps } from './toolImages';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TITLE = 'Jarvis';
const ALL_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const LEGACY_XAI_REASONING_EFFORTS = ['low', 'medium', 'high'];

interface OpenRouterReasoningCapabilities {
  supported_efforts?: string[] | null;
  default_effort?: string | null;
  default_enabled?: boolean;
  mandatory?: boolean;
  supports_max_tokens?: boolean;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  reasoning?: OpenRouterReasoningCapabilities;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

export function getOpenRouterReasoningSettings(
  model: Pick<OpenRouterModel, 'id' | 'reasoning'>,
): Pick<ModelInfo, 'reasoningEfforts' | 'defaultReasoningEffort'> {
  const capabilities = model.reasoning;
  if (!capabilities) {
    // Older OpenRouter catalog responses did not include structured reasoning
    // metadata for xAI. Preserve the behavior Jarvis already had for those rows.
    return model.id.toLowerCase().startsWith('x-ai/')
      ? {
          reasoningEfforts: LEGACY_XAI_REASONING_EFFORTS.map(value => ({ value })),
          defaultReasoningEffort: 'high',
        }
      : {};
  }

  if (capabilities.supported_efforts === undefined) {
    return {};
  }

  const catalogEfforts = capabilities.supported_efforts === null
    ? ALL_REASONING_EFFORTS
    : capabilities.supported_efforts;
  const uniqueEfforts = Array.from(new Set(
    catalogEfforts.filter(effort => typeof effort === 'string' && effort.length > 0),
  ));
  if (uniqueEfforts.length === 0) {
    return {};
  }
  const efforts = capabilities.mandatory
    ? uniqueEfforts.filter(effort => effort !== 'none')
    : ['none', ...uniqueEfforts.filter(effort => effort !== 'none')];

  if (efforts.length === 0) {
    return {};
  }

  const shouldDefaultOff = capabilities.default_enabled === false
    || capabilities.default_effort === 'none';
  const catalogDefault = shouldDefaultOff ? 'none' : capabilities.default_effort;
  const defaultReasoningEffort = catalogDefault && efforts.includes(catalogDefault)
    ? catalogDefault
    : efforts.find(effort => effort !== 'none') ?? efforts[0];

  return {
    reasoningEfforts: efforts.map(value => ({
      value,
      ...(value === 'none' ? { description: 'Use the model without optional reasoning.' } : {}),
    })),
    defaultReasoningEffort,
  };
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

interface OpenAIStreamDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  thinking?: string;
  reasoning_details?: OpenRouterReasoningDetail[];
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenRouterReasoningDetail {
  type?: string;
  text?: string;
  summary?: string;
}

interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

type OpenAIMessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

function toImageDataUrl(base64: string, mimeType = 'image/png'): string {
  return base64.startsWith('data:') ? base64 : `data:${mimeType};base64,${base64}`;
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
  return withToolImageFollowUps<ReturnType<typeof convertMessagesToOpenAI>[number]>(messages, (msg) => {
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
  }, (images) => ({
    role: 'user',
    content: [
      { type: 'text', text: TOOL_IMAGE_FOLLOW_UP_TEXT },
      ...images.map(({ image, mimeType }) => ({
        type: 'image_url',
        image_url: { url: toImageDataUrl(image, mimeType) },
      })),
    ],
  }));
}

function extractReasoningDetails(details?: OpenRouterReasoningDetail[]): string {
  if (!details) return '';

  return details.map((detail) => {
    if (typeof detail.text === 'string') return detail.text;
    if (typeof detail.summary === 'string') return detail.summary;
    return '';
  }).join('');
}

function getThinkingDelta(delta: OpenAIStreamDelta): string {
  return delta.reasoning
    || delta.reasoning_content
    || delta.thinking
    || extractReasoningDetails(delta.reasoning_details);
}

function normalizeXaiToolSchema(value: unknown, isRootSchema = true): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeXaiToolSchema(entry, false));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      // OpenRouter's xAI adapter rejects boolean schemas used by nested
      // additionalProperties entries. An empty schema object is the standard
      // non-boolean equivalent of `true`, while keeping the root tool schema
      // unchanged preserves its intended argument validation.
      if (!isRootSchema && key === 'additionalProperties' && typeof entry === 'boolean') {
        return [key, {}];
      }

      return [key, normalizeXaiToolSchema(entry, false)];
    }),
  );
}

function convertToolsToOpenAI(tools: ToolDefinition[], useXaiSchemaCompatibility: boolean) {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: useXaiSchemaCompatibility
        ? normalizeXaiToolSchema(tool.function.parameters)
        : tool.function.parameters,
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
  const requestId = response.headers.get('x-request-id')
    || response.headers.get('x-openrouter-request-id')
    || undefined;

  const appendRequestId = (message: string): string => (
    requestId ? `${message} (request_id=${requestId})` : message
  );

  const asRecord = (value: unknown): Record<string, unknown> | undefined => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  );

  const asString = (value: unknown): string | undefined => (
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  );

  const truncate = (value: string, maxLength = 800): string => (
    value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`
  );

  try {
    const body = await response.text();
    const trimmed = body.trim();
    if (!trimmed) {
      return new Error(appendRequestId(`OpenRouter request failed (${response.status}): ${fallbackMessage}`));
    }

    try {
      const parsed = asRecord(JSON.parse(trimmed));
      const errorValue = parsed?.error;
      const errorRecord = asRecord(errorValue);
      const metadata = asRecord(errorRecord?.metadata);
      const errorMessage = asString(errorRecord?.message)
        || asString(errorValue)
        || asString(parsed?.message)
        || truncate(trimmed);
      const details = [
        asString(errorRecord?.code) ? `code=${asString(errorRecord?.code)}` : undefined,
        asString(metadata?.provider_name) ? `provider=${asString(metadata?.provider_name)}` : undefined,
        asString(metadata?.raw) && asString(metadata?.raw) !== errorMessage
          ? `raw=${truncate(asString(metadata?.raw)!)}`
          : undefined,
      ].filter(Boolean).join('; ');
      const suffix = details ? ` [${details}]` : '';
      return new Error(appendRequestId(`OpenRouter request failed (${response.status}): ${errorMessage}${suffix}`));
    } catch {
      return new Error(appendRequestId(`OpenRouter request failed (${response.status}): ${truncate(trimmed)}`));
    }
  } catch {
    return new Error(appendRequestId(`OpenRouter request failed (${response.status}): ${fallbackMessage}`));
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

  async fetchModels(signal = AbortSignal.timeout(5_000)): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/models?output_modalities=text`, {
        signal,
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
          contextLength: model.context_length,
          ...getOpenRouterReasoningSettings(model),
        }));
    } catch (error) {
      console.error('[OpenRouter] Error fetching models:', error);
      return [];
    }
  }

  async sendChat(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: options?.signal,
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

    const startedAtMs = Date.now();
    let firstOutputAtMs: number | undefined;
    let usage: StreamTurnResult['usage'];

    const requestBody: Record<string, unknown> = {
      model,
      messages: convertMessagesToOpenAI(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    const isXaiModel = model.toLowerCase().startsWith('x-ai/');
    if (options?.reasoningEffort) {
      requestBody.reasoning = { effort: options.reasoningEffort, exclude: false };
    }
    const tools = options?.tools ?? [];
    const hasTools = tools.length > 0;
    if (hasTools) {
      requestBody.tools = convertToolsToOpenAI(tools, isXaiModel);
    }

    const sendStreamRequest = (body: Record<string, unknown>) => fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    const response = await sendStreamRequest(requestBody);
    if (!response.ok) {
      const error = await buildOpenRouterError(response);
      console.error('[OpenRouter] Chat request rejected:', {
        model,
        status: response.status,
        requestId: response.headers.get('x-request-id')
          || response.headers.get('x-openrouter-request-id')
        || undefined,
        hasTools,
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.function.name),
        error: error.message,
      });
      throw error;
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    debugLog('[OpenRouter] Stream response accepted:', {
      model,
      status: response.status,
      requestId: response.headers.get('x-request-id')
        || response.headers.get('x-openrouter-request-id')
      || undefined,
      hasTools,
      toolCount: tools.length,
      toolNames: tools.map((tool) => tool.function.name),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDoneSentinel = false;
    let chunkCount = 0;
    let parseErrorCount = 0;
    let lastFinishReason: string | undefined;

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

    const markOutput = () => {
      if (firstOutputAtMs === undefined) firstOutputAtMs = Date.now();
    };

    const processSSELine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data) {
        return;
      }
      if (data === '[DONE]') {
        sawDoneSentinel = true;
        finalizeToolCalls();
        return;
      }

      try {
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        chunkCount += 1;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) return;

        if (choice.finish_reason) {
          lastFinishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        const thinkingDelta = getThinkingDelta(delta);
        if (thinkingDelta) {
          accumulatedThinking += thinkingDelta;
          markOutput();
          onChunk({ type: 'thinking', content: thinkingDelta });
        }
        if (delta.content) {
          accumulatedContent += delta.content;
          markOutput();
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
        parseErrorCount += 1;
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

      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (!sawDoneSentinel) {
        const diagnostic = {
          model,
          chunkCount,
          parseErrorCount,
          lastFinishReason: lastFinishReason ?? null,
          contentLength: accumulatedContent.length,
          thinkingLength: accumulatedThinking.length,
          toolCallCount: toolCalls.length,
        };
        console.error('[OpenRouter] Stream ended before [DONE]:', diagnostic);
        throw new Error(
          `OpenRouter stream ended unexpectedly before [DONE] (chunks=${chunkCount}, `
          + `finish_reason=${lastFinishReason ?? 'none'}, content_length=${accumulatedContent.length}).`
        );
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw error;
    }

    debugLog('[OpenRouter] Stream complete:', {
      model,
      contentLength: accumulatedContent.length,
      thinkingLength: accumulatedThinking.length,
      toolCallCount: toolCalls.length,
      chunkCount,
      parseErrorCount,
      sawDoneSentinel,
      finishReason: lastFinishReason,
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
      usage: usage ?? {
        generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
      },
    };
  }
}
