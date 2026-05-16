import { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { startPythonService, stopPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC, cleanupVoiceFlow } from './voiceFlow';
import { setMainWindow } from './audioRecorder';
import { loadConversations, saveConversations, deleteConversation, loadFolders, saveFolders, loadSelectedModel, saveSelectedModel, loadSelectedProvider, saveSelectedProvider, loadOpenTabIds, saveOpenTabIds, loadCurrentConversationId, saveCurrentConversationId } from './store';
import { fetchUrlContent, type FetchToolArgs, type FetchToolResult } from './fetchService';
import {
  startBrowserService,
  stopBrowserService,
  runBrowserTask,
  type BrowserTaskResult,
} from './browserService';
import type { BrowserTraceEvent } from '../shared/browser';
import { initializeProviders, getProvider, getAvailableProviders, getAllModels, getModelsForProvider } from './providers/registry';
import type { ChatMessage, ToolDefinition, StreamChunk, ProviderInfo } from './providers/types';

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let currentAbortController: AbortController | null = null;
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

interface SendMessageStreamRequest {
  conversationId: string;
  assistantMessageId: string;
  model: string;
  provider: string;
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
      name: 'browser_task',
      description: 'Use a real visible browser window to complete an interactive website objective end-to-end: open pages, click, type, submit forms, play simple web games, dismiss dialogs, and inspect live page content. Provide one complete plain-English browser task for the full user objective, not a tiny first step. Do not send Playwright-style selector or method JSON.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'One complete browser task in plain English. Include all requested interaction steps and the desired stopping condition, for example "open Wordle, click Play, close the tutorial, make guesses until solved or out of attempts, and report the result".'
          }
        },
        required: ['task'],
        additionalProperties: false,
      }
    }
  }
];

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && error.name === 'AbortError'
  );
}

