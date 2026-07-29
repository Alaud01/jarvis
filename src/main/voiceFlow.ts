import { randomUUID } from 'node:crypto';
import { ipcMain, BrowserWindow } from 'electron';
import { startRecording, stopRecording, requestMicrophoneAccess, cleanupAudioCapture } from './audioRecorder';
import { getVoiceShortcutLabel, setupGlobalHotkey, setupLocalHotkey, teardownGlobalHotkey } from './hotkeyManager';
import { processVoiceFlow } from './pythonService';
import { typeTextInActiveApp, getFrontmostApp, activateApp, type FrontmostApp } from './textInserter';
import { showOverlay, hideOverlay, destroyOverlay, preloadOverlay, setOverlayAnchorBounds } from './overlayWindow';
import { captureVoiceContext } from './voiceContext';
import { EMPTY_VOICE_CONTEXT, type VoiceContext } from '../shared/voice';
import { cancelCorrectionObservation, observePostInsertionCorrection } from './correctionObserver';
import { debugLog, infoLog } from './logger';

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
let preRecordingContext: VoiceContext = EMPTY_VOICE_CONTEXT;
let preRecordingCapturePromise: Promise<void> = Promise.resolve();

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
    debugLog('[VoiceFlow] Fallback frontmost app:', currentFrontmostApp);
    return currentFrontmostApp;
  } catch (err) {
    console.warn('[VoiceFlow] Could not resolve target app for transcript routing:', err);
    return null;
  }
}

async function capturePreRecordingTarget(): Promise<void> {
  cancelCorrectionObservation();
  preRecordingProjectFocused = isProjectWindowFocused();
  if (preRecordingProjectFocused) {
    preRecordingApp = null;
    setOverlayAnchorBounds(null);
    debugLog('[VoiceFlow] Pre-recording target: project window');
    return;
  }

  try {
    preRecordingApp = await getFrontmostApp();
    setOverlayAnchorBounds(preRecordingApp.windowBounds);
    debugLog('[VoiceFlow] Pre-recording app:', preRecordingApp);
  } catch (err) {
    debugLog('[VoiceFlow] Could not get frontmost app:', err);
    preRecordingApp = null;
    setOverlayAnchorBounds(null);
  }
}

async function capturePreRecordingContext(): Promise<void> {
  if (preRecordingProjectFocused) {
    preRecordingContext = await captureVoiceContext(null, true);
    return;
  }

  preRecordingContext = await captureVoiceContext(preRecordingApp);
  debugLog('[VoiceFlow] Voice context captured:', {
    app: preRecordingContext.app,
    destination: preRecordingContext.destination,
    accessibilityStatus: preRecordingContext.accessibilityStatus,
    fieldRole: preRecordingContext.field?.role ?? null,
    fieldSubrole: preRecordingContext.field?.subrole ?? null,
  });
}

function beginPreRecordingCapture(): void {
  preRecordingCapturePromise = capturePreRecordingContext();
}

async function handleVoiceShortcut(): Promise<void> {
  debugLog('[VoiceFlow] handleVoiceShortcut state:', voiceFlowState);

  if (voiceFlowState === 'idle') {
    await startVoiceRecording();
  } else if (voiceFlowState === 'recording') {
    await stopAndProcess();
  } else {
    debugLog('[VoiceFlow] Voice shortcut ignored while processing');
  }
}

