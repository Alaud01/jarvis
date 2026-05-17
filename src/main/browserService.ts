import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import type { BrowserTraceAction, BrowserTraceEvent, BrowserTraceResult } from '../shared/browser';

const BROWSER_SERVICE_PORT = 8001;
const BROWSER_SERVICE_HOST = '127.0.0.1';
const BROWSER_TASK_TIMEOUT_MS = 12 * 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;
const BROWSER_SETUP_TIMEOUT_MS = 15 * 60_000;
const BROWSER_SERVICE_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.BROWSER_SERVICE_IDLE_TIMEOUT_MS || `${5 * 60_000}`,
  10,
);
const BROWSER_SETUP_STATE_VERSION = 1;
const BROWSER_SETUP_STAMP_FILE = 'setup-state.json';
const BROWSER_TRACE_PREFIX = '__JARVIS_BROWSER_TRACE__ ';

let browserProcess: ChildProcess | null = null;
let restartInProgress = false;
let browserStdoutBuffer = '';
let activeTraceCallback: ((event: BrowserTraceEvent) => void) | null = null;
let browserIdleTimer: NodeJS.Timeout | null = null;

export interface BrowserTaskResult {
  success: boolean;
  result?: string;
  error?: string;
  steps?: number;
}

interface SetupStamp {
  version: number;
  requirementsHash: string;
}

class BrowserTaskTimeoutError extends Error {
  constructor() {
    super('Browser task timed out.');
    this.name = 'BrowserTaskTimeoutError';
  }
}

class BrowserTaskAbortError extends Error {
  constructor() {
    super('Browser task was cancelled.');
    this.name = 'BrowserTaskAbortError';
  }
}

interface BrowserServiceHttpResult<T> {
  statusCode: number;
  data: T | null;
  rawBody: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseBrowserTraceEvent(raw: string): BrowserTraceEvent | null {
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) {
      return null;
    }

    if (
      typeof parsed.runId !== 'string'
      || typeof parsed.event !== 'string'
      || typeof parsed.timestamp !== 'string'
      || typeof parsed.status !== 'string'
    ) {
      return null;
    }

    return parsed as unknown as BrowserTraceEvent;
  } catch (error) {
    console.error('[BrowserAgent] Failed to parse trace event:', error);
    return null;
  }
}

function truncateForLog(value: string | undefined, maxLength = 700): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function formatActionForLog(action: BrowserTraceAction): string {
  const record = asRecord(action);
  if (!record) {
    return 'action';
  }

  const toolName = typeof record.toolName === 'string' ? record.toolName : 'action';
  const input = asRecord(record.input);
  const inputPreview = input && Object.keys(input).length > 0
    ? ` ${JSON.stringify(input).slice(0, 240)}`
    : '';

  return `${toolName}${inputPreview}`;
}

function formatResultForLog(result: BrowserTraceResult): string {
  if (result.error) {
    return `error=${truncateForLog(result.error, 240)}`;
  }
  if (result.extractedContent) {
    return `extracted=${truncateForLog(result.extractedContent, 240)}`;
  }
  if (result.longTermMemory) {
    return `memory=${truncateForLog(result.longTermMemory, 240)}`;
  }
  if (result.isDone) {
    return `done success=${String(result.success)}`;
  }

  return 'ok';
}

function logBrowserTraceEvent(event: BrowserTraceEvent): void {
  if (event.event === 'started') {
    console.log('[BrowserAgent] Task started', {
      runId: event.runId,
      model: event.model,
      plannerModel: event.plannerModel,
      useVision: event.useVision,
      instruction: truncateForLog(event.instruction, 300),
    });
    return;
  }

  if ((event.event === 'completed' || event.event === 'failed' || event.event === 'cancelled')) {
    console.log(`[BrowserAgent] Task ${event.event}`, {
      runId: event.runId,
      status: event.status,
      steps: event.steps,
      elapsedMs: event.elapsedMs,
      summary: truncateForLog(event.summary, 500),
      error: truncateForLog(event.error, 300),
    });
    return;
  }

  const step = event.step;
  if (!step) {
    console.log('[BrowserAgent] Trace event', event);
    return;
  }

  if (event.event === 'step') {
    console.log(`[BrowserAgent] Step ${step.stepIndex + 1} thinking`, {
      runId: event.runId,
      url: step.url,
      title: step.pageTitle,
      thinking: truncateForLog(step.thinking, 700),
      nextGoal: truncateForLog(step.nextGoal, 300),
      actions: step.actions?.map(formatActionForLog),
    });
    return;
  }

  console.log(`[BrowserAgent] Step ${step.stepIndex + 1} result`, {
    runId: event.runId,
    durationMs: step.durationMs,
    results: step.results?.map(formatResultForLog),
  });
}

