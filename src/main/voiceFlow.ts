import { ipcMain, BrowserWindow } from 'electron';
import { startRecording, stopRecording, requestMicrophoneAccess, cleanupAudioCapture } from './audioRecorder';
import { getVoiceShortcutLabel, setupGlobalHotkey, setupLocalHotkey, teardownGlobalHotkey } from './hotkeyManager';
import { processVoiceFlow } from './pythonService';
import { typeTextInActiveApp, getFrontmostApp, activateApp, type FrontmostApp } from './textInserter';
import { showOverlay, hideOverlay, destroyOverlay } from './overlayWindow';

type VoiceFlowState = 'idle' | 'recording' | 'processing';
type VoiceTranscriptPayload = {
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
};

let voiceFlowState: VoiceFlowState = 'idle';

export type VoiceFlowResult = {
  text: string;
  raw_text?: string;
  success: boolean;
  error?: string;
};

function sendStateToRenderer(state: VoiceFlowState): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('voice-flow-state', state);
  });
}

function sendTranscriptToRenderer(payload: VoiceTranscriptPayload): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('voice-transcript', payload);
  });
}

function sendErrorToRenderer(error: string): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('voice-error', error);
  });
}

let preRecordingApp: FrontmostApp | null = null;
let preRecordingProjectFocused = false;

function isProjectWindowFocused(): boolean {
  return BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isFocused());
}

function isProjectApp(targetApp: FrontmostApp | null): boolean {
  return targetApp?.pid === process.pid;
}

function shouldRouteToProjectAppOnly(text: string): boolean {
  return /^jarvis\b/i.test(text.trimStart());
}

async function resolveTargetApp(): Promise<FrontmostApp | null> {
  if (preRecordingApp) {
    return preRecordingApp;
  }

  try {
    const currentFrontmostApp = await getFrontmostApp();
    console.log('[VoiceFlow] Fallback frontmost app:', currentFrontmostApp);
    return currentFrontmostApp;
  } catch (err) {
    console.warn('[VoiceFlow] Could not resolve target app for transcript routing:', err);
    return null;
  }
}

async function capturePreRecordingApp(): Promise<void> {
  preRecordingProjectFocused = isProjectWindowFocused();
  if (preRecordingProjectFocused) {
    preRecordingApp = null;
    console.log('[VoiceFlow] Pre-recording target: project window');
    return;
  }

  try {
    preRecordingApp = await getFrontmostApp();
    console.log('[VoiceFlow] Pre-recording app:', preRecordingApp);
  } catch (err) {
    console.log('[VoiceFlow] Could not get frontmost app:', err);
    preRecordingApp = null;
  }
}

async function handleVoiceShortcut(): Promise<void> {
  console.log('[VoiceFlow] handleVoiceShortcut state:', voiceFlowState);

  if (voiceFlowState === 'idle') {
    await capturePreRecordingApp();
    await startVoiceRecording();
  } else if (voiceFlowState === 'recording') {
    await stopAndProcess();
  } else {
    console.log('[VoiceFlow] Voice shortcut ignored while processing');
  }
}

async function startVoiceRecording(): Promise<void> {
  if (voiceFlowState !== 'idle') {
    return;
  }

  voiceFlowState = 'recording';
  sendStateToRenderer('recording');
  showOverlay('recording');

  const result = await startRecording();

  if (!result.success) {
    voiceFlowState = 'idle';
    sendStateToRenderer('idle');
    sendErrorToRenderer(result.error || 'Failed to start recording');
    showOverlay('error', undefined, result.error || 'Failed to start recording');
    setTimeout(() => {
      hideOverlay();
    }, 2000);
  }
}

