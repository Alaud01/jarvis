import { app, BrowserWindow, Tray, nativeImage, Menu, shell, session } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { setMainWindow } from '../audioRecorder';
import { cleanupVoiceFlow } from '../voiceFlow';
import { closeBrowserControl } from '../browserControlService';
import { stopPythonService } from '../pythonService';
import { debugLog, infoLog } from '../logger';

// `electron .` is not packaged in either development or the local production
// start command. Use the explicit environment flag so `pnpm start` loads the
// compiled renderer instead of assuming a Vite server is running.
export const isDev = process.env.NODE_ENV === 'development';
export const CHAT_MODEL_KEEP_ALIVE = '2m';
export const ONE_OFF_MODEL_KEEP_ALIVE = 0;
const MAIN_WINDOW_MIN_WIDTH = 720;
const MAIN_WINDOW_MIN_HEIGHT = 520;

const REGENERABLE_CACHE_PATHS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  path.join('Service Worker', 'CacheStorage'),
];

export function logMainProcess(
  prefix: 'LLM' | 'BrowserControl',
  message: string,
  details?: Record<string, unknown>
): void {
  const label = `[${prefix}] ${message}`;
  if (details) {
    debugLog(label, details);
    return;
  }

  debugLog(label);
}

export function showMainWindow(mainWindow: BrowserWindow | null): void {
  if (process.platform === 'darwin') {
    app.dock?.show();
  }
  mainWindow?.show();
  mainWindow?.focus();
}

export function hideMainWindow(mainWindow: BrowserWindow | null): void {
  mainWindow?.hide();
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
}

export function attachMainWindowDiagnostics(window: BrowserWindow): void {
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Renderer] Failed to load:', { errorCode, errorDescription, url: validatedURL });
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Process gone:', details);
  });

  window.webContents.on('unresponsive', () => {
    console.error('[Renderer] Window became unresponsive');
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[Renderer] Preload failed:', { preloadPath, error });
  });
}

export function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    frame: true,
    resizable: true,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setMainWindow(mainWindow);
  attachMainWindowDiagnostics(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => {
    showMainWindow(mainWindow);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5174');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  return mainWindow;
}

export function createTray(getMainWindow: () => BrowserWindow | null, onHide: () => void, onShow: () => void): Tray {
  const iconPath = path.join(
    __dirname,
    '../../../assets',
    process.platform === 'darwin' ? 'trayTemplate.png' : 'icon.png',
  );
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  const tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => onShow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setToolTip('Jarvis');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    const mainWindow = getMainWindow();
    if (mainWindow?.isVisible()) {
      onHide();
    } else {
      onShow();
    }
  });

  return tray;
}

export function broadcastMenuAction(action: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(`menu:${action}`);
    }
  }
}

export function buildAppMenu(): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: 'File',
    submenu: [
      {
        label: 'New Conversation',
        accelerator: 'CmdOrCtrl+N',
        click: () => broadcastMenuAction('new-conversation'),
      },
      { type: 'separator' },
      { role: 'close' },
    ],
  });

  template.push({ role: 'editMenu' });

  // View menu: standard items, with toggleDevTools only in dev.
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
  ];
  if (isDev) {
    viewSubmenu.push({ role: 'toggleDevTools' });
  }
  viewSubmenu.push({ type: 'separator' }, { role: 'togglefullscreen' });

  template.push({
    label: 'View',
    submenu: viewSubmenu,
  });

  template.push({
    role: 'windowMenu',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(process.platform === 'darwin' ? [{ role: 'front' } as Electron.MenuItemConstructorOptions] : []),
    ],
  });

  return template;
}

export async function clearRegenerableAppCaches(): Promise<void> {
  const userDataPath = app.getPath('userData');

  await Promise.allSettled([
    session.defaultSession.clearCache(),
    ...REGENERABLE_CACHE_PATHS.map(relativePath =>
      fs.rm(path.join(userDataPath, relativePath), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      }),
    ),
  ]).then(results => {
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) {
      console.warn('[Main] Some app cache cleanup tasks failed:', failures.map(failure => {
        const reason = failure.reason as NodeJS.ErrnoException;
        return {
          code: reason.code,
          path: reason.path,
          message: reason.message,
        };
      }));
    }
  });
}

export async function shutdownApplicationServices(): Promise<void> {
  const results = await Promise.allSettled([
    cleanupVoiceFlow(),
    closeBrowserControl(),
    stopPythonService(),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('[Main] Failed to clean up a service during shutdown:', result.reason);
    }
  }
}

export { infoLog };
