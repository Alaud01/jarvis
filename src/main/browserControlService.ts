import { app, BrowserWindow, shell } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type BrowserTarget =
  | { kind: 'text'; text: string; exact?: boolean }
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'coordinates'; x: number; y: number };

export interface BrowserControlState {
  activeTabId: string;
  url: string;
  title: string;
  loading: boolean;
  tabs: Array<{
    id: string;
    url: string;
    title: string;
    active: boolean;
  }>;
  visibleTextPreview: string;
  screenshotArtifact?: {
    id: string;
    path: string;
    mimeType: 'image/png';
    createdAt: string;
    label: string;
  };
  lastAction?: {
    name: string;
    success: boolean;
    message?: string;
  };
  externalUrl?: string;
}

export interface BrowserControlResult {
  success: boolean;
  error?: string;
  state?: BrowserControlState;
}

interface BrowserControlOptions {
  signal?: AbortSignal;
  sessionId?: string;
}

interface ResolvedTarget {
  success: boolean;
  error?: string;
  x?: number;
  y?: number;
  description?: string;
}

interface DragOptions {
  durationMs: number;
  steps: number;
  holdMs: number;
}

const BROWSER_CONTROL_TAB_ID = 'main';
const STATE_TEXT_LIMIT = 4000;
const SCREENSHOT_DIR = 'browser-control-screenshots';
const DEFAULT_BROWSER_SESSION_ID = 'default';

const browserWindows = new Map<string, BrowserWindow>();

function getSessionId(sessionId?: string): string {
  return sessionId?.trim() || DEFAULT_BROWSER_SESSION_ID;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  }).finally(() => {
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort);
    }
  });
  throwIfAborted(signal);
}

function getBrowserWindow(sessionId?: string): BrowserWindow {
  const id = getSessionId(sessionId);
  const existingWindow = browserWindows.get(id);
  if (existingWindow && !existingWindow.isDestroyed()) {
    return existingWindow;
  }

  const browserWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: `Jarvis Browser Control - ${id.slice(0, 8)}`,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  browserWindow.on('closed', () => {
    browserWindows.delete(id);
  });

  browserWindow.maximize();
  browserWindows.set(id, browserWindow);
  return browserWindow;
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('browser_open requires a non-empty URL.');
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('file:')) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function truncateText(text: string, limit = STATE_TEXT_LIMIT): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function asSerializable(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function waitForLoadSettled(win: BrowserWindow, timeoutMs = 15000, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!win.webContents.isLoadingMainFrame()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      win.webContents.removeListener('did-stop-loading', finish);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = setTimeout(finish, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    win.webContents.once('did-stop-loading', finish);
  });
}

async function getVisibleTextPreview(win: BrowserWindow): Promise<string> {
  try {
    const text = await win.webContents.executeJavaScript(
      `(() => document.body ? document.body.innerText || '' : '')()`,
      true,
    );
    return truncateText(typeof text === 'string' ? text : '');
  } catch {
    return '';
  }
}

async function buildState(
  lastAction?: BrowserControlState['lastAction'],
  screenshotArtifact?: BrowserControlState['screenshotArtifact'],
  options: BrowserControlOptions = {},
): Promise<BrowserControlState> {
  throwIfAborted(options.signal);
  const win = getBrowserWindow(options.sessionId);
  const url = win.webContents.getURL();
  const title = win.webContents.getTitle();
  const loading = win.webContents.isLoading();
  const visibleTextPreview = await getVisibleTextPreview(win);

  return {
    activeTabId: BROWSER_CONTROL_TAB_ID,
    url,
    title,
    loading,
    tabs: [{
      id: BROWSER_CONTROL_TAB_ID,
      url,
      title,
      active: true,
    }],
    visibleTextPreview,
    screenshotArtifact,
    lastAction,
  };
}

function buildExternalState(
  url: string,
  lastAction: BrowserControlState['lastAction'],
): BrowserControlState {
  return {
    activeTabId: 'default-browser',
    url,
    title: 'Default browser',
    loading: false,
    tabs: [{
      id: 'default-browser',
      url,
      title: 'Default browser',
      active: true,
    }],
    visibleTextPreview: 'Opened in the user default browser. Jarvis does not inspect or control the user browser profile.',
    lastAction,
    externalUrl: url,
  };
}

