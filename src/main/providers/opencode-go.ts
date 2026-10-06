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
import {
  GO_REASONING_SNAPSHOT,
  MODELS_DEV_URL,
  applyGoReasoning,
  getGoReasoningSettings,
  parseModelsDevGoCatalog,
  protocolFromNpm,
  type GoCatalogEntry,
  type GoProtocol,
  type GoReasoningSpec,
} from './opencodeGoReasoning';

const BASE_URL = 'https://opencode.ai/zen/go/v1';

const JARVIS_USER_AGENT = 'jarvis/1.0.0';

// Endpoint routing per https://opencode.ai/docs/go/#endpoints
// - /responses (OpenAI Responses API): grok, gpt luna, muse spark
// - /messages (Anthropic Messages API): minimax, qwen
// - /chat/completions (OpenAI Chat Completions): everything else
const RESPONSES_MODELS = new Set([
  'grok-4.7',
  'grok-4.6',
  'gpt-6-luna',
  'gpt-5.6-luna',
  'muse-spark-1.3-contributor',
  'muse-spark-1.2-contributor',
]);

const ANTHROPIC_COMPATIBLE_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  // Legacy MiniMax id kept for existing saved selections.
  'minimax-m2.5',
  'qwen3.8-max',
  'qwen3.8-flash',
  'qwen3.7-plus',
  // Legacy Qwen ids kept for existing saved selections.
  'qwen3.7-max',
  'qwen3.6-plus',
  'qwen3.5-plus',
]);

const MODEL_NAMES: Record<string, string> = {
  // Current Go catalog per https://opencode.ai/docs/go/ (Oct 2026).
  'grok-4.7': 'Grok 4.7',
  'grok-4.6': 'Grok 4.6',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.3': 'GLM-5.3',
  'glm-5.2': 'GLM-5.2',
  'gpt-6-luna': 'GPT 6 Luna',
  'gpt-5.6-luna': 'GPT 5.6 Luna',
  'kimi-k3': 'Kimi K3',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k2.6': 'Kimi K2.6',
  'longcat-2.0': 'LongCat 2.0',
  'longcat-2.5-preview-free': 'LongCat 2.5 Preview Free',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash-vision-exp': 'DeepSeek V4 Flash Vision Exp',
  'mimo-v2.6-flash': 'MiMo-V2.6 Flash',
  'mimo-v2.6-pro': 'MiMo-V2.6 Pro',
  'mimo-v2.5': 'MiMo-V2.5',
  'mimo-v2.5-pro': 'MiMo-V2.5-Pro',
  'minimax-m3': 'MiniMax M3',
  'minimax-m2.7': 'MiniMax M2.7',
  'muse-spark-1.3-contributor': 'Muse Spark 1.3 Contributor',
  'muse-spark-1.2-contributor': 'Muse Spark 1.2 Contributor',
  'qwen3.8-max': 'Qwen3.8 Max',
  'qwen3.8-flash': 'Qwen3.8 Flash',
  'qwen3.7-plus': 'Qwen3.7 Plus',
  'hy4-preview': 'Hy4 Preview',
  'hy3': 'Hy3',
  'space-bunny-free': 'Space Bunny Free',
  // Legacy ids kept so existing saved selections keep working.
  'glm-5.1': 'GLM-5.1',
  'glm-5': 'GLM-5',
  'kimi-k2.5': 'Kimi K2.5',
  'minimax-m2.5': 'MiniMax M2.5',
  'qwen3.7-max': 'Qwen3.7 Max',
  'qwen3.6-plus': 'Qwen3.6 Plus',
  'qwen3.5-plus': 'Qwen3.5 Plus',
};

const MODELS_DEV_TTL_MS = 6 * 60 * 60_000;
// Optional metadata must finish well before the five-second model-discovery deadline.
const MODELS_DEV_TIMEOUT_MS = 1_000;
let modelsDevCatalog: { entries: Map<string, GoCatalogEntry>; fetchedAt: number } | undefined;