async function buildSystemPrompt(_conversationId: string): Promise<ChatMessage> {
  return {
    role: 'system',
    content: [
      'You are Jarvis, a desktop assistant. Your name is Jarvis.',
      'Use the fetch_url tool first for public webpages when you only need to read page content, summarize it, or extract information such as headlines, links, prices, or article text.',
      'Use the browser_task tool only when a real browser is necessary, such as clicking, typing, submitting forms, logging in, following the current page state, or handling content that is unavailable through a simple fetch.',
      'When using browser_task, give it the whole interactive objective in one call, including navigation, clicks, typing, waiting, handling dialogs, and the final success condition. Do not split one user request into multiple browser_task calls.',
      'When web access is unnecessary, answer normally without calling a tool.',
      'After using a tool, answer the user with the result instead of repeating raw tool output verbatim.',
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

function formatBrowserTaskResult(result: BrowserTaskResult): string {
  const lines = [
    result.success ? 'Browser task completed.' : 'Browser task failed.',
  ];

  if (result.result) {
    lines.push(`Result: ${result.result}`);
  }
  if (result.steps !== undefined) {
    lines.push(`Steps: ${result.steps}`);
  }
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    frame: true,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
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
    if (isQuitting) {
      return;
    }
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
  return await getAllModels();
});

ipcMain.handle('get-models-for-provider', async (_event, providerId: string) => {
  return await getModelsForProvider(providerId);
});

ipcMain.handle('get-providers', async () => {
  return getAvailableProviders();
});

ipcMain.handle('send-message-stream', async (event, request: SendMessageStreamRequest) => {
  let flushThinkingConsoleBuffer = (_reason: string) => undefined;

  const sendToRenderer = (channel: string, ...args: unknown[]) => {
    try {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, ...args);
      } else {
        currentAbortController?.abort();
      }
    } catch {
      currentAbortController?.abort();
    }
  };

  try {
    const abortController = new AbortController();
    currentAbortController = abortController;
    let inThinking = false;
    let streamedTextLength = 0;
    let thinkingConsoleBuffer = '';

    const sendChatChunk = (chunk: string) => {
      streamedTextLength += chunk.length;
      sendToRenderer('ollama-chunk', chunk);
    };

    const provider = getProvider(request.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${request.provider}`);
    }

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
          sendChatChunk('Thinking...\n');
          inThinking = true;
        }
        thinkingConsoleBuffer += chunk.content;
        sendChatChunk(chunk.content);
        return;
      }

      if (inThinking) {
        flushThinkingConsoleBuffer('before-content');
        sendChatChunk('\n...done thinking.\n');
        inThinking = false;
      }

      sendChatChunk(chunk.content);
    };

    const closeThinkingSection = (reason: string) => {
      if (!inThinking) {
        flushThinkingConsoleBuffer(reason);
        return;
      }

      flushThinkingConsoleBuffer(reason);
        sendChatChunk('\n...done thinking.\n');
        inThinking = false;
    };

    const baseMessages: ChatMessage[] = [
      await buildSystemPrompt(request.conversationId),
      ...request.messages,
    ];
    let browserTaskExecutedThisTurn = false;

    while (true) {
      const turnResult = await provider.streamChat(request.model, baseMessages, abortController, emitStreamChunk, { tools: CHAT_TOOLS });
      const assistantMessage = turnResult.assistantMessage;
      const toolCalls = assistantMessage?.tool_calls ?? [];
      if (!toolCalls.length) {
        closeThinkingSection('turn-complete');
        sendToRenderer('ollama-done');
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
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: `Fetch failed.\nError: ${errorMessage}`,
            });
            continue;
          }

          const fetchResult = await fetchUrlContent(args);
          const fetchContent = formatFetchToolResult(fetchResult);
          logMainProcess('LLM', 'Fetch tool result returned to LLM', {
            url: args.url,
            content: fetchContent,
          });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: fetchContent,
          });
          continue;
        }

        if (toolCall.function.name === 'browser_task') {
          if (browserTaskExecutedThisTurn) {
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: [
                'Browser task skipped.',
                'Error: A browser_task has already run during this user turn. Do not retry browser automation immediately.',
                'Use the previous browser task result to answer the user with the observed outcome, failure, or next manual step.',
              ].join('\n'),
            });
            continue;
          }

          browserTaskExecutedThisTurn = true;

          const args = parseToolArgumentsObject(toolCall.function.name, toolCall.function.arguments);
          const task = typeof args.task === 'string' ? args.task.trim() : '';

          if (!task) {
            toolResultMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id || toolCall.function.name,
              tool_name: toolCall.function.name,
              content: 'Browser task failed.\nError: Task description is required.',
            });
            continue;
          }

          logMainProcess('LLM', 'Browser task started', {
            task: task.slice(0, 200),
            model: request.model,
          });

          const browserResult = await runBrowserTask(
            task,
            request.model,
            request.provider,
            abortController.signal,
            undefined,
            (traceEvent: BrowserTraceEvent) => {
              sendToRenderer('browser-trace-event', {
                ...traceEvent,
                assistantMessageId: request.assistantMessageId,
              });
            },
          );
          const browserContent = formatBrowserTaskResult(browserResult);
          logMainProcess('LLM', 'Browser task result returned to LLM', {
            task: task.slice(0, 200),
            success: browserResult.success,
            steps: browserResult.steps,
            resultLength: browserResult.result?.length,
            error: browserResult.error?.slice(0, 300),
          });
          toolResultMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id || toolCall.function.name,
            tool_name: toolCall.function.name,
            content: browserContent,
          });
          continue;
        }

        toolResultMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id || toolCall.function.name,
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
        const synthesisResult = await provider.streamChat(
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
        sendToRenderer('ollama-done');
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
      sendToRenderer('ollama-done');
      return { success: true, aborted: true };
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during streaming';
    sendToRenderer('ollama-error', errorMessage);
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
  await deleteConversation(id);
  return { success: true };
});

ipcMain.handle('store:load-folders', async () => {
  return loadFolders();
});

ipcMain.handle('store:save-folders', async (_event, folders: unknown) => {
  saveFolders(folders as import('./store').SerializedFolder[]);
  return { success: true };
});

ipcMain.handle('store:delete-folder', async (_event, id: string) => {
  const folderConversations = loadConversations().filter(c => c.folderId === id);
  for (const c of folderConversations) {
    await deleteConversation(c.id);
  }
  return { success: true };
});

ipcMain.handle('store:load-model', async () => {
  return loadSelectedModel();
});

ipcMain.handle('store:save-model', async (_event, model: string) => {
  saveSelectedModel(model);
  return { success: true };
});

ipcMain.handle('store:load-provider', async () => {
  return loadSelectedProvider();
});

ipcMain.handle('store:save-provider', async (_event, provider: string) => {
  saveSelectedProvider(provider);
  return { success: true };
});

ipcMain.handle('store:load-open-tab-ids', async () => {
  return loadOpenTabIds();
});

ipcMain.handle('store:save-open-tab-ids', async (_event, tabIds: string[]) => {
  saveOpenTabIds(tabIds);
  return { success: true };
});

ipcMain.handle('store:load-current-conversation-id', async () => {
  return loadCurrentConversationId();
});

ipcMain.handle('store:save-current-conversation-id', async (_event, id: string | null) => {
  saveCurrentConversationId(id);
  return { success: true };
});

ipcMain.handle('generate-title', async (_event, message: string, model: string, providerId: string) => {
  try {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    const result = await provider.sendChat(model, [
      { role: 'system', content: 'Generate a very short title (3-6 words) for a conversation that starts with the following message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.' },
      { role: 'user', content: message },
    ]);
    return result.trim();
  } catch (error) {
    console.error('Failed to generate title:', error);
    const words = message.split(' ').slice(0, 5);
    return words.join(' ') + (words.length < message.split(' ').length ? '...' : '');
  }
});

ipcMain.on('set-theme-background', (_event, isDark: boolean) => {
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (win) {
    win.setBackgroundColor(isDark ? '#0a0a0a' : '#ffffff');
  }
});

app.whenReady().then(async () => {
  initializeProviders();

  if (process.platform === 'darwin' && !isDev) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([]));
  }

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

  console.log('[Main] Starting browser automation service...');

  try {
    const browserStarted = await startBrowserService();
    if (!browserStarted) {
      console.error('[Main] Failed to start browser service - browser automation will not work');
    } else {
      console.log('[Main] Browser automation service started successfully');
    }
  } catch (error) {
    console.error('[Main] Error starting browser service:', error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', async () => {
  await cleanupVoiceFlow();
  await stopBrowserService();
  await stopPythonService();
});

app.dock?.hide();
