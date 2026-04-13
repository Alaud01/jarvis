import { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { startPythonService, stopPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC, cleanupVoiceFlow } from './voiceFlow';
import { setMainWindow } from './audioRecorder';
import { loadConversations, saveConversations, deleteConversation, loadSelectedModel, saveSelectedModel } from './store';
import { fetchUrlContent, type FetchToolArgs, type FetchToolResult } from './fetchService';
import { closeAllBrowserSessions, closeBrowserSession, executeBrowserAgent, getBrowserSessionSummary, type BrowserAgentProgressUpdate, type BrowserAgentResult, type BrowserAgentToolArgs } from './stagehandService';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAbortController: AbortController | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

const OLLAMA_BASE_URL = 'http://localhost:11434';

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
  mode?: BrowserAgentResult['mode'];
  startedAt: string;
  finishedAt?: string;
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
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_agent',
      description: 'Use a real visible browser window to open websites, click, type, submit forms, and inspect live page content. This tool reuses the same browser session for the current conversation when available.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'The browser task to perform.'
          },
          startUrl: {
            type: 'string',
            description: 'Optional URL to open before carrying out the task.'
          },
          maxSteps: {
            type: 'number',
            description: 'Optional limit for how many browser actions the task may take.'
          }
        },
        required: ['instruction']
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
      throw new Error(`Ollama request failed: ${response.statusText}`);
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

async function buildSystemPrompt(conversationId: string): Promise<ChatMessage> {
  const browserSummary = await getBrowserSessionSummary(conversationId);
  const browserContext = browserSummary.hasActiveSession
    ? `There is already a visible browser session for this conversation${browserSummary.currentUrl ? ` at ${browserSummary.currentUrl}` : ''}${browserSummary.pageTitle ? ` with page title "${browserSummary.pageTitle}"` : ''}. Reuse it when the user refers to the current page or asks for follow-up browser actions.`
    : 'There is no active browser session yet for this conversation.';

  return {
    role: 'system',
    content: [
      'You are Rhandy, a desktop assistant.',
      'Use the fetch_url tool first for public webpages when you only need to read page content, summarize it, or extract information such as headlines, links, prices, or article text.',
      'Use the browser_agent tool only when a real browser is necessary, such as clicking, typing, submitting forms, logging in, following the current page state, or handling content that is unavailable through a simple fetch.',
      'When web access is unnecessary, answer normally without calling a tool.',
      'The browser tool opens or reuses a visible local browser window and preserves browser state for the current conversation.',
      browserContext,
      'After using the tool, answer the user with the result instead of repeating raw tool output verbatim.'
    ].join(' ')
  };
}

function parseBrowserAgentArgs(rawArguments: Record<string, unknown> | string): BrowserAgentToolArgs {
  const parsed = typeof rawArguments === 'string'
    ? JSON.parse(rawArguments)
    : rawArguments;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('browser_agent arguments must be a JSON object.');
  }

  const args = parsed as Record<string, unknown>;
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';

  if (!instruction) {
    throw new Error('browser_agent requires a non-empty "instruction" string.');
  }

  return {
    instruction,
    startUrl: typeof args.startUrl === 'string' && args.startUrl.trim() ? args.startUrl.trim() : undefined,
    maxSteps: typeof args.maxSteps === 'number' && Number.isFinite(args.maxSteps) ? args.maxSteps : undefined,
  };
}

function parseFetchToolArgs(rawArguments: Record<string, unknown> | string): FetchToolArgs {
  const parsed = typeof rawArguments === 'string'
    ? JSON.parse(rawArguments)
    : rawArguments;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('fetch_url arguments must be a JSON object.');
  }

  const args = parsed as Record<string, unknown>;
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

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  return lines.join('\n');
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

async function streamChatTurn(
  model: string,
  messages: ChatMessage[],
  abortController: AbortController,
  onChunk: (chunk: StreamChunk) => void
): Promise<StreamTurnResult> {
  let accumulatedContent = '';
  let accumulatedThinking = '';
  const toolCalls: OllamaToolCall[] = [];
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: CHAT_TOOLS,
        stream: true,
        think: true,
        options: {
          num_predict: 64000,
        },
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.statusText}`);
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
    width: 450,
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
    mainWindow.webContents.openDevTools();
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
  
  tray.setToolTip('Rhandy');
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
  try {
    const abortController = new AbortController();
    currentAbortController = abortController;
    let inThinking = false;

    const emitStreamChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'thinking') {
        if (!inThinking) {
          event.sender.send('ollama-chunk', 'Thinking...\n');
          inThinking = true;
        }
        event.sender.send('ollama-chunk', chunk.content);
        return;
      }

      if (inThinking) {
        event.sender.send('ollama-chunk', '\n...done thinking.\n');
        inThinking = false;
      }

      event.sender.send('ollama-chunk', chunk.content);
    };

    const closeThinkingSection = () => {
      if (!inThinking) {
        return;
      }

      event.sender.send('ollama-chunk', '\n...done thinking.\n');
      inThinking = false;
    };

    const baseMessages: ChatMessage[] = [
      await buildSystemPrompt(request.conversationId),
      ...request.messages,
    ];

    while (true) {
      const turnResult = await streamChatTurn(request.model, baseMessages, abortController, emitStreamChunk);
      const assistantMessage = turnResult.assistantMessage;

      if (assistantMessage) {
        baseMessages.push(assistantMessage);
      }

      const toolCalls = assistantMessage?.tool_calls ?? [];
      if (!toolCalls.length) {
        closeThinkingSection();
        event.sender.send('ollama-done');
        return { success: true };
      }

      closeThinkingSection();

      for (const toolCall of toolCalls) {
        if (toolCall.function.name === 'fetch_url') {
          let args: FetchToolArgs;
          try {
            args = parseFetchToolArgs(toolCall.function.arguments);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Invalid fetch_url arguments.';
            baseMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Fetch failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          const fetchResult = await fetchUrlContent(args);
          baseMessages.push({
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
            } satisfies BrowserToolEventPayload);
            baseMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Browser agent failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          const runId = randomUUID();
          const startedAt = new Date().toISOString();
          event.sender.send('browser-tool-event', {
            conversationId: request.conversationId,
            assistantMessageId: request.assistantMessageId,
            runId,
            status: 'running',
            instruction: args.instruction,
            startUrl: args.startUrl,
            processing: 'Preparing browser task...',
            startedAt,
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
                  startedAt,
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
              startedAt: browserResult.startedAt,
              finishedAt: browserResult.finishedAt,
            } satisfies BrowserToolEventPayload);

            baseMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: formatBrowserToolResult(browserResult),
            });
          } catch (error) {
            if (isAbortLikeError(error)) {
              const finishedAt = new Date().toISOString();
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
              } satisfies BrowserToolEventPayload);
              throw error;
            }

            const errorMessage = error instanceof Error ? error.message : 'Unknown browser tool error.';
            const finishedAt = new Date().toISOString();
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
            } satisfies BrowserToolEventPayload);
            baseMessages.push({
              role: 'tool',
              tool_name: toolCall.function.name,
              content: `Browser agent failed.\nError: ${errorMessage}`,
            });
          }
          continue;
        }

        baseMessages.push({
          role: 'tool',
          tool_name: toolCall.function.name,
          content: `Unknown tool: ${toolCall.function.name}`,
        });
      }
    }
  } catch (error) {
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
  deleteConversation(id);
  return { success: true };
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