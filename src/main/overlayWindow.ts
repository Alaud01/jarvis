import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;

const OVERLAY_WIDTH = 200;
const OVERLAY_HEIGHT = 44;

function createOverlayHTML(state: 'recording' | 'processing' | 'error', transcript?: string, errorMessage?: string): string {
  const stateConfig = {
    recording: {
      color: '#EF4444',
      pulse: true,
      label: 'Listening...',
    },
    processing: {
      color: '#F59E0B',
      pulse: false,
      label: 'Processing...',
    },
    error: {
      color: '#991B1B',
      pulse: false,
      label: errorMessage || 'Error',
    },
  };

  const config = stateConfig[state];
  const displayLabel = state === 'error' ? config.label : (transcript || config.label);

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: transparent;
      overflow: hidden;
      -webkit-app-region: no-drag;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
    }
    .overlay {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: rgba(15, 15, 15, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 22px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      min-width: ${OVERLAY_WIDTH - 20}px;
      max-width: 500px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${config.color};
      flex-shrink: 0;
      ${config.pulse ? 'animation: pulse 1.2s ease-in-out infinite;' : ''}
    }
    .label {
      color: rgba(255, 255, 255, 0.95);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 460px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="dot"></div>
    <div class="label">${escapeHtml(displayLabel)}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getOverlayPosition(): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width: screenWidth } = display.workAreaSize;
  const wa = display.workArea;
  return {
    x: wa.x + Math.floor((screenWidth - OVERLAY_WIDTH) / 2),
    y: wa.y + 8,
  };
}

function showOverlayWithoutFocus(win: BrowserWindow): void {
  if (process.platform === 'darwin' && typeof win.showInactive === 'function') {
    win.showInactive();
  } else {
    win.show();
  }
}

export function showOverlay(state: 'recording' | 'processing' | 'error', transcript?: string, errorMessage?: string): void {
  const pos = getOverlayPosition();

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML(state, transcript, errorMessage))}`
    );
    overlayWindow.setPosition(pos.x, pos.y);
    if (!overlayWindow.isVisible()) {
      showOverlayWithoutFocus(overlayWindow);
    }
    overlayWindow.setSize(OVERLAY_WIDTH, OVERLAY_HEIGHT);
    return;
  }

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'floating', 1);

  overlayWindow.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML(state, transcript, errorMessage))}`
  );

  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      showOverlayWithoutFocus(overlayWindow);
    }
  });
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

export function destroyOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}