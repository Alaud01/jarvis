import { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { startPythonService, stopPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC, cleanupVoiceFlow } from './voiceFlow';
import { setMainWindow } from './audioRecorder';
import { loadConversations, saveConversations, deleteConversation, loadSelectedModel, saveSelectedModel } from './store';
import { fetchUrlContent, type FetchToolArgs, type FetchToolResult } from './fetchService';
import {
  closeAllBrowserSessions,
  closeBrowserSession,
  deleteBrowserArtifacts,
  executeBrowserAgent,
  getBrowserSessionSummary,
  readBrowserArtifactAsPreviewDataUrl,
  type BrowserAgentProgressUpdate,
  type BrowserAgentResult,
  type BrowserAgentToolArgs,
} from './stagehandService';
import type { BrowserLLMTrace, BrowserScreenshotArtifact, BrowserToolRun } from '../shared/browser';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAbortController: AbortController | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

const OLLAMA_BASE_URL = 'http://localhost:11434';
const MAX_BROWSER_AGENT_STEPS = 40;

interface OllamaModel {
  name: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

interface OllamaChatResponse {
  message: {
    content: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
}

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface OllamaToolCall {
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface ChatMessage {
  role: ChatRole;
  content: string;
  images?: string[];
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaStreamResponse {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

interface ToolDefinition {
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

interface StreamChunk {
  type: 'thinking' | 'content';
  content: string;
}

interface StreamTurnResult {
  assistantMessage?: ChatMessage;
}

interface StreamChatTurnOptions {
  tools?: ToolDefinition[] | null;
}

interface BrowserToolEventPayload {
  conversationId: string;
  assistantMessageId: string;
  runId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  instruction: string;
  startUrl?: string;
  summary?: string;
  currentUrl?: string;
  pageTitle?: string;
  actionsTaken?: number;
  error?: string;
  processing?: string;
  model?: BrowserAgentResult['model'];
  mode?: BrowserToolRun['mode'];
  screenshots?: BrowserScreenshotArtifact[];
  llmTrace?: BrowserLLMTrace;
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
}

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  messages: ChatMessage[];
}

const CHAT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Fetch a public http or https URL and return a readable text version of the response. Prefer this over browser_agent when you only need to read, summarize, or extract information from a page without clicking, typing, logging in, or preserving browser state.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.'
          },
          maxChars: {
            type: 'number',
            description: 'Optional maximum number of response characters to return.'
          },
          rawHtml: {
            type: 'boolean',
            description: 'Optional flag to return raw HTML instead of a cleaned readable version for HTML pages.'
          }
        },
        required: ['url'],
        additionalProperties: false,
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_agent',
      description: 'Use a real visible browser window to open websites, click, type, submit forms, and inspect live page content. Provide one plain-English browser task only. Do not send Playwright-style selector or method JSON. This tool reuses the same browser session for the current conversation when available.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'One concise browser goal in plain English, for example "open the pricing page and click Start free trial". Do not include selectors, element IDs, or method/selector JSON.'
          },
          startUrl: {
            type: 'string',
            description: 'Optional absolute http or https URL to open before carrying out the task. Omit this when continuing from the current page.'
          },
          maxSteps: {
            type: 'number',
            description: `Optional integer limit for how many browser actions the task may take. Use a value between 1 and ${MAX_BROWSER_AGENT_STEPS}.`,
            minimum: 1,
            maximum: MAX_BROWSER_AGENT_STEPS,
          }
        },
        required: ['instruction'],
        additionalProperties: false,
      }
    }
  }
];

async function fetchOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }
    const data = (await response.json()) as OllamaTagsResponse;
    return data.models?.map((m) => m.name) || [];
  } catch (error) {
    console.error('Error fetching Ollama models:', error);
    return [];
  }
}

async function sendToOllama(model: string, messages: ChatMessage[]): Promise<string> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw await buildOllamaRequestError(response);
    }

    const data = (await response.json()) as OllamaChatResponse;
    return data.message?.content || 'No response from model';
  } catch (error) {
    console.error('Error sending to Ollama:', error);
    throw error;
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

function parseOllamaErrorBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // Fall back to the raw response body when Ollama does not return JSON.
  }

  return trimmed;
}

