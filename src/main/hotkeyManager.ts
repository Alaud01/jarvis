import { BrowserWindow, globalShortcut, type Input } from 'electron';
import { debugLog, infoLog } from './logger';

type HotkeyCallback = () => void;
type LocalHotkeyListener = (event: { preventDefault: () => void }, input: Input) => void;

const VOICE_SHORTCUT_ACCELERATOR = 'CommandOrControl+Shift+Space';
const VOICE_SHORTCUT_LABEL = process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space';

let hotkeyCallback: HotkeyCallback | null = null;
let localHotkeyWindow: BrowserWindow | null = null;
let localHotkeyListener: LocalHotkeyListener | null = null;

function matchesVoiceShortcut(input: Input): boolean {
  const key = input.key.toLowerCase();
  const primaryModifierPressed = process.platform === 'darwin' ? input.meta : input.control;

  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (key === 'space' || key === ' ') &&
    primaryModifierPressed &&
    input.shift &&
    !input.alt
  );
}

function triggerHotkey(source: 'global' | 'local'): void {
  if (!hotkeyCallback) {
    console.warn('[HotkeyManager] Voice shortcut fired without a callback');
    return;
  }

  debugLog(`[HotkeyManager] Voice shortcut triggered via ${source}`);
  hotkeyCallback();
}

function teardownLocalHotkey(): void {
  if (localHotkeyWindow && localHotkeyListener) {
    localHotkeyWindow.webContents.off('before-input-event', localHotkeyListener);
  }

  localHotkeyWindow = null;
  localHotkeyListener = null;
}

export function getVoiceShortcutLabel(): string {
  return VOICE_SHORTCUT_LABEL;
}

export function setupGlobalHotkey(callback: HotkeyCallback): boolean {
  hotkeyCallback = callback;

  if (globalShortcut.isRegistered(VOICE_SHORTCUT_ACCELERATOR)) {
    globalShortcut.unregister(VOICE_SHORTCUT_ACCELERATOR);
  }

  const registered = globalShortcut.register(VOICE_SHORTCUT_ACCELERATOR, () => {
    triggerHotkey('global');
  });

  if (!registered) {
    console.warn(`[HotkeyManager] Failed to register global shortcut ${VOICE_SHORTCUT_LABEL}`);
    return false;
  }

  infoLog(`[HotkeyManager] Global voice shortcut registered: ${VOICE_SHORTCUT_LABEL}`);
  return true;
}

export function setupLocalHotkey(callback: HotkeyCallback): boolean {
  hotkeyCallback = callback;
  teardownLocalHotkey();

  const mainWindow = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  if (!mainWindow) {
    console.warn('[HotkeyManager] No window available for local shortcut fallback');
    return false;
  }

  localHotkeyWindow = mainWindow;
  localHotkeyListener = (event, input) => {
    if (!matchesVoiceShortcut(input)) {
      return;
    }

    event.preventDefault();
    triggerHotkey('local');
  };

  mainWindow.webContents.on('before-input-event', localHotkeyListener);
  infoLog(`[HotkeyManager] Local voice shortcut registered: ${VOICE_SHORTCUT_LABEL}`);
  return true;
}

export function teardownGlobalHotkey(): void {
  if (globalShortcut.isRegistered(VOICE_SHORTCUT_ACCELERATOR)) {
    globalShortcut.unregister(VOICE_SHORTCUT_ACCELERATOR);
  }

  teardownLocalHotkey();
  hotkeyCallback = null;
}

export function getHotkeyStatus(): { hasAccessibility: boolean; isRegistered: boolean; shortcut: string } {
  return {
    hasAccessibility: true,
    isRegistered: globalShortcut.isRegistered(VOICE_SHORTCUT_ACCELERATOR) || localHotkeyListener !== null,
    shortcut: VOICE_SHORTCUT_LABEL,
  };
}
