import dotenv from 'dotenv';
import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, dialog, Menu, ipcMain, shell } from 'electron';
import { startPythonService } from './pythonService';
import { initializeVoiceFlow, registerVoiceFlowIPC } from './voiceFlow';
import { setOverlayThemeBackground } from './overlayWindow';
import { getCodexProvider, initializeProviders } from './providers/registry';
import { deleteLegacyStoredProviderApiKeys } from './store';
import { resolveCodexSwitcherAuthPath } from './codexAppServer';
import {
  buildAppMenu,
  broadcastMenuAction,
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
import {
  connectNotionMcp,
  disconnectNotionMcp,
  getNotionConnectionStatus,
  initializeNotionMcp,
} from './notionMcpService';

dotenv.config({ quiet: true });

let tray: Electron.Tray | null = null;
let mainWindow: BrowserWindow | null = null;
const activeStreams = new Map<string, AbortController>();
let isQuitting = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

ipcMain.on('set-theme-background', (_event, isDark: boolean) => {
  setOverlayThemeBackground(isDark);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(isDark ? '#000000' : '#ffffff');
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
    {
      codexHome: path.join(app.getPath('userData'), 'codex-runtime'),
      workspaceRoot: path.join(app.getPath('userData'), 'codex-workspace'),
      openExternal: url => shell.openExternal(url),
      sharedAuthPath: resolveCodexSwitcherAuthPath(os.homedir(), process.env),
    },
  );
  await initializeNotionMcp();

  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenu({
    onConnectCodex: () => {
      void (async () => {
        try {
          const provider = getCodexProvider();
          if (!provider) throw new Error('The Codex provider is unavailable.');
          const account = await provider.connectAccount();
          const models = await provider.fetchModels();
          const accountLabel = [account.email, account.planType].filter(Boolean).join(' · ');
          broadcastMenuAction('models-refresh');
          await dialog.showMessageBox({
            type: 'info',
            title: 'Codex connected',
            message: provider.followsCodexSwitcher
              ? 'Jarvis is using the account selected in Codex Switcher.'
              : 'Jarvis is connected to your ChatGPT account.',
            detail: [
              accountLabel || (provider.followsCodexSwitcher
                ? 'Switching accounts in Codex Switcher switches Jarvis too.'
                : 'The account is stored only in Jarvis’s private Codex runtime.'),
              models.length > 0
                ? `${models.length} Codex models are available. Choose one with the model button at the lower-left of the chat composer.`
                : 'Codex returned no picker-visible models. Use Codex → Refresh Models after checking the account.',
            ].join('\n\n'),
          });
        } catch (error) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Unable to connect Codex',
            message: error instanceof Error ? error.message : 'ChatGPT sign-in failed.',
          });
        }
      })();
    },
    onDisconnectCodex: () => {
      void (async () => {
        if (getCodexProvider()?.followsCodexSwitcher) {
          await dialog.showMessageBox({
            type: 'info',
            title: 'Managed by Codex Switcher',
            message: 'Jarvis uses the account selected in Codex Switcher.',
            detail: 'Switch or sign out in Codex Switcher; Jarvis follows it automatically.',
          });
          return;
        }
        const confirmation = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Disconnect'],
          defaultId: 0,
          cancelId: 0,
          title: 'Disconnect Codex?',
          message: 'Disconnect Jarvis from this ChatGPT account?',
          detail: 'This affects only Jarvis’s private Codex runtime and does not sign out the Codex app or CLI.',
        });
        if (confirmation.response !== 1) return;
        try {
          const provider = getCodexProvider();
          if (!provider) throw new Error('The Codex provider is unavailable.');
          await provider.disconnectAccount();
          broadcastMenuAction('models-refresh');
        } catch (error) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Unable to disconnect Codex',
            message: error instanceof Error ? error.message : 'ChatGPT sign-out failed.',
          });
        }
      })();
    },
    onConnectNotion: () => {
      void (async () => {
        try {
          const notionStatus = await connectNotionMcp();
          await dialog.showMessageBox({
            type: 'info',
            title: 'Notion connected',
            message: 'Jarvis is connected to Notion through the hosted Notion MCP server.',
            detail: notionStatus.unavailableCoreCapabilities.length > 0
              ? `Unavailable capabilities: ${notionStatus.unavailableCoreCapabilities.join(', ')}`
              : `${notionStatus.availableCapabilities.length} approved Notion capabilities are available.`,
          });
        } catch (error) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Unable to connect Notion',
            message: error instanceof Error ? error.message : 'Notion sign-in failed.',
          });
        }
      })();
    },
    onDisconnectNotion: () => {
      void (async () => {
        const confirmation = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Disconnect'],
          defaultId: 0,
          cancelId: 0,
          title: 'Disconnect Notion?',
          message: 'Disconnect Jarvis from this Notion workspace?',
          detail: 'Jarvis will remove its encrypted Notion authorization data from this installation.',
        });
        if (confirmation.response !== 1) return;
        try {
          await disconnectNotionMcp();
        } catch (error) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Unable to disconnect Notion',
            message: error instanceof Error ? error.message : 'Notion disconnect failed.',
          });
        }
      })();
    },
    onShowNotionStatus: () => {
      const notionStatus = getNotionConnectionStatus();
      void dialog.showMessageBox({
        type: notionStatus.state === 'connected' ? 'info' : 'warning',
        title: 'Notion connection',
        message: `Notion is ${notionStatus.state}.`,
        detail: [
          notionStatus.availableCapabilities.length > 0
            ? `Available: ${notionStatus.availableCapabilities.join(', ')}`
            : 'No Notion tools are currently exposed to chat models.',
          notionStatus.unavailableCoreCapabilities.length > 0
            ? `Unavailable: ${notionStatus.unavailableCoreCapabilities.join(', ')}`
            : '',
          notionStatus.message || '',
        ].filter(Boolean).join('\n\n'),
      });
    },
  })));

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