async function buildOllamaRequestError(response: Response): Promise<Error> {
  const fallbackMessage = response.statusText.trim() || `HTTP ${response.status}`;

  try {
    const responseBody = await response.text();
    const details = parseOllamaErrorBody(responseBody);
    if (details) {
      return new Error(`Ollama request failed (${response.status}): ${details}`);
    }
  } catch {
    // Ignore body parsing failures and surface the HTTP status instead.
  }

  return new Error(`Ollama request failed (${response.status}): ${fallbackMessage}`);
}

async function buildSystemPrompt(conversationId: string): Promise<ChatMessage> {
  const browserSummary = await getBrowserSessionSummary(conversationId);
  const browserContext = browserSummary.hasActiveSession
    ? `There is already a visible browser session for this conversation${browserSummary.currentUrl ? ` at ${browserSummary.currentUrl}` : ''}${browserSummary.pageTitle ? ` with page title "${browserSummary.pageTitle}"` : ''}. Reuse it when the user refers to the current page or asks for follow-up browser actions.`
    : 'There is no active browser session yet for this conversation.';

  return {
    role: 'system',
    content: [
      'You are Jarvis, a desktop assistant. Your name is Jarvis.',
      'Use the fetch_url tool first for public webpages when you only need to read page content, summarize it, or extract information such as headlines, links, prices, or article text.',
      'Use the browser_agent tool only when a real browser is necessary, such as clicking, typing, submitting forms, logging in, following the current page state, or handling content that is unavailable through a simple fetch.',
      'When web access is unnecessary, answer normally without calling a tool.',
      'The browser tool opens or reuses a visible local browser window and preserves browser state for the current conversation.',
      browserContext,
      'After using the tool, answer the user with the result instead of repeating raw tool output verbatim.'
    ].join(' ')
  };
}

function parseToolArgumentsObject(
  toolName: string,
  rawArguments: Record<string, unknown> | string
): Record<string, unknown> {
  const parsed = typeof rawArguments === 'string'
    ? (() => {
      try {
        return JSON.parse(rawArguments);
      } catch {
        throw new Error(`${toolName} arguments must be valid JSON.`);
      }
    })()
    : rawArguments;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${toolName} arguments must be a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function parseBrowserAgentStartUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error('browser_agent "startUrl" must be a string when provided.');
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error('browser_agent "startUrl" must be an absolute http or https URL.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('browser_agent "startUrl" must use the http or https protocol.');
  }

  return parsedUrl.toString();
}

function parseBrowserAgentMaxSteps(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : NaN;

  if (!Number.isFinite(numericValue)) {
    throw new Error(`browser_agent "maxSteps" must be a finite number between 1 and ${MAX_BROWSER_AGENT_STEPS}.`);
  }

  const normalized = Math.floor(numericValue);
  if (normalized < 1 || normalized > MAX_BROWSER_AGENT_STEPS) {
    throw new Error(`browser_agent "maxSteps" must be between 1 and ${MAX_BROWSER_AGENT_STEPS}.`);
  }

  return normalized;
}

function parseBrowserAgentArgs(rawArguments: Record<string, unknown> | string): BrowserAgentToolArgs {
  const args = parseToolArgumentsObject('browser_agent', rawArguments);
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';

  if (!instruction) {
    throw new Error('browser_agent requires a non-empty "instruction" string.');
  }

  return {
    instruction,
    startUrl: parseBrowserAgentStartUrl(args.startUrl),
    maxSteps: parseBrowserAgentMaxSteps(args.maxSteps),
  };
}

function parseFetchToolArgs(rawArguments: Record<string, unknown> | string): FetchToolArgs {
  const args = parseToolArgumentsObject('fetch_url', rawArguments);
  const url = typeof args.url === 'string' ? args.url.trim() : '';

  if (!url) {
    throw new Error('fetch_url requires a non-empty "url" string.');
  }

  return {
    url,
    maxChars: typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? args.maxChars : undefined,
    rawHtml: typeof args.rawHtml === 'boolean' ? args.rawHtml : undefined,
  };
}

// Ollama's Gemini adapter currently rejects round-tripped tool calls because
// the follow-up request is missing provider-specific function call metadata.
function requiresToolResultSynthesis(model: string): boolean {
  return /\bgemini\b/i.test(model);
}

function logMainProcess(
  prefix: 'LLM' | 'BrowserAgent',
  message: string,
  details?: Record<string, unknown>
): void {
  const label = `[${prefix}] ${message}`;
  if (details) {
    console.log(label, details);
    return;
  }

  console.log(label);
}

