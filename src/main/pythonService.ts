import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

const PYTHON_SERVICE_PORT = 8000;
const PYTHON_SERVICE_HOST = '127.0.0.1';

let pythonProcess: ChildProcess | null = null;
let isServiceReady = false;

function getPythonServicePath(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  if (isDev) {
    return path.join(__dirname, '../../python-service');
  }
  
  return path.join(process.resourcesPath, 'python-service');
}

function getPythonExecutable(): string {
  const venvPath = path.join(getPythonServicePath(), 'venv');
  if (fs.existsSync(venvPath)) {
    if (process.platform === 'win32') {
      return path.join(venvPath, 'Scripts', 'python.exe');
    }
    return path.join(venvPath, 'bin', 'python');
  }

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    console.warn('[PythonService] No local virtualenv found, falling back to system Python');
    if (process.platform === 'win32') {
      return 'python';
    }
    return 'python3';
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

export async function startPythonService(): Promise<boolean> {
  if (pythonProcess) {
    console.log('[PythonService] Already running');
    return true;
  }
  
  const serviceDir = getPythonServicePath();
  const mainPyPath = path.join(serviceDir, 'main.py');
  
  if (!fs.existsSync(mainPyPath)) {
    console.error(`[PythonService] main.py not found at ${mainPyPath}`);
    return false;
  }
  
  console.log(`[PythonService] Starting Python service from ${serviceDir}`);
  
  const pythonExe = getPythonExecutable();
  
  pythonProcess = spawn(pythonExe, ['-m', 'uvicorn', 'main:app', '--host', PYTHON_SERVICE_HOST, '--port', String(PYTHON_SERVICE_PORT)], {
    cwd: serviceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  
  pythonProcess.stdout?.on('data', (data) => {
    console.log(`[PythonService] ${data.toString().trim()}`);
  });
  
  pythonProcess.stderr?.on('data', (data) => {
    console.error(`[PythonService] ${data.toString().trim()}`);
  });
  
  pythonProcess.on('error', (err) => {
    console.error('[PythonService] Process error:', err);
    pythonProcess = null;
    isServiceReady = false;
  });
  
  pythonProcess.on('exit', (code, signal) => {
    console.log(`[PythonService] Process exited with code ${code}, signal ${signal}`);
    pythonProcess = null;
    isServiceReady = false;
  });
  
  const ready = await waitForService();
  isServiceReady = ready;
  
  return ready;
}

async function waitForService(maxAttempts: number = 60, intervalMs: number = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      
      if (response.ok) {
        const data = await response.json() as { status?: string; models_loaded?: boolean };
        if (data.status === 'healthy' && data.models_loaded) {
          console.log('[PythonService] Service is ready');
          return true;
        }
      }
    } catch {
      // Service not ready yet
    }
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  console.error('[PythonService] Service failed to start within timeout');
  return false;
}

export async function stopPythonService(): Promise<void> {
  if (!pythonProcess) {
    return;
  }
  
  console.log('[PythonService] Stopping Python service');
  
  pythonProcess.kill('SIGTERM');
  
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (pythonProcess) {
        pythonProcess.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    
    pythonProcess?.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  
  pythonProcess = null;
  isServiceReady = false;
}

export function isPythonServiceReady(): boolean {
  return isServiceReady;
}

export async function processVoiceFlow(audioBuffer: Buffer): Promise<{
  text: string;
  raw_text?: string;
  speech_duration_ms?: number;
  success: boolean;
  error?: string;
}> {
  const url = `http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/process-flow`;
  
  try {
    const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    
    const body = Buffer.concat([
      Buffer.from(header),
      audioBuffer,
      Buffer.from(footer),
    ]);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
    
    const data = await response.json() as { 
      text?: string; 
      raw_text?: string; 
      speech_duration_ms?: number;
      success?: boolean; 
      error?: string;
    };
    
    return {
      text: data.text || '',
      raw_text: data.raw_text,
      speech_duration_ms: data.speech_duration_ms,
      success: data.success ?? false,
      error: data.error,
    };
  } catch (error) {
    console.error('[PythonService] Error processing voice:', error);
    return {
      text: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function transcribeOnly(audioBuffer: Buffer): Promise<{
  text: string;
  success: boolean;
  error?: string;
}> {
  const url = `http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/transcribe-only`;
  
  try {
    const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}`;
    const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    
    const body = Buffer.concat([
      Buffer.from(header),
      audioBuffer,
      Buffer.from(footer),
    ]);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });
    
    const data = await response.json() as { text?: string; success?: boolean; error?: string };
    
    return {
      text: data.text || '',
      success: data.success ?? false,
      error: data.error,
    };
  } catch (error) {
    console.error('[PythonService] Error transcribing:', error);
    return {
      text: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}