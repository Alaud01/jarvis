import { app, BrowserWindow, Tray, nativeImage, Menu, ipcMain } from 'electron';
import * as path from 'path';

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
  };
}

interface OllamaStreamResponse {
  message?: {
    content?: string;
    thinking?: string;
  };
  done?: boolean;
}

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

async function sendToOllama(model: string, messages: { role: string; content: string }[]): Promise<string> {
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

interface StreamChunk {
  type: 'thinking' | 'content';
  content: string;
}

async function* streamFromOllama(
  model: string,
  messages: { role: string; content: string }[],
  abortController: AbortController
): AsyncGenerator<StreamChunk> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: true,
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
              yield { type: 'thinking', content: data.message.thinking };
            }
            if (data.message?.content) {
              yield { type: 'content', content: data.message.content };
            }
            if (data.done === true) {
              return;
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
          yield { type: 'thinking', content: data.message.thinking };
        }
        if (data.message?.content) {
          yield { type: 'content', content: data.message.content };
        }
        if (data.done === true) {
          return;
        }
      } catch (e) {
        console.error('Error parsing final stream line:', e);
      }
    }

    return;
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
  
  tray.setToolTip('Assistant');
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
  return await sendToOllama(model, messages);
});

ipcMain.handle('send-message-stream', async (event, model: string, messages: { role: string; content: string }[]) => {
  try {
    currentAbortController = new AbortController();
    let inThinking = false;
    for await (const chunk of streamFromOllama(model, messages, currentAbortController)) {
      if (chunk.type === 'thinking') {
        if (!inThinking) {
          event.sender.send('ollama-chunk', 'Thinking...\n');
          inThinking = true;
        }
        event.sender.send('ollama-chunk', chunk.content);
      } else if (chunk.type === 'content') {
        if (inThinking) {
          event.sender.send('ollama-chunk', '\n...done thinking.\n');
          inThinking = false;
        }
        event.sender.send('ollama-chunk', chunk.content);
      }
    }
    event.sender.send('ollama-done');
    return { success: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
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

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.dock?.hide();