async function stopAndProcess(): Promise<void> {
  if (voiceFlowState !== 'recording') {
    return;
  }

  voiceFlowState = 'processing';
  sendStateToRenderer('processing');
  showOverlay('processing');

  try {
    const audioBuffer = await stopRecording();
    if (audioBuffer.durationMs < 250 || audioBuffer.peak < 0.001) {
      const errorMessage = `Microphone captured silence (${Math.round(audioBuffer.durationMs)}ms, peak ${audioBuffer.peak.toFixed(4)})`;
      showOverlay('error', undefined, errorMessage);
      sendErrorToRenderer(errorMessage);
      return;
    }

    const result = await processVoiceFlow(audioBuffer);

    if (result.success && result.text) {
      showOverlay('complete', result.text);
      await new Promise(resolve => setTimeout(resolve, 300));
      const targetApp = preRecordingProjectFocused ? null : await resolveTargetApp();
      const targetIsProjectApp = preRecordingProjectFocused || isProjectApp(targetApp);
      const routeToProjectAppOnly = shouldRouteToProjectAppOnly(result.text);
      const sendToProjectApp = targetIsProjectApp || routeToProjectAppOnly;
      const sendToExternalApp = !targetIsProjectApp && !routeToProjectAppOnly;

      console.log('[VoiceFlow] Transcript routing:', {
        targetApp,
        preRecordingProjectFocused,
        targetIsProjectApp,
        routeToProjectAppOnly,
        sendToProjectApp,
        sendToExternalApp,
      });

      if (sendToProjectApp) {
        const projectWin = BrowserWindow.getAllWindows().find(win => !win.isDestroyed());
        if (projectWin) {
          if (projectWin.isMinimized()) projectWin.restore();
          projectWin.show();
          projectWin.focus();
        }
        sendTranscriptToRenderer({
          text: result.text,
          autoSubmit: routeToProjectAppOnly,
          newChat: routeToProjectAppOnly,
        });
      }

      if (sendToExternalApp) {
        const targetBundleId = targetApp?.bundleId?.trim();
        if (targetBundleId) {
          try {
            await activateApp(targetBundleId);
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (err) {
            console.warn('[VoiceFlow] Could not activate pre-recording app before paste:', err);
          }
        }

        await typeTextInActiveApp(result.text);
      }
    } else if (!result.success && result.error) {
      showOverlay('error', undefined, result.error);
      sendErrorToRenderer(result.error);
    } else {
      showOverlay('error', undefined, 'No speech detected');
      sendErrorToRenderer('No speech detected');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during processing';
    showOverlay('error', undefined, errorMessage);
    sendErrorToRenderer(errorMessage);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 800));
    hideOverlay();
    preRecordingApp = null;
    preRecordingProjectFocused = false;
    voiceFlowState = 'idle';
    sendStateToRenderer('idle');
  }
}

export async function initializeVoiceFlow(): Promise<void> {
  const registered = setupGlobalHotkey(handleVoiceShortcut);
  if (registered) {
    console.log(`[VoiceFlow] Global voice shortcut registered successfully (${getVoiceShortcutLabel()})`);
  } else {
    console.warn(
      `[VoiceFlow] Global voice shortcut registration failed, falling back to local mode (${getVoiceShortcutLabel()} only works while the app is focused)`
    );

    const localRegistered = setupLocalHotkey(handleVoiceShortcut);
    if (!localRegistered) {
      console.error('[VoiceFlow] Failed to register any voice shortcut');
    }
  }

  await requestMicrophoneAccess();
}

export async function startVoiceRecordingFromUI(): Promise<{ success: boolean; error?: string }> {
  if (voiceFlowState !== 'idle') {
    return { success: false, error: `Already ${voiceFlowState}` };
  }

  await capturePreRecordingApp();

  await startVoiceRecording();

  const currentState = getVoiceFlowState();
  return { success: currentState === 'recording' || currentState === 'processing' };
}

export async function stopVoiceRecordingFromUI(): Promise<{ success: boolean; error?: string }> {
  if (voiceFlowState !== 'recording') {
    return { success: false, error: 'Not recording' };
  }

  await stopAndProcess();

  return { success: true };
}

export function getVoiceFlowState(): VoiceFlowState {
  return voiceFlowState;
}

export function registerVoiceFlowIPC(): void {
  ipcMain.handle('start-voice-recording', async () => {
    return startVoiceRecordingFromUI();
  });

  ipcMain.handle('stop-voice-recording', async () => {
    return stopVoiceRecordingFromUI();
  });

  ipcMain.handle('voice-recording-state', async () => {
    return voiceFlowState;
  });

  ipcMain.handle('voice-shortcut-label', async () => {
    return getVoiceShortcutLabel();
  });
}

export async function cleanupVoiceFlow(): Promise<void> {
  teardownGlobalHotkey();
  destroyOverlay();
  await cleanupAudioCapture();
  voiceFlowState = 'idle';
}
