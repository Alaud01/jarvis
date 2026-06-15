import { execFile } from 'child_process';
import { systemPreferences } from 'electron';
import type { VoiceContext, VoiceDestinationKind } from '../shared/voice';
import type { FrontmostApp } from './textInserter';
import { getActiveDictionaryVoiceEntries } from './dictionaryService';

const TEXT_BEFORE_LIMIT = 1000;
const TEXT_AFTER_LIMIT = 500;
let accessibilityPromptedThisSession = false;

export type FocusedFieldSnapshot = {
  role?: unknown;
  subrole?: unknown;
  textBeforeCursor?: unknown;
  selectedText?: unknown;
  textAfterCursor?: unknown;
  secure?: unknown;
  value?: unknown;
  selectionLocation?: unknown;
  selectionLength?: unknown;
  identifier?: unknown;
};

const CHAT_APP_IDS = ['slack', 'discord', 'messages', 'whatsapp', 'telegram', 'teams', 'signal'];
const EMAIL_APP_IDS = ['mail', 'outlook', 'spark', 'airmail'];
const DOCUMENT_APP_IDS = ['notion', 'word', 'pages', 'obsidian', 'bear', 'notes', 'docs'];
const CODE_APP_IDS = ['xcode', 'visual-studio-code', 'vscode', 'cursor', 'zed', 'sublime', 'jetbrains'];
const TERMINAL_APP_IDS = ['terminal', 'iterm', 'warp', 'alacritty', 'kitty'];

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some(candidate => value.includes(candidate));
}

export function classifyVoiceDestination(app: FrontmostApp | null, projectFocused = false): VoiceDestinationKind {
  if (projectFocused) return 'jarvis';
  const identity = `${app?.name ?? ''} ${app?.bundleId ?? ''}`.toLowerCase();
  if (includesAny(identity, TERMINAL_APP_IDS)) return 'terminal';
  if (includesAny(identity, CODE_APP_IDS)) return 'code';
  if (includesAny(identity, CHAT_APP_IDS)) return 'chat';
  if (includesAny(identity, EMAIL_APP_IDS)) return 'email';
  if (includesAny(identity, DOCUMENT_APP_IDS)) return 'document';
  return 'generic';
}

function appContext(app: FrontmostApp | null): VoiceContext['app'] {
  if (!app) return null;
  return { name: app.name, bundleId: app.bundleId, pid: app.pid };
}

function runJxa(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function captureFocusedField(pid: number, includeValue = false): Promise<FocusedFieldSnapshot> {
  const script = `
function run(argv) {
  const pid = Number(argv[0]);
  const systemEvents = Application('System Events');
  const matchingProcesses = systemEvents.applicationProcesses.whose({ unixId: pid });
  const targetProcess = matchingProcesses.length > 0 ? matchingProcesses[0] : null;
  if (!targetProcess) return JSON.stringify({});

  function attribute(element, name) {
    try {
      return element.attributes.byName(name).value();
    } catch (_) {
      return null;
    }
  }

  const focused = attribute(targetProcess, 'AXFocusedUIElement');
  if (!focused) return JSON.stringify({});

  const role = attribute(focused, 'AXRole');
  const subrole = attribute(focused, 'AXSubrole');
  const identifier = attribute(focused, 'AXIdentifier');
  const secure = role === 'AXSecureTextField' || subrole === 'AXSecureTextField';
  if (secure) {
    return JSON.stringify({ role, subrole, secure: true });
  }
  const range = attribute(focused, 'AXSelectedTextRange');
  const rangeValues = Array.isArray(range) ? range : [];
  const value = attribute(focused, 'AXValue');
  const text = typeof value === 'string' ? value : '';
  const selectedTextValue = attribute(focused, 'AXSelectedText');
  const selectedText = typeof selectedTextValue === 'string' ? selectedTextValue : '';
  const rawLocation = rangeValues.length > 0 ? Number(rangeValues[0]) : text.length;
  const rawLength = rangeValues.length > 1 ? Number(rangeValues[1]) : selectedText.length;
  const location = Number.isInteger(rawLocation) ? Math.max(0, Math.min(text.length, rawLocation)) : text.length;
  const length = Number.isInteger(rawLength) ? Math.max(0, rawLength) : selectedText.length;
  const afterSelection = Math.min(text.length, location + length);
  return JSON.stringify({
    role,
    subrole,
    textBeforeCursor: text.slice(Math.max(0, location - ${TEXT_BEFORE_LIMIT}), location),
    selectedText: selectedText.slice(0, ${TEXT_BEFORE_LIMIT + TEXT_AFTER_LIMIT}),
    textAfterCursor: text.slice(afterSelection, afterSelection + ${TEXT_AFTER_LIMIT}),
    secure: false,
    value: ${includeValue ? 'true' : 'false'} ? text.slice(0, 20000) : undefined,
    selectionLocation: location,
    selectionLength: length,
    identifier
  });
}`;
  const output = await runJxa(script, [String(pid)]);
  return output ? JSON.parse(output) as FocusedFieldSnapshot : {};
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export async function captureVoiceContext(
  app: FrontmostApp | null,
  projectFocused = false,
): Promise<VoiceContext> {
  const base: VoiceContext = {
    app: appContext(app),
    destination: classifyVoiceDestination(app, projectFocused),
    field: null,
    accessibilityStatus: projectFocused ? 'not_requested' : 'unavailable',
    dictionary: getActiveDictionaryVoiceEntries(),
  };

  if (projectFocused || process.platform !== 'darwin' || app?.pid == null) {
    return base;
  }

  let trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!trusted && !accessibilityPromptedThisSession) {
    accessibilityPromptedThisSession = true;
    trusted = systemPreferences.isTrustedAccessibilityClient(true);
  }
  if (!trusted) {
    return { ...base, accessibilityStatus: 'denied' };
  }

  try {
    const snapshot = await captureFocusedField(app.pid);
    if (snapshot.secure === true) {
      return { ...base, accessibilityStatus: 'secure_field' };
    }

    return {
      ...base,
      field: {
        role: toStringValue(snapshot.role) || null,
        subrole: toStringValue(snapshot.subrole) || null,
        textBeforeCursor: toStringValue(snapshot.textBeforeCursor).slice(-TEXT_BEFORE_LIMIT),
        selectedText: toStringValue(snapshot.selectedText).slice(0, TEXT_BEFORE_LIMIT + TEXT_AFTER_LIMIT),
        textAfterCursor: toStringValue(snapshot.textAfterCursor).slice(0, TEXT_AFTER_LIMIT),
      },
      accessibilityStatus: 'captured',
    };
  } catch (error) {
    console.warn('[VoiceContext] Focused field capture failed:', error instanceof Error ? error.message : error);
    return { ...base, accessibilityStatus: 'failed' };
  }
}
