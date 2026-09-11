import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import type { RecordedAudio } from './audioRecorder';
import type { VoiceContext } from '../shared/voice';
import { debugLog, infoLog } from './logger';
import { getManagedVoiceRuntimeEnv, getReadyManagedVoicePythonExecutable } from './localVoiceModelSetup';

const PYTHON_SERVICE_PORT = Number(process.env.VOICE_SERVICE_PORT || 8765);
const PYTHON_SERVICE_HOST = '127.0.0.1';
const READY_TRANSCRIPTION_PROVIDERS = new Set(['local-parakeet', 'openrouter']);
// Must exceed local Parakeet cold-start wait (default 90s) plus inference/refinement headroom.
const PROCESS_FLOW_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.VOICE_PROCESS_FLOW_TIMEOUT_MS || 150_000),
);

type VoiceServiceHealth = {
  status?: string;
  models_loaded?: boolean;
  transcription_provider?: string;
  transcription_model?: string;
  local_parakeet_enabled?: boolean;
  local_parakeet_loaded?: boolean;
  local_parakeet_loading?: boolean;
  local_parakeet_loading_for_ms?: number | null;
  local_parakeet_device?: string | null;
  local_parakeet_error?: string | null;
  local_parakeet_timeout_fallback_enabled?: boolean;
  local_parakeet_cold_start_budget_seconds?: number;
  openrouter_configured?: boolean;
  refinement_model?: string;
};

let pythonProcess: ChildProcess | null = null;
let isServiceReady = false;

function getPythonServicePath(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  
  if (isDev) {
    return path.join(__dirname, '../../python-service');
  }
  
  return path.join(process.resourcesPath, 'python-service');
}

function getPythonRuntime(): { executable: string; env: NodeJS.ProcessEnv } {
  const managedPythonExecutable = getReadyManagedVoicePythonExecutable();
  if (managedPythonExecutable) {
    return {
      executable: managedPythonExecutable,
      env: getManagedVoiceRuntimeEnv(),
    };
  }

  const venvPath = path.join(getPythonServicePath(), 'venv');
  if (fs.existsSync(venvPath)) {
    if (process.platform === 'win32') {
      return {
        executable: path.join(venvPath, 'Scripts', 'python.exe'),
        env: {},
      };
    }
    return {
      executable: path.join(venvPath, 'bin', 'python'),
      env: {},
    };
  }

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    console.warn('[PythonService] No local virtualenv found, falling back to system Python');
    if (process.platform === 'win32') {
      return { executable: 'python', env: {} };
    }
    return { executable: 'python3', env: {} };
  }

  return {
    executable: process.platform === 'win32' ? 'python' : 'python3',
    env: {},
  };
}

export async function startPythonService(): Promise<boolean> {
  if (pythonProcess) {
    debugLog('[PythonService] Already running');
    return true;
  }

  const existingServiceHealth = await checkServiceHealth();
  if (existingServiceHealth.ready) {
    infoLog(`[PythonService] Reusing healthy service already running on port ${PYTHON_SERVICE_PORT}`);
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

  infoLog(`[PythonService] Starting Python service from ${serviceDir}`);

  const pythonRuntime = getPythonRuntime();

  pythonProcess = spawn(pythonRuntime.executable, ['-m', 'uvicorn', 'main:app', '--host', PYTHON_SERVICE_HOST, '--port', String(PYTHON_SERVICE_PORT)], {
    cwd: serviceDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...pythonRuntime.env,
      PYTHONUNBUFFERED: '1',
    },
  });

  const spawnedProcess = pythonProcess;
  let spawnedExited = false;

  pythonProcess.stdout?.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    // VoiceService stage logs and other operational output should stay visible at default warn level.
    if (line.includes('[VoiceService]') || line.includes('ERROR') || line.includes('WARNING')) {
      console.warn(`[PythonService] ${line}`);
      return;
    }
    debugLog(`[PythonService] ${line}`);
  });

  pythonProcess.stderr?.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;
    if (line.includes('[VoiceService]')) {
      console.warn(`[PythonService] ${line}`);
      return;
    }
    console.error(`[PythonService] ${line}`);
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
    debugLog(`[PythonService] Process exited with code ${code}, signal ${signal}`);
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

