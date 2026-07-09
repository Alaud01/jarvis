import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { LocalVoiceModelInstallResult, LocalVoiceModelStatus } from '../shared/voiceSetup';

const LOCAL_MODEL_NAME = 'nvidia/parakeet-tdt_ctc-110m';
const ESTIMATED_DOWNLOAD_SIZE = 'Several GB for PyTorch/NeMo plus Parakeet model cache';
const INSTALL_LOG_LIMIT = 40;

let installPromise: Promise<LocalVoiceModelInstallResult> | null = null;
let lastStep = '';
let lastError = '';
let logs: string[] = [];

function appendLog(message: string): void {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  logs = [...logs, trimmed].slice(-INSTALL_LOG_LIMIT);
}

export function getManagedVoiceServiceDir(): string {
  return path.join(app.getPath('appData'), 'Jarvis', 'python-service');
}

function getManagedVoiceVenvDir(): string {
  return path.join(getManagedVoiceServiceDir(), 'venv');
}

export function getManagedVoicePythonExecutable(): string {
  const venvDir = getManagedVoiceVenvDir();
  if (process.platform === 'win32') {
    return path.join(venvDir, 'Scripts', 'python.exe');
  }
  return path.join(venvDir, 'bin', 'python');
}

function getModelReadyMarkerPath(): string {
  return path.join(getManagedVoiceServiceDir(), 'parakeet-model-ready.json');
}

export function getManagedVoiceRuntimeEnv(): NodeJS.ProcessEnv {
  const serviceDir = getManagedVoiceServiceDir();
  return {
    VOICE_PYTHON_CACHE_DIR: path.join(serviceDir, 'cache', 'python'),
    HF_HOME: path.join(serviceDir, 'cache', 'huggingface'),
    TORCH_HOME: path.join(serviceDir, 'cache', 'torch'),
    NEMO_HOME: path.join(serviceDir, 'cache', 'nemo'),
  };
}

export function getReadyManagedVoicePythonExecutable(): string | null {
  const pythonExecutable = getManagedVoicePythonExecutable();
  if (!fs.existsSync(pythonExecutable) || !fs.existsSync(getModelReadyMarkerPath())) {
    return null;
  }
  return pythonExecutable;
}

function getSourcePythonServiceDir(): string {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '../../python-service');
  }
  return path.join(process.resourcesPath, 'python-service');
}

function getSystemPythonExecutable(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; step: string },
): Promise<void> {
  lastStep = options.step;
  appendLog(options.step);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data) => appendLog(data.toString()));
    child.stderr?.on('data', (data) => appendLog(data.toString()));

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${options.step} failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function commandSucceeds(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = 15000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function dependenciesInstalled(): Promise<boolean> {
  const pythonExecutable = getManagedVoicePythonExecutable();
  if (!fs.existsSync(pythonExecutable)) {
    return false;
  }

  if (fs.existsSync(getModelReadyMarkerPath())) {
    return true;
  }

  return commandSucceeds(
    pythonExecutable,
    ['-c', 'import torch; from nemo.collections.asr.models import ASRModel'],
    getManagedVoiceRuntimeEnv(),
    60000,
  );
}

async function buildLocalVoiceModelStatus(installInProgress = installPromise !== null): Promise<LocalVoiceModelStatus> {
  const managedServiceDir = getManagedVoiceServiceDir();
  const pythonExecutable = fs.existsSync(getManagedVoicePythonExecutable())
    ? getManagedVoicePythonExecutable()
    : null;
  const depsInstalled = await dependenciesInstalled();
  const modelReady = fs.existsSync(getModelReadyMarkerPath());
  const openRouterFallbackConfigured = Boolean(
    process.env.OPENROUTER_API_KEY?.trim(),
  );

  return {
    status: installInProgress
      ? 'installing'
      : modelReady && depsInstalled
        ? 'ready'
        : lastError
          ? 'failed'
          : 'missing',
    dependenciesInstalled: depsInstalled,
    modelReady,
    installInProgress,
    managedServiceDir,
    pythonExecutable,
    modelName: LOCAL_MODEL_NAME,
    estimatedDownloadSize: ESTIMATED_DOWNLOAD_SIZE,
    openRouterFallbackConfigured,
    lastStep: lastStep || undefined,
    lastError: lastError || undefined,
    logs,
  };
}

export async function getLocalVoiceModelStatus(): Promise<LocalVoiceModelStatus> {
  return buildLocalVoiceModelStatus();
}

async function writeModelReadyMarker(): Promise<void> {
  const marker = {
    modelName: LOCAL_MODEL_NAME,
    installedAt: new Date().toISOString(),
  };
  await fsp.writeFile(getModelReadyMarkerPath(), JSON.stringify(marker, null, 2));
}

async function installLocalVoiceModelInternal(): Promise<LocalVoiceModelInstallResult> {
  lastError = '';
  logs = [];

  const managedServiceDir = getManagedVoiceServiceDir();
  const sourceServiceDir = getSourcePythonServiceDir();
  const baseRequirementsPath = path.join(sourceServiceDir, 'requirements.txt');
  const localRequirementsPath = path.join(sourceServiceDir, 'requirements-local-parakeet.txt');
  const pythonExecutable = getManagedVoicePythonExecutable();

  try {
    await fsp.mkdir(managedServiceDir, { recursive: true });
    await fsp.mkdir(path.join(managedServiceDir, 'cache'), { recursive: true });

    if (!fs.existsSync(pythonExecutable)) {
      await runCommand(getSystemPythonExecutable(), ['-m', 'venv', getManagedVoiceVenvDir()], {
        step: 'Creating managed voice virtual environment',
      });
    }

    await runCommand(pythonExecutable, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
      env: getManagedVoiceRuntimeEnv(),
      step: 'Updating pip in managed voice runtime',
    });

    await runCommand(pythonExecutable, ['-m', 'pip', 'install', '-r', baseRequirementsPath], {
      env: getManagedVoiceRuntimeEnv(),
      step: 'Installing voice service dependencies',
    });

    await runCommand(pythonExecutable, ['-m', 'pip', 'install', '-r', localRequirementsPath], {
      env: getManagedVoiceRuntimeEnv(),
      step: 'Installing local Parakeet dependencies',
    });

    await runCommand(
      pythonExecutable,
      [
        '-c',
        [
          'from nemo.collections.asr.models import ASRModel',
          `model = ASRModel.from_pretrained(model_name="${LOCAL_MODEL_NAME}")`,
          'model.eval()',
        ].join('; '),
      ],
      {
        env: getManagedVoiceRuntimeEnv(),
        step: 'Downloading and verifying local Parakeet model',
      },
    );

    await writeModelReadyMarker();
    lastStep = 'Local voice model is ready';
    appendLog(lastStep);

    return {
      success: true,
      status: await buildLocalVoiceModelStatus(false),
    };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    appendLog(lastError);
    return {
      success: false,
      error: lastError,
      status: await buildLocalVoiceModelStatus(false),
    };
  }
}

export async function installLocalVoiceModel(): Promise<LocalVoiceModelInstallResult> {
  if (!installPromise) {
    installPromise = installLocalVoiceModelInternal()
      .finally(() => {
        installPromise = null;
      });
  }

  return installPromise;
}