function formatBrowserToolResult(result: BrowserAgentResult): string {
  const lines = [
    result.success ? 'Browser agent completed.' : 'Browser agent failed.',
    `Instruction: ${result.instruction}`,
  ];

  if (result.startUrl) {
    lines.push(`Start URL: ${result.startUrl}`);
  }
  if (result.currentUrl) {
    lines.push(`Current URL: ${result.currentUrl}`);
  }
  if (result.pageTitle) {
    lines.push(`Page title: ${result.pageTitle}`);
  }

  lines.push(`Actions taken: ${result.actionsTaken}`);
  lines.push(`Summary: ${result.summary}`);

  if (result.screenshots?.length) {
    lines.push(`Screenshot artifacts: ${result.screenshots.map((artifact) => artifact.label).join(', ')}`);
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  return lines.join('\n');
}

async function buildBrowserToolMessage(result: BrowserAgentResult): Promise<ChatMessage> {
  return {
    role: 'tool',
    tool_name: 'browser_agent',
    content: formatBrowserToolResult(result),
  };
}

function formatFetchToolResult(result: FetchToolResult): string {
  const lines = [
    result.success ? 'Fetch completed.' : 'Fetch failed.',
    `Requested URL: ${result.requestedUrl}`,
  ];

  if (result.finalUrl) {
    lines.push(`Final URL: ${result.finalUrl}`);
  }
  if (typeof result.status === 'number') {
    lines.push(`Status: ${result.status}${result.statusText ? ` ${result.statusText}` : ''}`);
  }
  if (result.contentType) {
    lines.push(`Content type: ${result.contentType}`);
  }
  if (result.title) {
    lines.push(`Title: ${result.title}`);
  }
  if (result.truncated) {
    lines.push('Truncated: yes');
  }
  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }
  if (result.content) {
    lines.push(`Content:\n${result.content}`);
  }

  return lines.join('\n');
}

function formatToolResultForSynthesis(toolMessage: ChatMessage, index: number): string {
  return [
    `Tool result ${index + 1} (${toolMessage.tool_name ?? 'tool'}):`,
    toolMessage.content,
  ].join('\n');
}

function buildToolResultSynthesisMessages(
  baseMessages: ChatMessage[],
  assistantMessage: ChatMessage | undefined,
  toolMessages: ChatMessage[]
): ChatMessage[] {
  const synthesisMessages = [...baseMessages];
  const assistantContent = assistantMessage?.content.trim();

  if (assistantContent) {
    synthesisMessages.push({
      role: 'assistant',
      content: assistantContent,
    });
  }

  synthesisMessages.push({
    role: 'system',
    content: [
      'A tool has already been executed for the latest user request.',
      'Use the tool results provided next to answer the user directly.',
      'Do not call more tools and do not mention internal tool mechanics unless the user explicitly asks.',
    ].join(' '),
  });
  synthesisMessages.push({
    role: 'user',
    content: [
      'Use these tool results to answer my previous request directly:',
      ...toolMessages.map((toolMessage, index) => formatToolResultForSynthesis(toolMessage, index)),
    ].join('\n\n'),
  });

  return synthesisMessages;
}