function handleBrowserServiceStdout(data: Buffer): void {
  browserStdoutBuffer += data.toString();
  const lines = browserStdoutBuffer.split(/\r?\n/);
  browserStdoutBuffer = lines.pop() ?? '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith(BROWSER_TRACE_PREFIX)) {
      const event = parseBrowserTraceEvent(line.slice(BROWSER_TRACE_PREFIX.length));
      if (event) {
        logBrowserTraceEvent(event);
        activeTraceCallback?.(event);
      }
      continue;
    }

    console.log(`[BrowserService] ${line}`);
  }
}

function getBrowserServicePath(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    return path.join(__dirname, '../../browser-service');
  }

  return path.join(process.resourcesPath, 'browser-service');
}

function getBrowserRuntimePath(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    return getBrowserServicePath();
  }

  return path.join(app.getPath('userData'), 'browser-service');
}

function getBrowserStatePath(): string {
  return path.join(app.getPath('userData'), 'browser-service-state');
}

function getVenvPath(): string {
  return path.join(getBrowserRuntimePath(), 'venv');
}

function getVenvPythonExecutable(): string {
  const venvPath = getVenvPath();
  if (process.platform === 'win32') {
    return path.join(venvPath, 'Scripts', 'python.exe');
  }

  return path.join(venvPath, 'bin', 'python');
}

function getBootstrapPythonExecutable(): string {
  return process.env.BROWSER_SERVICE_PYTHON
    || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
}

function getSetupStampPath(): string {
  return path.join(getBrowserStatePath(), BROWSER_SETUP_STAMP_FILE);
}

function spawnBrowserProcess(serviceDir: string, pythonExe: string): ChildProcess {

  const proc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'main:app', '--host', BROWSER_SERVICE_HOST, '--port', String(BROWSER_SERVICE_PORT)],
    {
      cwd: serviceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }
  );

  browserStdoutBuffer = '';

  proc.stdout?.on('data', (data: Buffer) => {
    handleBrowserServiceStdout(data);
  });

  proc.stderr?.on('data', (data) => {
    console.error(`[BrowserService] ${data.toString().trim()}`);
  });

  proc.on('error', (err) => {
    console.error('[BrowserService] Process error:', err);
    if (browserProcess === proc) {
      browserProcess = null;
    }
  });

  proc.on('exit', (code, signal) => {
    if (browserStdoutBuffer.trim()) {
      handleBrowserServiceStdout(Buffer.from('\n'));
    }
    console.log(`[BrowserService] Process exited with code ${code}, signal ${signal}`);
    if (browserProcess === proc) {
      browserProcess = null;
    }
  });

  return proc;
}

function clearBrowserIdleTimer(): void {
  if (browserIdleTimer) {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
  }
}

function scheduleBrowserServiceIdleStop(): void {
  clearBrowserIdleTimer();

  if (!Number.isFinite(BROWSER_SERVICE_IDLE_TIMEOUT_MS) || BROWSER_SERVICE_IDLE_TIMEOUT_MS <= 0) {
    return;
  }

  browserIdleTimer = setTimeout(() => {
    browserIdleTimer = null;
    void stopBrowserService().catch((error) => {
      console.error('[BrowserService] Failed to stop idle browser service:', error);
    });
  }, BROWSER_SERVICE_IDLE_TIMEOUT_MS);
  browserIdleTimer.unref?.();
}

function runSetupCommand(command: string, args: string[], cwd: string, timeoutMs = BROWSER_SETUP_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[BrowserService] Running setup command: ${command} ${args.join(' ')}`);

    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Setup command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      console.log(`[BrowserService setup] ${data.toString().trim()}`);
    });

    proc.stderr?.on('data', (data) => {
      console.error(`[BrowserService setup] ${data.toString().trim()}`);
    });

    proc.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Setup command failed with code ${code}, signal ${signal}: ${command} ${args.join(' ')}`));
    });
  });
}

function hashRequirements(requirementsPath: string): string {
  const contents = fs.readFileSync(requirementsPath);
  return createHash('sha256')
    .update(String(BROWSER_SETUP_STATE_VERSION))
    .update(contents)
    .digest('hex');
}