async function checkServiceHealth(): Promise<{
  reachable: boolean;
  ready: boolean;
  health?: VoiceServiceHealth;
}> {
  try {
    const response = await fetch(`http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { reachable: true, ready: false };
    }

    const data = await response.json() as VoiceServiceHealth;
    return {
      reachable: true,
      ready: data.status === 'healthy'
        && data.models_loaded === true
        && READY_TRANSCRIPTION_PROVIDERS.has(data.transcription_provider || ''),
      health: data,
    };
  } catch {
    return { reachable: false, ready: false };
  }
}

function isAbortTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name;
  return name === 'TimeoutError' || name === 'AbortError' || /aborted due to timeout/i.test(error.message);
}

async function reclaimPortIfStale(): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }

  try {
    const { execSync } = await import('child_process');
    const output = execSync(`lsof -ti tcp:${PYTHON_SERVICE_PORT} -sTCP:LISTEN`, {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const pids = output.split('\n').map((p) => p.trim()).filter(Boolean);
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
  } catch {
    // lsof found nothing or is unavailable; nothing to reclaim.
    return;
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
      infoLog('[PythonService] Service is ready');
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
  
  infoLog('[PythonService] Stopping Python service');

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
  } catch {
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
  diagnostics?: unknown;
  success: boolean;
  error?: string;
}> {
  const url = `http://${PYTHON_SERVICE_HOST}:${PYTHON_SERVICE_PORT}/process-flow`;
  const startedAt = performance.now();
  const preflight = await checkServiceHealth();

  const audioParts = getAudioUploadParts(audioBuffer);
  const recordedAudio = Buffer.isBuffer(audioBuffer) ? null : audioBuffer;
  console.warn('[PythonService] process-flow starting:', {
    timeoutMs: PROCESS_FLOW_TIMEOUT_MS,
    audio: {
      durationMs: recordedAudio ? Math.round(recordedAudio.durationMs) : undefined,
      byteLength: audioParts.byteLength,
      peak: recordedAudio ? Number(recordedAudio.peak.toFixed(4)) : undefined,
      rms: recordedAudio ? Number(recordedAudio.rms.toFixed(4)) : undefined,
    },
    context: context
      ? {
          destination: context.destination,
          appName: context.app?.name,
          bundleId: context.app?.bundleId,
        }
      : null,
    service: {
      reachable: preflight.reachable,
      ready: preflight.ready,
      transcriptionProvider: preflight.health?.transcription_provider,
      transcriptionModel: preflight.health?.transcription_model,
      localParakeetEnabled: preflight.health?.local_parakeet_enabled,
      localParakeetLoaded: preflight.health?.local_parakeet_loaded,
      localParakeetLoading: preflight.health?.local_parakeet_loading,
      localParakeetLoadingForMs: preflight.health?.local_parakeet_loading_for_ms,
      localParakeetDevice: preflight.health?.local_parakeet_device,
      localParakeetError: preflight.health?.local_parakeet_error,
      timeoutFallbackEnabled: preflight.health?.local_parakeet_timeout_fallback_enabled,
      coldStartBudgetSeconds: preflight.health?.local_parakeet_cold_start_budget_seconds,
      openrouterConfigured: preflight.health?.openrouter_configured,
      refinementModel: preflight.health?.refinement_model,
    },
  });

  try {
    const uploadStartedAt = performance.now();
    const upload = createMultipartUpload(audioBuffer, context);
    const uploadPrepareMs = Math.round(performance.now() - uploadStartedAt);

    const fetchStartedAt = performance.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${upload.boundary}`,
        'Content-Length': String(upload.contentLength),
      },
      body: upload.body,
      duplex: 'half',
      signal: AbortSignal.timeout(PROCESS_FLOW_TIMEOUT_MS),
    });
    const fetchMs = Math.round(performance.now() - fetchStartedAt);

    const parseStartedAt = performance.now();
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
      diagnostics?: unknown;
      success?: boolean;
      error?: string;
    }>(response, 'process-flow');
    const parseMs = Math.round(performance.now() - parseStartedAt);
    const totalMs = Math.round(performance.now() - startedAt);

    console.warn('[PythonService] process-flow timing:', {
      uploadPrepareMs,
      fetchMs,
      parseMs,
      totalMs,
      timeoutMs: PROCESS_FLOW_TIMEOUT_MS,
      audioBytes: upload.contentLength,
      success: parsed.ok ? Boolean(parsed.data.success) : false,
      transcriptionMetadata: parsed.ok ? parsed.data.transcription_metadata : undefined,
      speechDurationMs: parsed.ok ? parsed.data.speech_duration_ms : undefined,
      error: parsed.ok ? parsed.data.error : parsed.error,
    });

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
      diagnostics: data.diagnostics,
      success: data.success ?? false,
      error: data.error,
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const postFailureHealth = await checkServiceHealth();
    if (isAbortTimeoutError(error)) {
      console.error('[PythonService] process-flow aborted by client timeout:', {
        elapsedMs,
        timeoutMs: PROCESS_FLOW_TIMEOUT_MS,
        preflight: {
          localParakeetLoaded: preflight.health?.local_parakeet_loaded,
          localParakeetLoading: preflight.health?.local_parakeet_loading,
          localParakeetLoadingForMs: preflight.health?.local_parakeet_loading_for_ms,
          coldStartBudgetSeconds: preflight.health?.local_parakeet_cold_start_budget_seconds,
          timeoutFallbackEnabled: preflight.health?.local_parakeet_timeout_fallback_enabled,
          localParakeetError: preflight.health?.local_parakeet_error,
        },
        afterTimeout: {
          reachable: postFailureHealth.reachable,
          ready: postFailureHealth.ready,
          localParakeetLoaded: postFailureHealth.health?.local_parakeet_loaded,
          localParakeetLoading: postFailureHealth.health?.local_parakeet_loading,
          localParakeetLoadingForMs: postFailureHealth.health?.local_parakeet_loading_for_ms,
          localParakeetError: postFailureHealth.health?.local_parakeet_error,
        },
        hint:
          'Electron aborted before /process-flow returned. Check [VoiceService] stage logs; cold Parakeet load can exceed the old 60s client timeout.',
        error,
      });
      return {
        text: '',
        success: false,
        error:
          `Voice processing timed out after ${elapsedMs}ms (client limit ${PROCESS_FLOW_TIMEOUT_MS}ms). `
          + 'Local Parakeet may still be loading — watch [VoiceService] logs and retry once the model is ready.',
      };
    }
    console.error('[PythonService] Error processing voice after', elapsedMs, 'ms:', error);
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
      signal: AbortSignal.timeout(PROCESS_FLOW_TIMEOUT_MS),
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
    if (isAbortTimeoutError(error)) {
      console.error('[PythonService] transcribe-only aborted by client timeout:', {
        timeoutMs: PROCESS_FLOW_TIMEOUT_MS,
        error,
      });
      return {
        text: '',
        success: false,
        error: `Transcription timed out after ${PROCESS_FLOW_TIMEOUT_MS}ms`,
      };
    }
    console.error('[PythonService] Error transcribing:', error);
    return {
      text: '',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