function targetScript(target: BrowserTarget): string {
  return `
(() => {
  const target = ${JSON.stringify(target)};

  function visible(el) {
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0;
  }

  function center(el) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (!visible(el)) {
      return { success: false, error: 'Matched element could not be scrolled into view.' };
    }
    return {
      success: true,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      description: el.tagName.toLowerCase()
    };
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      return labelledBy
        .split(/\\s+/)
        .map(id => document.getElementById(id)?.innerText || '')
        .join(' ')
        .trim();
    }
    if (el.labels && el.labels.length) {
      return Array.from(el.labels).map(label => label.innerText || '').join(' ').trim();
    }
    return (el.innerText || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim();
  }

  const elements = Array.from(document.querySelectorAll('button, [role], a, input, textarea, select, [contenteditable="true"], [tabindex], label, summary, option'));

  if (target.kind === 'coordinates') {
    return { success: true, x: target.x, y: target.y, description: 'coordinates' };
  }

  if (target.kind === 'selector') {
    try {
      const el = document.querySelector(target.selector);
      if (!el) return { success: false, error: 'No element matched selector.' };
      return center(el);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Invalid selector.' };
    }
  }

  if (target.kind === 'role') {
    const role = String(target.role || '').toLowerCase();
    const name = String(target.name || '').toLowerCase();
    const match = elements.find(el => {
      const elRole = (el.getAttribute('role') || '').toLowerCase();
      const implicitRole = el.tagName.toLowerCase() === 'button'
        ? 'button'
        : el.tagName.toLowerCase() === 'a'
          ? 'link'
          : '';
      if (elRole !== role && implicitRole !== role) return false;
      if (!name) return true;
      return accessibleName(el).toLowerCase().includes(name);
    });
    if (!match) return { success: false, error: 'No visible element matched role target.' };
    return center(match);
  }

  if (target.kind === 'text') {
    const needle = String(target.text || '').trim().toLowerCase();
    const exact = Boolean(target.exact);
    if (!needle) return { success: false, error: 'Text target requires non-empty text.' };
    const match = elements.find(el => {
      const text = accessibleName(el).toLowerCase();
      return exact ? text === needle : text.includes(needle);
    });
    if (!match) return { success: false, error: 'No visible element matched text target.' };
    return center(match);
  }

  return { success: false, error: 'Unsupported target kind.' };
})()
`;
}

function validateTarget(value: unknown): BrowserTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser target must be an object.');
  }

  const target = value as Record<string, unknown>;
  const kind = target.kind;
  if (kind === 'text') {
    if (typeof target.text !== 'string' || !target.text.trim()) {
      throw new Error('Text target requires a non-empty text field.');
    }
    return { kind, text: target.text, exact: target.exact === true };
  }
  if (kind === 'role') {
    if (typeof target.role !== 'string' || !target.role.trim()) {
      throw new Error('Role target requires a non-empty role field.');
    }
    return { kind, role: target.role, name: typeof target.name === 'string' ? target.name : undefined };
  }
  if (kind === 'selector') {
    if (typeof target.selector !== 'string' || !target.selector.trim()) {
      throw new Error('Selector target requires a non-empty selector field.');
    }
    return { kind, selector: target.selector };
  }
  if (kind === 'coordinates') {
    if (typeof target.x !== 'number' || typeof target.y !== 'number') {
      throw new Error('Coordinate target requires numeric x and y fields.');
    }
    return { kind, x: target.x, y: target.y };
  }

  throw new Error('Unsupported browser target kind.');
}

function validateDragOptions(value: unknown): DragOptions {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
    ? Math.max(0, Math.min(raw.durationMs, 10000))
    : 700;
  const steps = typeof raw.steps === 'number' && Number.isFinite(raw.steps)
    ? Math.max(2, Math.min(Math.round(raw.steps), 80))
    : 18;
  const holdMs = typeof raw.holdMs === 'number' && Number.isFinite(raw.holdMs)
    ? Math.max(0, Math.min(raw.holdMs, 2000))
    : 150;

  return { durationMs, steps, holdMs };
}

async function resolveTarget(win: BrowserWindow, target: BrowserTarget): Promise<ResolvedTarget> {
  const result = await win.webContents.executeJavaScript(targetScript(target), true);
  if (!result || typeof result !== 'object') {
    return { success: false, error: 'Target resolution returned no result.' };
  }

  return result as ResolvedTarget;
}

async function clickAt(win: BrowserWindow, x: number, y: number): Promise<void> {
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await new Promise(resolve => setTimeout(resolve, 150));
}