async function streamChatTurn(
  model: string,
  messages: ChatMessage[],
  abortController: AbortController,
  onChunk: (chunk: StreamChunk) => void,
  options?: StreamChatTurnOptions,
): Promise<StreamTurnResult> {
  let accumulatedContent = '';
  let accumulatedThinking = '';
  const toolCalls: OllamaToolCall[] = [];
  try {
    const requestTools = options?.tools === undefined ? CHAT_TOOLS : options.tools;
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      think: true,
      options: {
        num_predict: 64000,
      },
    };

    if (requestTools) {
      requestBody.tools = requestTools;
    }

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw await buildOllamaRequestError(response);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
              console.log('[LLM] Stream terminated:', {
                reason: data.done_reason || 'unknown',
                prompt_tokens: data.prompt_eval_count,
                response_tokens: data.eval_count,
                total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
                content_length: accumulatedContent.length,
                thinking_length: accumulatedThinking.length,
                tool_call_count: toolCalls.length,
              });
              return {
                assistantMessage: accumulatedContent || accumulatedThinking || toolCalls.length
                  ? {
                      role: 'assistant',
                      content: accumulatedContent,
                      thinking: accumulatedThinking || undefined,
                      tool_calls: toolCalls.length ? toolCalls : undefined,
                    }
                  : undefined,
              };
            }
          } catch (e) {
            console.error('Error parsing stream line:', e);
          }
        }
      }
    }

    if (buffer.trim()) {
      try {
        const data = JSON.parse(buffer) as OllamaStreamResponse;
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
          console.log('[LLM] Stream terminated:', {
            reason: data.done_reason || 'unknown',
            prompt_tokens: data.prompt_eval_count,
            response_tokens: data.eval_count,
            total_duration_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : undefined,
            content_length: accumulatedContent.length,
            thinking_length: accumulatedThinking.length,
            tool_call_count: toolCalls.length,
          });
          return {
            assistantMessage: accumulatedContent || accumulatedThinking || toolCalls.length
              ? {
                  role: 'assistant',
                  content: accumulatedContent,
                  thinking: accumulatedThinking || undefined,
                  tool_calls: toolCalls.length ? toolCalls : undefined,
                }
              : undefined,
          };
        }
      } catch (e) {
        console.error('Error parsing final stream line:', e);
      }
    }

    return {
      assistantMessage: accumulatedContent || accumulatedThinking || toolCalls.length
        ? {
            role: 'assistant',
            content: accumulatedContent,
            thinking: accumulatedThinking || undefined,
            tool_calls: toolCalls.length ? toolCalls : undefined,
          }
        : undefined,
    };
  } catch (error) {
    console.error('Error streaming from Ollama:', error);
    throw error;
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    frame: true,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  
  setMainWindow(mainWindow);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../../assets/icon.png')
  );
  
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  
  tray.setToolTip('Jarvis');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow?.show();
    }
  });
}

ipcMain.handle('get-models', async () => {
  return await fetchOllamaModels();
});

ipcMain.handle('send-message', async (_event, model: string, messages: { role: string; content: string }[]) => {
  return await sendToOllama(model, messages as ChatMessage[]);
});