function readSetupStamp(): SetupStamp | null {
  try {
    const raw = fs.readFileSync(getSetupStampPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SetupStamp>;
    if (
      parsed.version === BROWSER_SETUP_STATE_VERSION
      && typeof parsed.requirementsHash === 'string'
    ) {
      return {
        version: parsed.version,
        requirementsHash: parsed.requirementsHash,
      };
    }
  } catch {
    // Missing or invalid setup state means dependencies should be refreshed.
  }

  return null;
}

function writeSetupStamp(requirementsHash: string): void {
  const stamp: SetupStamp = {
    version: BROWSER_SETUP_STATE_VERSION,
    requirementsHash,
  };

  fs.mkdirSync(getBrowserStatePath(), { recursive: true });
  fs.writeFileSync(getSetupStampPath(), `${JSON.stringify(stamp, null, 2)}\n`);
}

function postJsonToBrowserService<T>(
  pathname: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserServiceHttpResult<T>> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };

    const request = http.request(
      {
        hostname: BROWSER_SERVICE_HOST,
        port: BROWSER_SERVICE_PORT,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      },
      (response) => {
        response.setEncoding('utf8');
        let rawBody = '';

        response.on('data', (chunk) => {
          rawBody += chunk;
        });

        response.on('end', () => {
          let data: T | null = null;
          if (rawBody.trim()) {
            try {
              data = JSON.parse(rawBody) as T;
            } catch {
              data = null;
            }
          }

          finish(() => resolve({
            statusCode: response.statusCode ?? 0,
            data,
            rawBody,
          }));
        });
      },
    );

    const timeout = setTimeout(() => {
      finish(() => {
        request.destroy();
        reject(new BrowserTaskTimeoutError());
      });
    }, timeoutMs);

    const onAbort = () => {
      finish(() => {
        request.destroy();
        reject(new BrowserTaskAbortError());
      });
    };

    request.on('error', (error) => {
      finish(() => reject(error));
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    request.write(requestBody);
    request.end();
  });
}

async function hasPlaywrightChromium(pythonExe: string, serviceDir: string): Promise<boolean> {
  const script = [
    'from pathlib import Path',
    'from playwright.sync_api import sync_playwright',
    'p = sync_playwright().start()',
    'path = p.chromium.executable_path',
    'p.stop()',
    'raise SystemExit(0 if Path(path).is_file() else 1)',
  ].join('; ');

  try {
    await runSetupCommand(pythonExe, ['-c', script], serviceDir, 30_000);
    return true;
  } catch {
    return false;
  }
}

async function ensureBrowserServiceEnvironment(serviceDir: string): Promise<string | null> {
  const requirementsPath = path.join(serviceDir, 'requirements.txt');
  if (!fs.existsSync(requirementsPath)) {
    console.error(`[BrowserService] requirements.txt not found at ${requirementsPath}`);
    return null;
  }

  const runtimeDir = getBrowserRuntimePath();
  fs.mkdirSync(runtimeDir, { recursive: true });

  const venvPath = getVenvPath();
  const venvPython = getVenvPythonExecutable();
  if (!fs.existsSync(venvPython)) {
    const bootstrapPython = getBootstrapPythonExecutable();
    console.log(`[BrowserService] Creating virtualenv at ${venvPath}`);
    try {
      await runSetupCommand(bootstrapPython, ['-m', 'venv', venvPath], serviceDir, 120_000);
    } catch (error) {
      console.error('[BrowserService] Failed to create browser service virtualenv:', error);
      return null;
    }
  }

  const requirementsHash = hashRequirements(requirementsPath);
  const setupStamp = readSetupStamp();
  const dependenciesNeedInstall = setupStamp?.requirementsHash !== requirementsHash;

  try {
    if (dependenciesNeedInstall) {
      console.log('[BrowserService] Installing browser service Python dependencies');
      await runSetupCommand(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], serviceDir);
      await runSetupCommand(venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], serviceDir);
    }

    const chromiumInstalled = await hasPlaywrightChromium(venvPython, serviceDir);
    if (!chromiumInstalled) {
      console.log('[BrowserService] Installing Playwright Chromium');
      await runSetupCommand(venvPython, ['-m', 'playwright', 'install', 'chromium'], serviceDir);
    }

    writeSetupStamp(requirementsHash);
    return venvPython;
  } catch (error) {
    console.error('[BrowserService] Browser service setup failed:', error);
    return null;
  }
}

async function waitForService(maxAttempts: number = 30, intervalMs: number = 1000): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://${BROWSER_SERVICE_HOST}:${BROWSER_SERVICE_PORT}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = await safeParseJSON<{ status?: string }>(response);
        if (data?.status === 'healthy') {
          console.log('[BrowserService] Service is ready');
          return true;
        }
      }
    } catch {
      // Service not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.error('[BrowserService] Service failed to start within timeout');
  return false;
}

async function killPortOccupier(): Promise<void> {
  try {
    const { execSync } = await import('child_process');
    const cmd = process.platform === 'win32'
      ? `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${BROWSER_SERVICE_PORT} ^| findstr LISTENING') do taskkill /PID %a /F`
      : `lsof -ti:${BROWSER_SERVICE_PORT} | xargs kill -9 2>/dev/null || true`;
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    console.log('[BrowserService] Killed stale process on port', BROWSER_SERVICE_PORT);
  } catch {
    // Nothing to kill or lsof not available
  }
}