async function refreshModelsDevCatalog(signal: AbortSignal): Promise<void> {
  if (modelsDevCatalog && Date.now() - modelsDevCatalog.fetchedAt < MODELS_DEV_TTL_MS) return;
  const controller = new AbortController();
  const catalogSignal = AbortSignal.any([signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      (async () => {
        const response = await fetch(MODELS_DEV_URL, { signal: catalogSignal, headers: { 'User-Agent': JARVIS_USER_AGENT } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return parseModelsDevGoCatalog(await response.json());
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Reasoning metadata discovery timed out'));
        }, MODELS_DEV_TIMEOUT_MS);
      }),
    ]);
    if (entries.size > 0) modelsDevCatalog = { entries, fetchedAt: Date.now() };
  } catch (error) {
    console.warn('[OpenCode Go] Using bundled reasoning capabilities:', error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function getReasoningSpec(modelId: string): GoReasoningSpec | undefined {
  return modelsDevCatalog?.entries.get(modelId)?.reasoning ?? GO_REASONING_SNAPSHOT[modelId];
}

function getGoProtocol(modelId: string): GoProtocol {
  if (RESPONSES_MODELS.has(modelId)) return 'responses';
  if (ANTHROPIC_COMPATIBLE_MODELS.has(modelId)) return 'anthropic';
  return protocolFromNpm(modelsDevCatalog?.entries.get(modelId)?.npm) ?? 'chat';
}

function addReasoning(body: Record<string, unknown>, model: string, effort: string | undefined): void {
  applyGoReasoning(body, getReasoningSpec(model), getGoProtocol(model), effort);
}

function toModelInfo(id: string, name: string): ModelInfo {
  return {
    id,
    name,
    provider: 'opencode-go',
    ...getGoReasoningSettings(getReasoningSpec(id), getGoProtocol(id)),
  };
}

function getFallbackModels(): ModelInfo[] {
  return Object.entries(MODEL_NAMES).map(([id, name]) => toModelInfo(id, name));
}

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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
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

interface AnthropicMessageDelta {
  type: 'message_delta';
  usage?: { input_tokens?: number; output_tokens?: number };
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
  | AnthropicMessageDelta
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

function isAnthropicModel(modelId: string): boolean {
  return getGoProtocol(modelId) === 'anthropic';
}

function isResponsesModel(modelId: string): boolean {
  return getGoProtocol(modelId) === 'responses';
}

interface GoSessionOptions {
  conversationId?: string;
  contextKey?: string;
  sessionId?: string;
}

function resolveGoSessionId(options?: GoSessionOptions): string {
  const stable = options?.sessionId || options?.conversationId || options?.contextKey;
  if (stable && stable.trim()) return stable.trim();
  try {
    const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // fall through to fallback below
  }
  return `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildGoHeaders(apiKey: string, sessionId: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'User-Agent': JARVIS_USER_AGENT,
    'x-opencode-session': sessionId,
  };
}

function buildAnthropicHeaders(apiKey: string, sessionId: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    // Use a distinct client UA per Go docs ("identify itself with its own
    // user agent ... rather than a generic SDK name").
    'User-Agent': JARVIS_USER_AGENT,
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'x-opencode-session': sessionId,
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
            content: msg.images?.length
              ? [
                { type: 'text', text: msg.content },
                ...msg.images.map((image, index) => ({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: msg.imageMimeTypes?.[index] ?? 'image/png',
                    data: toImageBase64(image),
                  },
                })),
              ]
              : msg.content,
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

function convertToolsToResponses(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function convertMessagesToResponses(messages: ChatMessage[], model: string): {
  instructions: string;
  input: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  let pendingToolImages: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role !== 'tool' && pendingToolImages.length) {
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: TOOL_IMAGE_FOLLOW_UP_TEXT }, ...pendingToolImages],
      });
      pendingToolImages = [];
    }

    if (msg.role === 'system') {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || msg.tool_name || '',
        output: msg.content,
      });
      msg.images?.forEach((image, index) => {
        pendingToolImages.push({
          type: 'input_image',
          image_url: toImageDataUrl(image, msg.imageMimeTypes?.[index]),
        });
      });
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.openCodeGoResponse?.model === model && msg.openCodeGoResponse.output.length) {
        input.push(...msg.openCodeGoResponse.output);
        continue;
      }
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        const args = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments ?? {});
        input.push({
          type: 'function_call',
          call_id: tc.id || tc.function.name,
          name: tc.function.name,
          arguments: args,
        });
      }
      if (!msg.content && !(msg.tool_calls?.length)) {
        input.push({ role: 'assistant', content: '' });
      }
      continue;
    }

    // user
    if (msg.images?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: 'input_text', text: msg.content });
      }
      msg.images.forEach((image, index) => {
        content.push({
          type: 'input_image',
          image_url: toImageDataUrl(image, msg.imageMimeTypes?.[index]),
        });
      });
      input.push({ role: 'user', content });
      continue;
    }

    input.push({ role: 'user', content: msg.content });
  }

  if (pendingToolImages.length) {
    input.push({
      role: 'user',
      content: [{ type: 'input_text', text: TOOL_IMAGE_FOLLOW_UP_TEXT }, ...pendingToolImages],
    });
  }

  return { instructions: systemParts.join('\n\n'), input };
}

interface ResponsesMessageResponse {
  status?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  error?: { message?: string };
  incomplete_details?: { reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function assertResponsesComplete(response: ResponsesMessageResponse): void {
  if (response.status === 'failed') {
    throw new Error(`OpenCode Go request failed: ${response.error?.message || 'response failed'}`);
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown reason';
    throw new Error(`OpenCode Go response stopped early (${reason}). You can regenerate or ask to continue.`);
  }
}

function getResponsesContent(item: Record<string, unknown>): Array<{
  type?: string;
  text?: string;
  refusal?: string;
}> {
  return item.type === 'message' && Array.isArray(item.content) ? item.content : [];
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

  getApiKey(): string | null {
    return this.apiKey || null;
  }

  async fetchModels(signal = AbortSignal.timeout(5_000)): Promise<ModelInfo[]> {
    if (!this.apiKey) {
      return getFallbackModels();
    }

    try {
      const [response] = await Promise.all([
        fetch(`${BASE_URL}/models`, {
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': JARVIS_USER_AGENT,
          },
        }),
        refreshModelsDevCatalog(signal),
      ]);

      if (!response.ok) {
        console.error('[OpenCode Go] Failed to fetch models:', response.status);
        return getFallbackModels();
      }

      const data = await response.json() as {
        data?: Array<{ id: string; name?: string }>;
        models?: Array<{ id: string; name?: string }>;
      };

      const models = data.data || data.models || [];
      if (models.length > 0) {
        return models.map((m) => toModelInfo(m.id, MODEL_NAMES[m.id] || m.name || m.id));
      }

      return getFallbackModels();
    } catch (error) {
      console.error('[OpenCode Go] Error fetching models:', error);
      return getFallbackModels();
    }
  }

  async sendChat(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('OpenCode Go API key not configured. Set OPENCODE_GO_API_KEY environment variable.');
    }

    if (isResponsesModel(model)) {
      return this.sendChatResponses(model, messages, options);
    }
    if (isAnthropicModel(model)) {
      return this.sendChatAnthropic(model, messages, options);
    }
    return this.sendChatOpenAI(model, messages, options);
  }

  private async sendChatOpenAI(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    const openaiMessages = convertMessagesToOpenAI(messages);
    const sessionId = resolveGoSessionId(options);
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: options?.signal,
      headers: buildGoHeaders(this.apiKey, sessionId),
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

  private async sendChatAnthropic(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    const { system, convertedMessages } = convertMessagesToAnthropic(messages);
    const body: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      max_tokens: 64000,
    };
    if (system) {
      body.system = system;
    }

    const sessionId = resolveGoSessionId(options);
    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      signal: options?.signal,
      headers: buildAnthropicHeaders(this.apiKey, sessionId),
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

  private async sendChatResponses(model: string, messages: ChatMessage[], options?: SendChatOptions): Promise<string> {
    const { instructions, input } = convertMessagesToResponses(messages, model);
    const sessionId = resolveGoSessionId(options);
    const body: Record<string, unknown> = {
      model,
      input,
      stream: false,
      store: false,
    };
    if (instructions) body.instructions = instructions;

    const response = await fetch(`${BASE_URL}/responses`, {
      method: 'POST',
      signal: options?.signal,
      headers: buildGoHeaders(this.apiKey, sessionId),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await buildGoError(response);
    }

    const data = await response.json() as ResponsesMessageResponse;
    assertResponsesComplete(data);
    const text = (data.output ?? []).flatMap(getResponsesContent)
      .map(part => part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : '')
      .filter((part): part is string => typeof part === 'string')
      .join('');
    return text || data.output_text || 'No response from model';
  }

  private async completeAnthropicNonStreaming(
    requestBody: Record<string, unknown>,
    onChunk?: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<ChatMessage | undefined> {
    const retryBody = {
      ...requestBody,
      stream: false,
    };

    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      signal,
      headers: buildAnthropicHeaders(this.apiKey, sessionId ?? resolveGoSessionId()),
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

    if (isResponsesModel(model)) {
      return this.streamChatResponses(model, messages, abortController, onChunk, options);
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
    const startedAtMs = Date.now();
    let firstOutputAtMs: number | undefined;
    let usage: StreamTurnResult['usage'];

    const openaiMessages = convertMessagesToOpenAI(messages);
    const requestBody: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
    };
    addReasoning(requestBody, model, options?.reasoningEffort);

    if (options?.tools) {
      requestBody.tools = convertToolsToOpenAI(options.tools);
    }

    const sessionId = resolveGoSessionId(options);
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: buildGoHeaders(this.apiKey, sessionId),
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

    const markOutput = () => {
      if (firstOutputAtMs === undefined) firstOutputAtMs = Date.now();
    };

    const processSSELine = (line: string) => {
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const chunk = JSON.parse(data) as OpenAIStreamChunk;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;

        if (delta.reasoning_content) {
          accumulatedThinking += delta.reasoning_content;
          markOutput();
          onChunk({ type: 'thinking', content: delta.reasoning_content });
          return;
        }

        if (delta.thinking) {
          accumulatedThinking += delta.thinking;
          markOutput();
          onChunk({ type: 'thinking', content: delta.thinking });
          return;
        }

        if (delta.content) {
          accumulatedContent += delta.content;
          markOutput();
          onChunk({ type: 'content', content: delta.content });
        }

        if (delta.tool_calls?.length) {
          markOutput();
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
      usage: usage ?? {
        generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
      },
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
    const startedAtMs = Date.now();
    let firstOutputAtMs: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    const markOutput = () => {
      if (firstOutputAtMs === undefined) firstOutputAtMs = Date.now();
    };

    const { system, convertedMessages } = convertMessagesToAnthropic(messages);
    const requestBody: Record<string, unknown> = {
      model,
      messages: convertedMessages,
      max_tokens: 64000,
      stream: true,
    };

    addReasoning(requestBody, model, options?.reasoningEffort);

    if (system) {
      requestBody.system = system;
    }

    if (options?.tools) {
      requestBody.tools = convertToolsToAnthropic(options.tools);
    }

    const sessionId = resolveGoSessionId(options);
    const response = await fetch(`${BASE_URL}/messages`, {
      method: 'POST',
      headers: buildAnthropicHeaders(this.apiKey, sessionId),
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
            markOutput();
            onChunk({ type: 'thinking', content: delta.reasoning_content });
          }
          if (delta.thinking) {
            accumulatedThinking += delta.thinking;
            markOutput();
            onChunk({ type: 'thinking', content: delta.thinking });
          }
          if (delta.content) {
            accumulatedContent += delta.content;
            markOutput();
            onChunk({ type: 'content', content: delta.content });
          }
          return;
        }

        const currentEventType = getAnthropicEventType(parsed, eventType);
        if (currentEventType) {
          observedEventTypes.add(currentEventType);
        }

        if (currentEventType === 'message_start' && 'message' in parsed && parsed.message?.usage) {
          inputTokens = parsed.message.usage.input_tokens;
          outputTokens = parsed.message.usage.output_tokens;
        } else if (currentEventType === 'message_delta' && 'usage' in parsed && parsed.usage) {
          if (typeof parsed.usage.input_tokens === 'number') inputTokens = parsed.usage.input_tokens;
          if (typeof parsed.usage.output_tokens === 'number') outputTokens = parsed.usage.output_tokens;
        }

        if (currentEventType === 'content_block_delta') {
          const delta = 'delta' in parsed ? parsed.delta : undefined;
          if (!delta) return;
          if (delta.type) {
            observedDeltaTypes.add(delta.type);
          }

          if (delta.type === 'text_delta' && delta.text) {
            accumulatedContent += delta.text;
            markOutput();
            onChunk({ type: 'content', content: delta.text });
          } else if (delta.type === 'thinking_delta' && delta.thinking) {
            accumulatedThinking += delta.thinking;
            markOutput();
            onChunk({ type: 'thinking', content: delta.thinking });
          } else if (delta.type === 'input_json_delta' && delta.partial_json) {
            markOutput();
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
            markOutput();
            if (contentBlock.type === 'thinking') {
              accumulatedThinking += blockText;
              onChunk({ type: 'thinking', content: blockText });
            } else {
              accumulatedContent += blockText;
              onChunk({ type: 'content', content: blockText });
            }
          }

          if (contentBlock.type === 'tool_use' && contentBlock.id && contentBlock.name) {
            markOutput();
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

      const fallbackMessage = await this.completeAnthropicNonStreaming(requestBody, onChunk, abortController.signal, sessionId);
      if (fallbackMessage) {
        debugLog('[OpenCode Go] Anthropic non-stream fallback complete:', {
          model,
          contentLength: fallbackMessage.content.length,
          thinkingLength: fallbackMessage.thinking?.length || 0,
          toolCallCount: fallbackMessage.tool_calls?.length || 0,
        });
        return {
          assistantMessage: fallbackMessage,
          usage: {
            inputTokens,
            outputTokens,
            generationMs: Math.max(1, Date.now() - startedAtMs),
            estimated: inputTokens === undefined || outputTokens === undefined,
          },
        };
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
      usage: {
        inputTokens,
        outputTokens,
        generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
        estimated: inputTokens === undefined || outputTokens === undefined,
      },
    };
  }

  private async streamChatResponses(
    model: string,
    messages: ChatMessage[],
    abortController: AbortController,
    onChunk: (chunk: StreamChunk) => void,
    options?: StreamChatTurnOptions,
  ): Promise<StreamTurnResult> {
    let accumulatedContent = '';
    let accumulatedThinking = '';
    const toolCalls: import('./types').ToolCall[] = [];
    // Keyed by item_id/output_index so deltas can accumulate before the
    // final output_item.done arrives.
    const pendingFunctions = new Map<string, { callId: string; name: string; arguments: string }>();
    const outputIndexToKey = new Map<number, string>();
    const nativeOutput = new Map<number, Record<string, unknown>>();
    // Track text and refusals per content part, so final snapshots don't
    // duplicate deltas or suppress later parts of a multi-part response.
    const contentParts = new Map<string, string>();
    let completed = false;
    const startedAtMs = Date.now();
    let firstOutputAtMs: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const observedEventTypes = new Set<string>();

    const markOutput = () => {
      if (firstOutputAtMs === undefined) firstOutputAtMs = Date.now();
    };

    const ensureFunctionEntry = (key: string): { callId: string; name: string; arguments: string } => {
      let entry = pendingFunctions.get(key);
      if (!entry) {
        entry = { callId: key, name: '', arguments: '' };
        pendingFunctions.set(key, entry);
      }
      return entry;
    };

    const finalizeFunctionEntry = (key: string) => {
      const entry = pendingFunctions.get(key);
      if (!entry || !entry.name) return;
      if (toolCalls.some((tc) => tc.id === (entry.callId || entry.name))) return;
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(entry.arguments || '{}');
      } catch {
        throw new Error(`OpenCode Go returned invalid arguments for ${entry.name}.`);
      }
      toolCalls.push({
        type: 'function',
        id: entry.callId || entry.name,
        function: { name: entry.name, arguments: parsedArgs },
      });
    };

    const emitContentPart = (key: string, text: string, final: boolean) => {
      const previous = contentParts.get(key) || '';
      const delta = final ? (text.startsWith(previous) ? text.slice(previous.length) : '') : text;
      if (!delta) return;
      contentParts.set(key, previous + delta);
      accumulatedContent += delta;
      markOutput();
      onChunk({ type: 'content', content: delta });
    };

    const recordOutputItem = (item: Record<string, unknown>, outputIndex: number) => {
      if (item.type !== 'message' && item.type !== 'reasoning' && item.type !== 'function_call') return;
      nativeOutput.set(outputIndex, item);
      getResponsesContent(item).forEach((part, contentIndex) => {
        const text = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined;
        if (typeof text === 'string') {
          emitContentPart(`${outputIndex}:${contentIndex}:${part.type}`, text, true);
        }
      });
      if (item.type === 'function_call') {
        const key = typeof item.id === 'string' ? item.id
          : typeof item.call_id === 'string' ? item.call_id : `index-${outputIndex}`;
        outputIndexToKey.set(outputIndex, key);
        const entry = ensureFunctionEntry(key);
        if (typeof item.call_id === 'string') entry.callId = item.call_id;
        if (typeof item.name === 'string') entry.name = item.name;
        if (typeof item.arguments === 'string') entry.arguments = item.arguments;
      }
    };

    const { instructions, input } = convertMessagesToResponses(messages, model);
    const requestBody: Record<string, unknown> = {
      model,
      input,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    };
    addReasoning(requestBody, model, options?.reasoningEffort);
    if (instructions) requestBody.instructions = instructions;
    if (options?.tools) {
      requestBody.tools = convertToolsToResponses(options.tools);
    }

    const sessionId = resolveGoSessionId(options);
    const response = await fetch(`${BASE_URL}/responses`, {
      method: 'POST',
      headers: buildGoHeaders(this.apiKey, sessionId),
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
    let sseEvent = '';

    const processSSELine = (line: string) => {
      if (line.startsWith('event:')) {
        sseEvent = line.slice(6).trim();
        return;
      }
      const data = parseSSEDataLine(line);
      if (!data) return;
      if (data === '[DONE]') return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new Error('OpenCode Go returned a malformed Responses stream.');
      }

      const type = typeof parsed.type === 'string' && parsed.type ? parsed.type : sseEvent;
      if (type) observedEventTypes.add(type);

      const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
      const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

      if (type === 'error') {
        const message = asString((parsed as { message?: unknown }).message)
          ?? asString((parsed as { error?: { message?: unknown } }).error?.message)
          ?? 'Responses stream failed';
        throw new Error(`OpenCode Go request failed: ${message}`);
      }

      if (type === 'response.output_text.delta' || type === 'response.output_text.done'
        || type === 'response.refusal.delta' || type === 'response.refusal.done') {
        const final = type.endsWith('.done');
        const kind = type.startsWith('response.refusal.') ? 'refusal' : 'output_text';
        const text = final ? asString(kind === 'refusal' ? parsed.refusal : parsed.text) : asString(parsed.delta);
        if (text) {
          emitContentPart(`${asNumber(parsed.output_index) ?? 0}:${asNumber(parsed.content_index) ?? 0}:${kind}`, text, final);
        }
        return;
      }

      if (type.includes('reasoning') && type.endsWith('.delta')) {
        const delta = asString(parsed.delta) ?? asString(parsed.text);
        if (delta) {
          accumulatedThinking += delta;
          markOutput();
          onChunk({ type: 'thinking', content: delta });
        }
        return;
      }

      if (type === 'response.output_item.added') {
        const item = (parsed as { item?: Record<string, unknown>; output_index?: number }).item;
        const outputIndex = asNumber((parsed as { output_index?: unknown }).output_index);
        if (item && (item.type === 'function_call' || asString(item.type) === 'function_call')) {
          const itemId = asString(item.id) ?? asString(item.call_id) ?? (outputIndex !== undefined ? `index-${outputIndex}` : undefined);
          if (!itemId) return;
          if (outputIndex !== undefined) outputIndexToKey.set(outputIndex, itemId);
          const entry = ensureFunctionEntry(itemId);
          entry.callId = asString(item.call_id) ?? asString(item.id) ?? entry.callId;
          const name = asString(item.name);
          if (name) entry.name = name;
          const args = asString(item.arguments);
          if (args) entry.arguments = args;
        }
        return;
      }

      if (type === 'response.function_call_arguments.delta') {
        const delta = asString(parsed.delta) ?? '';
        const itemId = asString(parsed.item_id);
        const outputIndex = asNumber(parsed.output_index);
        const key = itemId ?? (outputIndex !== undefined ? outputIndexToKey.get(outputIndex) ?? `index-${outputIndex}` : undefined);
        if (!key) return;
        markOutput();
        ensureFunctionEntry(key).arguments += delta;
        return;
      }

      if (type === 'response.function_call_arguments.done') {
        const itemId = asString(parsed.item_id);
        const outputIndex = asNumber(parsed.output_index);
        const key = itemId ?? (outputIndex !== undefined ? outputIndexToKey.get(outputIndex) ?? `index-${outputIndex}` : undefined);
        if (!key) return;
        const entry = ensureFunctionEntry(key);
        const name = asString(parsed.name);
        if (name) entry.name = name;
        const args = asString(parsed.arguments);
        if (typeof args === 'string') entry.arguments = args;
        markOutput();
        return;
      }

      if (type === 'response.output_item.done') {
        const item = (parsed as { item?: Record<string, unknown> }).item;
        if (item) recordOutputItem(item, asNumber(parsed.output_index) ?? nativeOutput.size);
        return;
      }

      if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const resp = (parsed as { response?: ResponsesMessageResponse }).response;
        if (resp?.usage) {
          if (typeof resp.usage.input_tokens === 'number') inputTokens = resp.usage.input_tokens;
          if (typeof resp.usage.output_tokens === 'number') outputTokens = resp.usage.output_tokens;
        }
        const usage = (parsed as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
        if (usage) {
          if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
          if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
        }
        assertResponsesComplete({ ...resp, status: type.slice('response.'.length) });
        if (resp?.output) {
          // The terminal snapshot is authoritative and preserves native order.
          nativeOutput.clear();
          pendingFunctions.clear();
          resp.output.forEach(recordOutputItem);
        }
        completed = true;
      }
    };

    try {
      while (!completed) {
        if (abortController.signal.aborted) {
          await reader.cancel().catch(() => undefined);
          throw new DOMException('Aborted', 'AbortError');
        }
        const { done, value } = await reader.read();
        if (done) break;
        abortController.signal.throwIfAborted();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) processSSELine(line.trim());
          if (completed) break;
        }
      }
      if (!completed) {
        buffer += decoder.decode();
        if (buffer.trim()) processSSELine(buffer.trim());
      }
      abortController.signal.throwIfAborted();
      if (!completed) {
        throw new Error('OpenCode Go connection ended before the response completed. You can regenerate or ask to continue.');
      }
      // Do not expose executable tool calls until the response is complete.
      for (const key of pendingFunctions.keys()) finalizeFunctionEntry(key);
    } catch (e) {
      if (abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw e;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    debugLog('[OpenCode Go] Responses stream complete:', {
      model,
      contentLength: accumulatedContent.length,
      thinkingLength: accumulatedThinking.length,
      toolCallCount: toolCalls.length,
      observedEventTypes: Array.from(observedEventTypes),
    });

    return {
      assistantMessage:
        accumulatedContent || accumulatedThinking || toolCalls.length
          ? {
              role: 'assistant' as const,
              content: accumulatedContent,
              thinking: accumulatedThinking || undefined,
              tool_calls: toolCalls.length ? toolCalls : undefined,
              openCodeGoResponse: nativeOutput.size ? {
                model,
                output: [...nativeOutput].sort(([a], [b]) => a - b).map(([, item]) => item),
              } : undefined,
            }
          : undefined,
      usage: {
        inputTokens,
        outputTokens,
        generationMs: Math.max(1, Date.now() - (firstOutputAtMs ?? startedAtMs)),
        estimated: inputTokens === undefined || outputTokens === undefined,
      },
    };
  }
}