async function dragAt(
  win: BrowserWindow,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  dragOptions: DragOptions,
  signal?: AbortSignal,
): Promise<void> {
  let isMouseDown = false;
  let currentX = fromX;
  let currentY = fromY;

  try {
    throwIfAborted(signal);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: fromX, y: fromY });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: fromX, y: fromY, button: 'left', clickCount: 1 });
    isMouseDown = true;
    await sleep(dragOptions.holdMs, signal);

    const intervalMs = dragOptions.durationMs / dragOptions.steps;
    for (let step = 1; step <= dragOptions.steps; step += 1) {
      throwIfAborted(signal);
      const progress = step / dragOptions.steps;
      currentX = Math.round(fromX + (toX - fromX) * progress);
      currentY = Math.round(fromY + (toY - fromY) * progress);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: currentX, y: currentY, button: 'left' });
      await sleep(intervalMs, signal);
    }

    win.webContents.sendInputEvent({ type: 'mouseUp', x: toX, y: toY, button: 'left', clickCount: 1 });
    isMouseDown = false;
    await sleep(150, signal);
  } catch (error) {
    if (isMouseDown && !win.isDestroyed()) {
      win.webContents.sendInputEvent({ type: 'mouseUp', x: currentX, y: currentY, button: 'left', clickCount: 1 });
    }
    throw error;
  }
}

export async function browserOpen(
  url: string,
  external = false,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  try {
    throwIfAborted(options.signal);
    const normalizedUrl = normalizeUrl(url);
    if (external) {
      await shell.openExternal(normalizedUrl);
      return {
        success: true,
        state: buildExternalState(normalizedUrl, {
          name: 'browser_open',
          success: true,
          message: `opened in default browser: ${normalizedUrl}`,
        }),
      };
    }

    const win = getBrowserWindow(options.sessionId);
    await withAbort(win.loadURL(normalizedUrl), options.signal);
    await waitForLoadSettled(win, 15000, options.signal);
    return {
      success: true,
      state: await buildState({ name: 'browser_open', success: true, message: normalizedUrl }, undefined, options),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to open browser URL.',
      state: await buildState({ name: 'browser_open', success: false }, undefined, options),
    };
  }
}

export async function browserCurrentState(options: BrowserControlOptions = {}): Promise<BrowserControlResult> {
  return {
    success: true,
    state: await buildState({ name: 'browser_current_state', success: true }, undefined, options),
  };
}