async function startVoiceRecording(): Promise<void> {
  if (voiceFlowState !== 'idle') {
    return;
  }

  voiceFlowState = 'recording';
  sendStateToRenderer('recording');
  await capturePreRecordingTarget();
  showOverlay('recording');
  beginPreRecordingCapture();

  const result = await startRecording();

  if (!result.success) {
    preRecordingApp = null;
    preRecordingProjectFocused = false;
    preRecordingContext = EMPTY_VOICE_CONTEXT;
    voiceFlowState = 'idle';
    sendStateToRenderer('idle');
    sendErrorToRenderer(result.error || 'Failed to start recording');
    showOverlay('error', undefined, result.error || 'Failed to start recording');
    setTimeout(() => {
      hideOverlay();
      setOverlayAnchorBounds(null);
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
  const flowStartedAt = performance.now();
  const timings: Record<string, number> = {};

  try {
    let stepStartedAt = performance.now();
    await preRecordingCapturePromise;
    timings.contextCaptureMs = Math.round(performance.now() - stepStartedAt);

    stepStartedAt = performance.now();
    const audioBuffer = await stopRecording();
    timings.stopRecordingMs = Math.round(performance.now() - stepStartedAt);
    if (audioBuffer.durationMs < 250 || audioBuffer.peak < 0.001) {
      const errorMessage = `Microphone captured silence (${Math.round(audioBuffer.durationMs)}ms, peak ${audioBuffer.peak.toFixed(4)})`;
      console.warn('[VoiceFlow] Microphone capture rejected as silence:', {
        durationMs: Math.round(audioBuffer.durationMs),
        byteLength: audioBuffer.byteLength,
        peak: Number(audioBuffer.peak.toFixed(4)),
        rms: Number(audioBuffer.rms.toFixed(4)),
        timings,
      });
      showOverlay('error', undefined, errorMessage);
      sendErrorToRenderer(errorMessage);
      return;
    }

    stepStartedAt = performance.now();
    const result = await processVoiceFlow(audioBuffer, preRecordingContext);
    timings.processVoiceFlowMs = Math.round(performance.now() - stepStartedAt);
    const dictationId = randomUUID();

    if (result.success && result.text) {
      console.warn('[VoiceFlow] Temporary transcription log:', {
        raw: result.raw_text ?? '',
        refined: result.text,
        refinementMode: result.refinement_mode,
        appliedEdits: result.applied_edits,
      });

      showOverlay('complete', result.text);
      stepStartedAt = performance.now();
      await new Promise(resolve => setTimeout(resolve, 300));
      timings.completeOverlayDelayMs = Math.round(performance.now() - stepStartedAt);

      stepStartedAt = performance.now();
      const targetApp = preRecordingProjectFocused ? null : await resolveTargetApp();
      timings.resolveTargetAppMs = Math.round(performance.now() - stepStartedAt);
      const targetIsProjectApp = preRecordingProjectFocused || isProjectApp(targetApp);
      const routeToProjectAppOnly = shouldRouteToProjectAppOnly(result.text);
      const sendToProjectApp = targetIsProjectApp || routeToProjectAppOnly;
      const sendToExternalApp = !targetIsProjectApp && !routeToProjectAppOnly;

      debugLog('[VoiceFlow] Transcript routing:', {
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
            stepStartedAt = performance.now();
            await activateApp(targetBundleId);
            await new Promise(resolve => setTimeout(resolve, 100));
            timings.activateAppMs = Math.round(performance.now() - stepStartedAt);
          } catch (err) {
            console.warn('[VoiceFlow] Could not activate pre-recording app before paste:', err);
          }
        }

        stepStartedAt = performance.now();
        await typeTextInActiveApp(result.text);
        timings.typeTextMs = Math.round(performance.now() - stepStartedAt);
        if (targetApp) {
          void observePostInsertionCorrection(targetApp, result.text, {
            dictationId,
            appliedRules: result.applied_rules,
            transcriptionMetadata: result.transcription_metadata,
          });
        }
      }
    } else if (!result.success && result.error) {
      console.warn('[VoiceFlow] Voice processing failed:', {
        error: result.error,
        capture: {
          durationMs: Math.round(audioBuffer.durationMs),
          byteLength: audioBuffer.byteLength,
          peak: Number(audioBuffer.peak.toFixed(4)),
          rms: Number(audioBuffer.rms.toFixed(4)),
        },
        speechDurationMs: result.speech_duration_ms,
        transcriptionMetadata: result.transcription_metadata,
        diagnostics: result.diagnostics,
      });
      showOverlay('error', undefined, result.error);
      sendErrorToRenderer(result.error);
    } else {
      console.warn('[VoiceFlow] Voice processing failed without a specific error:', {
        capture: {
          durationMs: Math.round(audioBuffer.durationMs),
          byteLength: audioBuffer.byteLength,
          peak: Number(audioBuffer.peak.toFixed(4)),
          rms: Number(audioBuffer.rms.toFixed(4)),
        },
        result,
      });
      showOverlay('error', undefined, 'No speech detected');
      sendErrorToRenderer('No speech detected');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error during processing';
    showOverlay('error', undefined, errorMessage);
    sendErrorToRenderer(errorMessage);
  } finally {
    timings.totalBeforeHideMs = Math.round(performance.now() - flowStartedAt);
    console.warn('[VoiceFlow] stopAndProcess timing breakdown:', timings);
    await new Promise(resolve => setTimeout(resolve, 800));
    hideOverlay();
    preRecordingApp = null;
    preRecordingProjectFocused = false;
    preRecordingContext = EMPTY_VOICE_CONTEXT;
    setOverlayAnchorBounds(null);
    voiceFlowState = 'idle';
    sendStateToRenderer('idle');
  }
}

export async function initializeVoiceFlow(): Promise<void> {
  const registered = setupGlobalHotkey(handleVoiceShortcut);
  if (registered) {
    infoLog(`[VoiceFlow] Global voice shortcut registered successfully (${getVoiceShortcutLabel()})`);
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
  preloadOverlay();
}

export async function startVoiceRecordingFromUI(): Promise<{ success: boolean; error?: string }> {
  if (voiceFlowState !== 'idle') {
    return { success: false, error: `Already ${voiceFlowState}` };
  }

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