export async function startBrowserService(): Promise<boolean> {
  clearBrowserIdleTimer();

  if (browserProcess) {
    console.log('[BrowserService] Already running');
    return true;
  }

  const serviceDir = getBrowserServicePath();
  const mainPyPath = path.join(serviceDir, 'main.py');

  if (!fs.existsSync(mainPyPath)) {
    console.error(`[BrowserService] main.py not found at ${mainPyPath}`);
    return false;
  }

  // Always kill any stale process on our port and restart fresh.
  // This ensures we're running the latest code after updates.
  await killPortOccupier();

  const pythonExe = await ensureBrowserServiceEnvironment(serviceDir);
  if (!pythonExe) {
    return false;
  }

  console.log(`[BrowserService] Starting browser service from ${serviceDir}`);

  browserProcess = spawnBrowserProcess(serviceDir, pythonExe);
  const ready = await waitForService();

  return ready;
}

export async function stopBrowserService(): Promise<void> {
  clearBrowserIdleTimer();

  if (!browserProcess) {
    return;
  }

  console.log('[BrowserService] Stopping browser service');

  browserProcess.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (browserProcess) {
        browserProcess.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    browserProcess?.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  browserProcess = null;
}

async function ensureServiceRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://${BROWSER_SERVICE_HOST}:${BROWSER_SERVICE_PORT}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      const data = await safeParseJSON<{ status?: string }>(response);
      if (data?.status === 'healthy') {
        return true;
      }
    }
  } catch {
    // Service not responding
  }

  if (restartInProgress) {
    console.log('[BrowserService] Restart already in progress');
    return false;
  }

  if (browserProcess) {
    console.log('[BrowserService] Service unhealthy, killing stale process');
    browserProcess.kill('SIGTERM');
    browserProcess = null;
  }

  restartInProgress = true;
  console.log('[BrowserService] Service not responding, attempting auto-restart...');

  try {
    const started = await startBrowserService();
    return started;
  } finally {
    restartInProgress = false;
  }
}

async function safeParseJSON<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function cancelBrowserTask(): Promise<void> {
  try {
    await fetch(`http://${BROWSER_SERVICE_HOST}:${BROWSER_SERVICE_PORT}/cancel-browser-task`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    console.log('[BrowserService] Cancelled browser task via API');
  } catch (e) {
    console.error('[BrowserService] Failed to cancel browser task:', e);
  }
}

export async function runBrowserTask(
  task: string,
  model: string,
  provider: string,
  signal?: AbortSignal,
  plannerModel?: string,
  traceCallback?: (event: BrowserTraceEvent) => void,
): Promise<BrowserTaskResult> {
  const running = await ensureServiceRunning();
  if (!running) {
    return {
      success: false,
      error: 'Browser automation service is not running and could not be restarted.',
    };
  }

  if (signal?.aborted) {
    await cancelBrowserTask();
    return { success: false, error: 'Browser task was cancelled.' };
  }

  const runId = randomUUID();
  const previousTraceCallback = activeTraceCallback;
  const activeForThisRun = traceCallback ?? null;
  activeTraceCallback = activeForThisRun;

  try {
    const response = await postJsonToBrowserService<BrowserTaskResult>(
      '/browser-task',
      { task, model, provider, planner_model: plannerModel, run_id: runId },
      BROWSER_TASK_TIMEOUT_MS,
      signal,
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        success: false,
        error: `Browser service returned HTTP ${response.statusCode}: ${response.rawBody.slice(0, 200)}`,
      };
    }

    const data = response.data;
    if (!data) {
      console.error('[BrowserService] Non-JSON response from browser service:', response.rawBody.slice(0, 500));
      return {
        success: false,
        error: `Browser service returned non-JSON response. Body: ${response.rawBody.slice(0, 200)}`,
      };
    }

    console.log('[BrowserService] Browser task response:', {
      success: data.success,
      steps: data.steps,
      resultLength: data.result?.length,
      error: data.error?.slice(0, 300),
    });

    return {
      success: data.success ?? false,
      result: data.result,
      error: data.error,
      steps: data.steps,
    };
  } catch (error) {
    console.error('[BrowserService] Error running browser task:', error);
    if (error instanceof BrowserTaskTimeoutError) {
      await cancelBrowserTask();
      return {
        success: false,
        error: 'Browser task timed out and was cancelled.',
      };
    }
    if (error instanceof BrowserTaskAbortError) {
      await cancelBrowserTask();
      return {
        success: false,
        error: 'Browser task was cancelled.',
      };
    }
    return {
      success: false,
      error: error instanceof DOMException && error.name === 'AbortError'
        ? 'Browser task was cancelled.'
        : error instanceof Error
          ? error.message
          : 'Unknown error',
    };
  } finally {
    if (activeTraceCallback === activeForThisRun) {
      activeTraceCallback = previousTraceCallback;
    }
    scheduleBrowserServiceIdleStop();
  }
}
