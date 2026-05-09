import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';

const BROWSER_SERVICE_PORT = 8001;
const BROWSER_SERVICE_HOST = '127.0.0.1';
const BROWSER_TASK_TIMEOUT_MS = 300_000;
const HEALTH_CHECK_TIMEOUT_MS = 3000;

let browserProcess: ChildProcess | null = null;
let restartInProgress = false;

export interface BrowserTaskResult {
  success: boolean;
  result?: string;
  error?: string;
  steps?: number;
}

function getBrowserServicePath(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    return path.join(__dirname, '../../browser-service');
  }

  return path.join(process.resourcesPath, 'browser-service');
}

function getPythonExecutable(): string {
  const venvPath = path.join(getBrowserServicePath(), 'venv');
  if (fs.existsSync(venvPath)) {
    if (process.platform === 'win32') {
      return path.join(venvPath, 'Scripts', 'python.exe');
    }
    return path.join(venvPath, 'bin', 'python');
  }

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    console.warn('[BrowserService] No local virtualenv found, falling back to system Python');
    if (process.platform === 'win32') {
      return 'python';
    }
    return 'python3';
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

function spawnBrowserProcess(): ChildProcess {
  const serviceDir = getBrowserServicePath();
  const pythonExe = getPythonExecutable();

  const proc = spawn(
    pythonExe,
    ['-m', 'uvicorn', 'main:app', '--host', BROWSER_SERVICE_HOST, '--port', String(BROWSER_SERVICE_PORT)],
    {
      cwd: serviceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }
  );

  proc.stdout?.on('data', (data) => {
    console.log(`[BrowserService] ${data.toString().trim()}`);
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
    console.log(`[BrowserService] Process exited with code ${code}, signal ${signal}`);
    if (browserProcess === proc) {
      browserProcess = null;
    }
  });

  return proc;
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

  console.log(`[BrowserService] Starting browser service from ${serviceDir}`);

  browserProcess = spawnBrowserProcess();
  const ready = await waitForService();

  return ready;
}

export async function stopBrowserService(): Promise<void> {
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

export async function runBrowserTask(task: string, model: string, provider: string, signal?: AbortSignal, plannerModel?: string): Promise<BrowserTaskResult> {
  const url = `http://${BROWSER_SERVICE_HOST}:${BROWSER_SERVICE_PORT}/browser-task`;
  const cancelUrl = `http://${BROWSER_SERVICE_HOST}:${BROWSER_SERVICE_PORT}/cancel-browser-task`;

  const running = await ensureServiceRunning();
  if (!running) {
    return {
      success: false,
      error: 'Browser automation service is not running and could not be restarted.',
    };
  }

  if (signal) {
    const onAbort = async () => {
      try {
        await fetch(cancelUrl, { method: 'POST', signal: AbortSignal.timeout(5000) });
        console.log('[BrowserService] Cancelled browser task via API');
      } catch (e) {
        console.error('[BrowserService] Failed to cancel browser task:', e);
      }
    };

    if (signal.aborted) {
      await onAbort();
      return { success: false, error: 'Browser task was cancelled.' };
    }

    signal.addEventListener('abort', () => { void onAbort(); }, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ task, model, provider, planner_model: plannerModel }),
      signal: signal ?? AbortSignal.timeout(BROWSER_TASK_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        error: `Browser service returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }

    const data = await safeParseJSON<BrowserTaskResult>(response);
    if (!data) {
      const rawBody = await response.text().catch(() => '');
      console.error('[BrowserService] Non-JSON response from browser service:', rawBody.slice(0, 500));
      return {
        success: false,
        error: `Browser service returned non-JSON response. Body: ${rawBody.slice(0, 200)}`,
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
    return {
      success: false,
      error: error instanceof DOMException && error.name === 'AbortError'
        ? 'Browser task was cancelled.'
        : error instanceof Error
          ? error.message
          : 'Unknown error',
    };
  }
}