export async function browserScreenshot(
  persist: boolean,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  try {
    throwIfAborted(options.signal);
    const win = getBrowserWindow(options.sessionId);
    const image = await withAbort(win.webContents.capturePage(), options.signal);
    let artifact: BrowserControlState['screenshotArtifact'];

    if (persist) {
      const id = randomUUID();
      const dir = path.join(app.getPath('userData'), SCREENSHOT_DIR);
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${id}.png`);
      await fs.writeFile(filePath, image.toPNG());
      artifact = {
        id,
        path: filePath,
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        label: 'Browser Control screenshot',
      };
    }

    return {
      success: true,
      state: await buildState(
        { name: 'browser_screenshot', success: true, message: persist ? 'persisted' : 'transient' },
        artifact,
        options,
      ),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to capture browser screenshot.',
      state: await buildState({ name: 'browser_screenshot', success: false }, undefined, options),
    };
  }
}

export async function browserClick(
  targetValue: unknown,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  const win = getBrowserWindow(options.sessionId);
  try {
    throwIfAborted(options.signal);
    const target = validateTarget(targetValue);
    const resolved = await withAbort(resolveTarget(win, target), options.signal);
    if (!resolved.success || typeof resolved.x !== 'number' || typeof resolved.y !== 'number') {
      return {
        success: false,
        error: resolved.error || 'Could not resolve target.',
        state: await buildState({ name: 'browser_click', success: false, message: resolved.error }, undefined, options),
      };
    }

    await withAbort(clickAt(win, resolved.x, resolved.y), options.signal);
    await waitForLoadSettled(win, 5000, options.signal);
    return {
      success: true,
      state: await buildState({ name: 'browser_click', success: true, message: resolved.description }, undefined, options),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to click browser target.',
      state: await buildState({ name: 'browser_click', success: false }, undefined, options),
    };
  }
}

export async function browserDrag(
  fromValue: unknown,
  toValue: unknown,
  dragOptionsValue: unknown,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  const win = getBrowserWindow(options.sessionId);
  try {
    throwIfAborted(options.signal);
    const fromTarget = validateTarget(fromValue);
    const toTarget = validateTarget(toValue);
    const dragOptions = validateDragOptions(dragOptionsValue);
    const [from, to] = await withAbort(
      Promise.all([
        resolveTarget(win, fromTarget),
        resolveTarget(win, toTarget),
      ]),
      options.signal,
    );

    if (!from.success || typeof from.x !== 'number' || typeof from.y !== 'number') {
      return {
        success: false,
        error: from.error || 'Could not resolve drag start target.',
        state: await buildState({ name: 'browser_drag', success: false, message: from.error }, undefined, options),
      };
    }
    if (!to.success || typeof to.x !== 'number' || typeof to.y !== 'number') {
      return {
        success: false,
        error: to.error || 'Could not resolve drag end target.',
        state: await buildState({ name: 'browser_drag', success: false, message: to.error }, undefined, options),
      };
    }

    await dragAt(win, from.x, from.y, to.x, to.y, dragOptions, options.signal);
    await waitForLoadSettled(win, 5000, options.signal);
    return {
      success: true,
      state: await buildState(
        {
          name: 'browser_drag',
          success: true,
          message: `${from.description ?? 'target'} -> ${to.description ?? 'target'}`,
        },
        undefined,
        options,
      ),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to drag browser target.',
      state: await buildState({ name: 'browser_drag', success: false }, undefined, options),
    };
  }
}

export async function browserType(
  targetValue: unknown,
  text: string,
  clear: boolean,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  const win = getBrowserWindow(options.sessionId);
  try {
    throwIfAborted(options.signal);
    if (!text) {
      throw new Error('browser_type requires non-empty text.');
    }

    const target = validateTarget(targetValue);
    const resolved = await withAbort(resolveTarget(win, target), options.signal);
    if (!resolved.success || typeof resolved.x !== 'number' || typeof resolved.y !== 'number') {
      return {
        success: false,
        error: resolved.error || 'Could not resolve target.',
        state: await buildState({ name: 'browser_type', success: false, message: resolved.error }, undefined, options),
      };
    }

    await withAbort(clickAt(win, resolved.x, resolved.y), options.signal);
    if (clear) {
      await withAbort(win.webContents.executeJavaScript(`
        (() => {
          const active = document.activeElement;
          if (!active) return;
          if ('value' in active) {
            active.value = '';
            active.dispatchEvent(new Event('input', { bubbles: true }));
            return;
          }
          if (active.isContentEditable) {
            active.textContent = '';
            active.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()
      `, true), options.signal);
    }
    win.webContents.insertText(text);
    await sleep(150, options.signal);
    return {
      success: true,
      state: await buildState({ name: 'browser_type', success: true, message: clear ? 'typed after clearing' : 'typed' }, undefined, options),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to type into browser target.',
      state: await buildState({ name: 'browser_type', success: false }, undefined, options),
    };
  }
}

export async function browserWait(
  milliseconds: number,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  const duration = Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 30000)) : 1000;
  await sleep(duration, options.signal);
  const win = getBrowserWindow(options.sessionId);
  await waitForLoadSettled(win, 5000, options.signal);
  return {
    success: true,
    state: await buildState({ name: 'browser_wait', success: true, message: `${duration}ms` }, undefined, options),
  };
}

export async function browserScroll(
  deltaX: number,
  deltaY: number,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult> {
  const win = getBrowserWindow(options.sessionId);
  try {
    throwIfAborted(options.signal);
    const x = Number.isFinite(deltaX) ? Math.max(-10000, Math.min(deltaX, 10000)) : 0;
    const y = Number.isFinite(deltaY) ? Math.max(-10000, Math.min(deltaY, 10000)) : 0;
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: Math.floor(win.getContentBounds().width / 2),
      y: Math.floor(win.getContentBounds().height / 2),
      deltaX: x,
      deltaY: y,
      canScroll: true,
    });
    await sleep(150, options.signal);
    return {
      success: true,
      state: await buildState({ name: 'browser_scroll', success: true, message: `deltaX=${x}, deltaY=${y}` }, undefined, options),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to scroll browser page.',
      state: await buildState({ name: 'browser_scroll', success: false }, undefined, options),
    };
  }
}

export async function browserEvaluate(
  script: string,
  options: BrowserControlOptions = {},
): Promise<BrowserControlResult & { output?: string }> {
  try {
    throwIfAborted(options.signal);
    if (!script.trim()) {
      throw new Error('browser_evaluate requires a non-empty script.');
    }

    const win = getBrowserWindow(options.sessionId);
    const value = await withAbort(win.webContents.executeJavaScript(script, true), options.signal);
    return {
      success: true,
      output: truncateText(asSerializable(value), 4000),
      state: await buildState({ name: 'browser_evaluate', success: true }, undefined, options),
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to evaluate browser script.',
      state: await buildState({ name: 'browser_evaluate', success: false }, undefined, options),
    };
  }
}

export async function closeBrowserControl(sessionId?: string): Promise<void> {
  if (sessionId) {
    const id = getSessionId(sessionId);
    const browserWindow = browserWindows.get(id);
    if (!browserWindow || browserWindow.isDestroyed()) {
      browserWindows.delete(id);
      return;
    }

    browserWindow.destroy();
    browserWindows.delete(id);
    return;
  }

  const windows = [...browserWindows.values()];
  browserWindows.clear();
  for (const browserWindow of windows) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  }
}
