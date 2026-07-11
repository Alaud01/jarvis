import dotenv from 'dotenv';
import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { startPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC } from './voiceFlow';
import { setOverlayThemeBackground } from './overlayWindow';
import { initializeProviders } from './providers/registry';
import { deleteLegacyStoredProviderApiKeys } from './store';
import {
  buildAppMenu,
  clearRegenerableAppCaches,
  createTray,
  createWindow,
  hideMainWindow,
  showMainWindow,
  shutdownApplicationServices,
  infoLog,
} from './app/lifecycle';
import {
  registerChatStreamHandler,
  registerStopStreamHandler,
} from './ipc/chatStreamHandler';
import {
  registerAttachmentHandlers,
  registerDictionaryHandlers,
  registerGenerateTitleHandler,
  registerModelHandlers,
  registerStoreHandlers,
  registerUsageHandlers,
  registerVoiceModelHandlers,
} from './ipc/storeHandlers';

dotenv.config({ quiet: true });

let tray: Electron.Tray | null = null;
let mainWindow: BrowserWindow | null = null;
const activeStreams = new Map<string, AbortController>();
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

ipcMain.on('set-theme-background', (_event, isDark: boolean) => {
  setOverlayThemeBackground(isDark);
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
  if (win) {
    win.setBackgroundColor(isDark ? '#0a0a0a' : '#ffffff');
  }
});

registerChatStreamHandler(activeStreams);
registerStopStreamHandler(activeStreams);
registerVoiceFlowIPC();
registerVoiceModelHandlers();
registerStoreHandlers();
registerDictionaryHandlers();
registerModelHandlers();
registerAttachmentHandlers();
registerGenerateTitleHandler();
registerUsageHandlers();

app.whenReady().then(async () => {
  deleteLegacyStoredProviderApiKeys();
  initializeProviders(
    process.env.OPENCODE_GO_API_KEY,
    process.env.OPENROUTER_API_KEY,
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu()));

  // Start in tray-only mode on macOS; the Dock icon appears when the main
  // window is shown (ready-to-show) and disappears again when it's hidden.
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  await clearRegenerableAppCaches();
  mainWindow = createWindow();
  tray = createTray(() => mainWindow, () => hideMainWindow(mainWindow), () => showMainWindow(mainWindow));
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    hideMainWindow(mainWindow);
  });

  infoLog('[Main] Starting Python voice service...');

  void startPythonService()
    .then((pythonStarted) => {
      if (!pythonStarted) {
        console.error('[Main] Failed to start Python voice service - voice features will not work');
      } else {
        infoLog('[Main] Python voice service started successfully');
      }
    })
    .catch((error) => {
      console.error('[Main] Error starting Python service:', error);
    });

  try {
    await initializeVoiceFlow();
    infoLog('[Main] Voice flow initialized');
  } catch (error) {
    console.error('[Main] Error initializing voice flow:', error);
  }
  infoLog('[Main] Browser Control is ready for assistant-directed browser tools');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (process.platform === 'darwin') {
    showMainWindow(mainWindow);
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;
  tray?.destroy();
  tray = null;

  // Electron does not await async event listeners. Hold the quit open until
  // child services have actually stopped, otherwise Ctrl+C can orphan them.
  if (shutdownComplete) {
    return;
  }

  event.preventDefault();

  if (!shutdownPromise) {
    infoLog('[Main] Stopping application services...');
    shutdownPromise = shutdownApplicationServices().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  }
});

// Development runners such as concurrently forward terminal signals directly
// to Electron. Convert them into Electron's graceful quit path.
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
