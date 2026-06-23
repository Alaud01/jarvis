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

  // Port is free according to health check, but a previous orphaned process may
  // still hold the socket. Try to reclaim the port before spawning so our new
  // process can bind successfully.
  await reclaimPortIfStale();

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

  const spawnedProcess = pythonProcess;
  let spawnedExited = false;

  pythonProcess.stdout?.on('data', (data) => {
    console.log(`[PythonService] ${data.toString().trim()}`);
  });

  pythonProcess.stderr?.on('data', (data) => {
    console.error(`[PythonService] ${data.toString().trim()}`);
  });

  pythonProcess.on('error', (err) => {
    console.error('[PythonService] Process error:', err);
    if (pythonProcess === spawnedProcess) {
      pythonProcess = null;
    }
    isServiceReady = false;
    spawnedExited = true;
  });

  pythonProcess.on('exit', (code, signal) => {
    console.log(`[PythonService] Process exited with code ${code}, signal ${signal}`);
    if (pythonProcess === spawnedProcess) {
      pythonProcess = null;
    }
    isServiceReady = false;
    spawnedExited = true;
  });

  // Bail as soon as our spawned process dies instead of latching onto an
  // unrelated/stale service that may happen to be listening on the port.
  const ready = await waitForService(() => !spawnedExited);
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

async function reclaimPortIfStale(): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  let pids: string[] = [];
  try {
    const { execSync } = await import('child_process');
    const output = execSync(`lsof -ti tcp:${PYTHON_SERVICE_PORT} -sTCP:LISTEN`, {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    pids = output.split('\n').map((p) => p.trim()).filter(Boolean);
  } catch {
    // lsof found nothing or is unavailable; nothing to reclaim.
    return;
  }

  if (pids.length === 0) {
    return;
  }

  console.warn(`[PythonService] Found stale process(es) ${pids.join(', ')} on port ${PYTHON_SERVICE_PORT}; attempting to reclaim`);
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // Process may have already exited; ignore.
    }
  }

  // Give the stale process a moment to release the socket.
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function waitForService(
  shouldContinue: () => boolean = () => true,
  maxAttempts: number = 60,
  intervalMs: number = 1000,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (!shouldContinue()) {
      console.error('[PythonService] Spawned process exited during startup; aborting wait');
      return false;
    }

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
  const processToStop = pythonProcess;
  if (!processToStop) {
    return;
  }
  
  console.log('[PythonService] Stopping Python service');

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (processToStop.exitCode === null && processToStop.signalCode === null) {
        processToStop.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    processToStop.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    processToStop.kill('SIGTERM');
  });

  if (pythonProcess === processToStop) {
    pythonProcess = null;
  }
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

async function parseJsonResponse<T extends Record<string, unknown>>(
  response: Response,
  context: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const responseText = await response.text();

  if (!response.ok || responseText.length === 0) {
    let detail = responseText;
    try {
      const parsed = JSON.parse(responseText) as { error?: string; detail?: unknown };
      detail = parsed.error ?? (typeof parsed.detail === 'string' ? parsed.detail : responseText);
    } catch {
      // Body is not JSON (e.g. "Internal Server Error"); use raw text.
    }
    const trimmed = (detail || response.statusText || '').toString().slice(0, 200);
    console.error(`[PythonService] ${context} returned status ${response.status}: ${trimmed}`);
    return { ok: false, error: `Voice service error (HTTP ${response.status}): ${trimmed}` };
  }

  try {
    return { ok: true, data: JSON.parse(responseText) as T };
  } catch (error) {
    const preview = responseText.slice(0, 200);
    console.error(`[PythonService] ${context} returned non-JSON body: ${preview}`);
    return {
      ok: false,
      error: `Voice service returned a non-JSON response: ${preview}`,
    };
  }
}

export async function processVoiceFlow(audioBuffer: UploadableAudio, context?: VoiceContext): Promise<{
  text: string;
  raw_text?: string;
  speech_duration_ms?: number;
  refinement_mode?: string;
  applied_edits?: string[];
  applied_rules?: Array<{
    ruleId: string;
    source: string;
    replacement: string;
    start: number;
    end: number;
  }>;
  transcription_metadata?: {
    provider?: string;
    model?: string;
    used_vocabulary_guidance?: boolean;
    fallback_used?: boolean;
    fallback_reason?: string | null;
  };
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

    const parsed = await parseJsonResponse<{
      text?: string;
      raw_text?: string;
      speech_duration_ms?: number;
      refinement_mode?: string;
      applied_edits?: string[];
      applied_rules?: Array<{
        ruleId: string;
        source: string;
        replacement: string;
        start: number;
        end: number;
      }>;
      transcription_metadata?: {
        provider?: string;
        model?: string;
        used_vocabulary_guidance?: boolean;
        fallback_used?: boolean;
        fallback_reason?: string | null;
      };
      success?: boolean;
      error?: string;
    }>(response, 'process-flow');

    if (!parsed.ok) {
      return { text: '', success: false, error: parsed.error };
    }

    const data = parsed.data;
    return {
      text: data.text || '',
      raw_text: data.raw_text,
      speech_duration_ms: data.speech_duration_ms,
      refinement_mode: data.refinement_mode,
      applied_edits: data.applied_edits,
      applied_rules: data.applied_rules,
      transcription_metadata: data.transcription_metadata,
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
  transcription_metadata?: {
    provider?: string;
    model?: string;
    used_vocabulary_guidance?: boolean;
    fallback_used?: boolean;
    fallback_reason?: string | null;
  };
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

    const parsed = await parseJsonResponse<{
      text?: string;
      transcription_metadata?: {
        provider?: string;
        model?: string;
        used_vocabulary_guidance?: boolean;
        fallback_used?: boolean;
        fallback_reason?: string | null;
      };
      success?: boolean;
      error?: string;
    }>(
      response,
      'transcribe-only',
    );

    if (!parsed.ok) {
      return { text: '', success: false, error: parsed.error };
    }

    const data = parsed.data;
    return {
      text: data.text || '',
      transcription_metadata: data.transcription_metadata,
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