ipcMain.handle('send-message-stream', async (event, request: SendMessageStreamRequest) => {
  let flushThinkingConsoleBuffer = (_reason: string) => undefined;

  try {
    const abortController = new AbortController();
    currentAbortController = abortController;
    let inThinking = false;
    let streamedTextLength = 0;
    let thinkingConsoleBuffer = '';

    const sendOllamaChunk = (chunk: string) => {
      streamedTextLength += chunk.length;
      event.sender.send('ollama-chunk', chunk);
    };

    flushThinkingConsoleBuffer = (reason: string) => {
      const normalizedThinking = thinkingConsoleBuffer.trim();
      if (!normalizedThinking) {
        thinkingConsoleBuffer = '';
        return;
      }

      logMainProcess(
        'LLM',
        `Thinking block (${reason})\n${normalizedThinking}`,
        {
          conversationId: request.conversationId,
          model: request.model,
          characters: normalizedThinking.length,
        }
      );
      thinkingConsoleBuffer = '';
    };

    const emitStreamChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'thinking') {
        if (!inThinking) {
          sendOllamaChunk('Thinking...\n');
          inThinking = true;
        }
        thinkingConsoleBuffer += chunk.content;
        sendOllamaChunk(chunk.content);
        return;
      }

      if (inThinking) {
        flushThinkingConsoleBuffer('before-content');
        sendOllamaChunk('\n...done thinking.\n');
        inThinking = false;
      }

      sendOllamaChunk(chunk.content);
    };

    const closeThinkingSection = (reason: string) => {
      if (!inThinking) {
        flushThinkingConsoleBuffer(reason);
        return;
      }

      flushThinkingConsoleBuffer(reason);
      sendOllamaChunk('\n...done thinking.\n');
      inThinking = false;
    };

    const baseMessages: ChatMessage[] = [
      await buildSystemPrompt(request.conversationId),
      ...request.messages,
    ];

    while (true) {
      const turnResult = await streamChatTurn(request.model, baseMessages, abortController, emitStreamChunk);
      const assistantMessage = turnResult.assistantMessage;
      const toolCalls = assistantMessage?.tool_calls ?? [];
      if (!toolCalls.length) {
        closeThinkingSection('turn-complete');
        event.sender.send('ollama-done');
        return { success: true };
      }

      closeThinkingSection('before-tool-call');
      const toolResultMessages: ChatMessage[] = [];

      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'fetch_url') {
          let args: FetchToolArgs;
          try {
            args = parseFetchToolArgs(toolCall.function.arguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid fetch_url arguments.';
            toolResultMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Fetch failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          const fetchResult = await fetchUrlContent(args);
          toolResultMessages.push({
            role: 'tool',
            tool_name: toolCall.function.name,
            content: formatFetchToolResult(fetchResult),
          });
          continue;
        }

        if (toolCall.function.name === 'browser_agent') {
          let args: BrowserAgentToolArgs;
          try {
            args = parseBrowserAgentArgs(toolCall.function.arguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid browser_agent arguments.';
            const failedAt = new Date().toISOString();
            logMainProcess('BrowserAgent', 'Rejected browser_agent arguments', {
              conversationId: request.conversationId,
              assistantMessageId: request.assistantMessageId,
              model: request.model,
              rawArguments: toolCall.function.arguments,
              error: errorMessage,
            });
            event.sender.send('browser-tool-event', {
              conversationId: request.conversationId,
              assistantMessageId: request.assistantMessageId,
              runId: randomUUID(),
              status: 'failed',
              instruction: 'Invalid browser request',
              summary: 'Browser task failed.',
              error: errorMessage,
              startedAt: failedAt,
              finishedAt: failedAt,
              textOffset: streamedTextLength,
            } satisfies BrowserToolEventPayload);
            toolResultMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Browser agent failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          const runId = randomUUID();
          const startedAt = new Date().toISOString();
          const textOffset = streamedTextLength;
          logMainProcess('BrowserAgent', 'Dispatching browser_agent', {
            conversationId: request.conversationId,
            assistantMessageId: request.assistantMessageId,
            runId,
            model: request.model,
            instruction: args.instruction,
            startUrl: args.startUrl,
            maxSteps: args.maxSteps,
          });
          event.sender.send('browser-tool-event', {
            conversationId: request.conversationId,
            assistantMessageId: request.assistantMessageId,
            runId,
            status: 'running',
            instruction: args.instruction,
            startUrl: args.startUrl,
            processing: 'Preparing browser task...',
            startedAt,
            textOffset,
          } satisfies BrowserToolEventPayload);

          try {
            const browserResult = await executeBrowserAgent(
              request.conversationId,
              args,
              abortController.signal,
              request.model,
              (update: BrowserAgentProgressUpdate) => {
                event.sender.send('browser-tool-event', {
                  conversationId: request.conversationId,
                  assistantMessageId: request.assistantMessageId,
                  runId,
                  status: 'running',
                  instruction: args.instruction,
                  startUrl: args.startUrl,
                  currentUrl: update.currentUrl,
                  pageTitle: update.pageTitle,
                  actionsTaken: update.actionsTaken,
                  processing: update.processing,
                  model: update.model,
                  mode: update.mode,
                  screenshots: update.screenshots,
                  startedAt,
                  textOffset,
                } satisfies BrowserToolEventPayload);
              }
            );
            event.sender.send('browser-tool-event', {
              conversationId: request.conversationId,
              assistantMessageId: request.assistantMessageId,
              runId,
              status: browserResult.success ? 'completed' : 'failed',
              instruction: browserResult.instruction,
              startUrl: browserResult.startUrl,
              summary: browserResult.summary,
              currentUrl: browserResult.currentUrl,
              pageTitle: browserResult.pageTitle,
              actionsTaken: browserResult.actionsTaken,
              error: browserResult.error,
              processing: browserResult.processing,
              model: browserResult.model,
              mode: browserResult.mode,
              screenshots: browserResult.screenshots,
              llmTrace: browserResult.llmTrace,
              startedAt: browserResult.startedAt,
              finishedAt: browserResult.finishedAt,
              textOffset,
            } satisfies BrowserToolEventPayload);

            toolResultMessages.push(await buildBrowserToolMessage(browserResult));
          } catch (error) {
            if (isAbortLikeError(error)) {
              const finishedAt = new Date().toISOString();
              logMainProcess('BrowserAgent', 'Browser agent cancelled', {
                conversationId: request.conversationId,
                assistantMessageId: request.assistantMessageId,
                runId,
                instruction: args.instruction,
              });
              event.sender.send('browser-tool-event', {
                conversationId: request.conversationId,
                assistantMessageId: request.assistantMessageId,
                runId,
                status: 'cancelled',
                instruction: args.instruction,
                startUrl: args.startUrl,
                summary: 'Browser task cancelled.',
                error: 'Browser task cancelled.',
                startedAt,
                finishedAt,
                textOffset,
              } satisfies BrowserToolEventPayload);
              throw error;
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown browser tool error.';
            const finishedAt = new Date().toISOString();
            logMainProcess('BrowserAgent', 'Browser agent dispatch failed', {
              conversationId: request.conversationId,
              assistantMessageId: request.assistantMessageId,
              runId,
              instruction: args.instruction,
              startUrl: args.startUrl,
              error: errorMessage,
            });
            event.sender.send('browser-tool-event', {
              conversationId: request.conversationId,
              assistantMessageId: request.assistantMessageId,
              runId,
              status: 'failed',
              instruction: args.instruction,
              startUrl: args.startUrl,
              summary: 'Browser task failed.',
              error: errorMessage,
              startedAt,
              finishedAt,
              textOffset,
            } satisfies BrowserToolEventPayload);
            toolResultMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Browser agent failed.\nError: ${errorMessage}`,
            });
          }
          continue;
        }

        toolResultMessages.push({
          role: 'tool',
          tool_name: toolCall.function.name,
          content: `Unknown tool: ${toolCall.function.name}`,
        });
      }

      if (requiresToolResultSynthesis(request.model)) {
        logMainProcess('LLM', 'Using tool-result synthesis fallback', {
          conversationId: request.conversationId,
          model: request.model,
          toolCallCount: toolCalls.length,
        });
        const synthesisResult = await streamChatTurn(
          request.model,
          buildToolResultSynthesisMessages(baseMessages, assistantMessage, toolResultMessages),
          abortController,
          emitStreamChunk,
          { tools: null },
        );

        if (synthesisResult.assistantMessage?.tool_calls?.length) {
          logMainProcess('LLM', 'Ignoring unexpected tool calls during synthesis fallback', {
            conversationId: request.conversationId,
            model: request.model,
            toolCallCount: synthesisResult.assistantMessage.tool_calls.length,
          });
        }

        closeThinkingSection('tool-synthesis-complete');
        event.sender.send('ollama-done');
        return { success: true };
      }

      if (assistantMessage) {
        baseMessages.push(assistantMessage);
      }
      baseMessages.push(...toolResultMessages);
    }
  } catch (error) {
    flushThinkingConsoleBuffer('stream-error');
    if (isAbortLikeError(error)) {
      event.sender.send('ollama-done');
      return { success: true, aborted: true };
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during streaming';
    event.sender.send('ollama-error', errorMessage);
    throw error;
  } finally {
    currentAbortController = null;
  }
});

ipcMain.handle('stop-stream', async () => {
  if (currentAbortController) {
    currentAbortController.abort();
  }
  return { success: true };
});

registerVoiceFlowIPC();

ipcMain.handle('store:load-conversations', async () => {
  return loadConversations();
});

ipcMain.handle('store:save-conversations', async (_event, conversations: unknown) => {
  saveConversations(conversations as import('./store').SerializedConversation[]);
  return { success: true };
});

ipcMain.handle('store:delete-conversation', async (_event, id: string) => {
  await closeBrowserSession(id);
  await deleteBrowserArtifacts(id);
  deleteConversation(id);
  return { success: true };
});

ipcMain.handle('browser-artifact:data-url', async (_event, filePath: string) => {
  return readBrowserArtifactAsPreviewDataUrl(filePath);
});

ipcMain.handle('store:load-model', async () => {
  return loadSelectedModel();
});

ipcMain.handle('store:save-model', async (_event, model: string) => {
  saveSelectedModel(model);
  return { success: true };
});

app.whenReady().then(async () => {
  createTray();
  createWindow();
  
  console.log('[Main] Starting Python voice service...');
  
  try {
    const pythonStarted = await startPythonService();
    if (!pythonStarted) {
      console.error('[Main] Failed to start Python voice service - voice features will not work');
    } else {
      console.log('[Main] Python voice service started successfully');
    }
  } catch (error) {
    console.error('[Main] Error starting Python service:', error);
  }
  
  try {
    await initializeVoiceFlow();
    console.log('[Main] Voice flow initialized');
  } catch (error) {
    console.error('[Main] Error initializing voice flow:', error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await cleanupVoiceFlow();
  await closeAllBrowserSessions();
  await stopPythonService();
});

app.dock?.hide();