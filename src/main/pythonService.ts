import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import type { RecordedAudio } from './audioRecorder';
import type { VoiceContext } from '../shared/voice';

const PYTHON_SERVICE_PORT = Number(process.env.VOICE_SERVICE_PORT || 8765);
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

  const existingServiceHealth = await checkServiceHealth();
  if (existingServiceHealth.ready) {
    console.log(`[PythonService] Reusing healthy service already running on port ${PYTHON_SERVICE_PORT}`);
    isServiceReady = true;
    return true;
  }

  if (existingServiceHealth.reachable) {
    console.error(`[PythonService] Port ${PYTHON_SERVICE_PORT} is occupied by an incompatible service`);
    return false;
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

async function checkServiceHealth(): Promise<{ reachable: boolean; ready: boolean }> {
  try {
    const response = await fetch(`http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { reachable: true, ready: false };
    }

    const data = await response.json() as {
      status?: string;
      models_loaded?: boolean;
      transcription_provider?: string;
    };
    return {
      reachable: true,
      ready: data.status === 'healthy'
        && data.models_loaded === true
        && data.transcription_provider === 'openrouter',
    };
  } catch {
    return { reachable: false, ready: false };
  }
}

async function waitForService(maxAttempts: number = 60, intervalMs: number = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if ((await checkServiceHealth()).ready) {
      console.log('[PythonService] Service is ready');
      return true;
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

type UploadableAudio = Buffer | RecordedAudio;

function getAudioUploadParts(audio: UploadableAudio): {
  chunks: Iterable<Uint8Array>;
  byteLength: number;
  filename: string;
  contentType: string;
} {
  if (Buffer.isBuffer(audio)) {
    return {
      chunks: [audio],
      byteLength: audio.byteLength,
      filename: 'audio.wav',
      contentType: 'audio/wav',
    };
  }

  return {
    chunks: audio.chunks,
    byteLength: audio.byteLength,
    filename: audio.filename,
    contentType: audio.contentType,
  };
}

export function createMultipartUpload(audio: UploadableAudio, context?: VoiceContext): {
  boundary: string;
  contentLength: number;
  body: AsyncIterable<Uint8Array>;
} {
  const { chunks, byteLength, filename, contentType } = getAudioUploadParts(audio);
  const boundary = `----WebKitFormBoundary${Math.random().toString(16).slice(2)}`;
  const contextPart = context
    ? Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="context"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(context)}\r\n`
    )
    : Buffer.alloc(0);
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  async function* body(): AsyncIterable<Uint8Array> {
    if (contextPart.byteLength > 0) {
      yield contextPart;
    }
    yield fileHeader;
    for (const chunk of chunks) {
      yield chunk;
    }
    yield footer;
  }

  return {
    boundary,
    contentLength: contextPart.byteLength + fileHeader.byteLength + byteLength + footer.byteLength,
    body: body(),
  };
}

export async function processVoiceFlow(audioBuffer: UploadableAudio, context?: VoiceContext): Promise<{
  text: string;
  raw_text?: string;
  speech_duration_ms?: number;
  refinement_mode?: string;
  applied_edits?: string[];
  success: boolean;
  error?: string;
}> {
  const url = `http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/process-flow`;
  
  try {
    const upload = createMultipartUpload(audioBuffer, context);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload.boundary}`,
        'Content-Length': String(upload.contentLength),
      },
      body: upload.body,
      duplex: 'half',
      signal: AbortSignal.timeout(60000),
    });
    
    const data = await response.json() as { 
      text?: string; 
      raw_text?: string; 
      speech_duration_ms?: number;
      refinement_mode?: string;
      applied_edits?: string[];
      success?: boolean; 
      error?: string;
    };
    
    return {
      text: data.text || '',
      raw_text: data.raw_text,
      speech_duration_ms: data.speech_duration_ms,
      refinement_mode: data.refinement_mode,
      applied_edits: data.applied_edits,
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

export async function transcribeOnly(audioBuffer: UploadableAudio): Promise<{
  text: string;
  success: boolean;
  error?: string;
}> {
  const url = `http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/transcribe-only`;
  
  try {
    const upload = createMultipartUpload(audioBuffer);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload.boundary}`,
        'Content-Length': String(upload.contentLength),
      },
      body: upload.body,
      duplex: 'half',
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
