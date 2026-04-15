import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;

const OVERLAY_WIDTH = 200;
const OVERLAY_HEIGHT = 44;

type PixelFrame = {
  pixels: number[];
  duration: number;
};

const RING_PIXELS = [1, 2, 3, 6, 9, 8, 7, 4];

const PIXEL_PATTERNS: Record<string, { frames: PixelFrame[] }> = {
  recording: {
    frames: [
      { pixels: [1], duration: 200 },
      { pixels: [2], duration: 140 },
      { pixels: [3], duration: 100 },
      { pixels: [6], duration: 80 },
      { pixels: [9], duration: 100 },
      { pixels: [8], duration: 140 },
      { pixels: [7], duration: 200 },
      { pixels: [4], duration: 260 },
    ],
  },
  processing: {
    frames: [
      { pixels: [1, 9], duration: 350 },
      { pixels: [2, 8], duration: 280 },
      { pixels: [3, 7], duration: 220 },
      { pixels: [6, 4], duration: 280 },
      { pixels: [1, 9], duration: 350 },
      { pixels: [2, 8], duration: 420 },
    ],
  },
};

function createOverlayHTML(state: 'recording' | 'processing' | 'error', transcript?: string, errorMessage?: string): string {
  const stateConfig = {
    recording: {
      color: '#EF4444',
      label: 'Listening...',
    },
    processing: {
      color: '#F59E0B',
      label: 'Processing...',
    },
    error: {
      color: '#991B1B',
      label: errorMessage || 'Error',
    },
  };

  const config = stateConfig[state];
  const displayLabel = state === 'error' ? config.label : (transcript || config.label);
  const patternData = PIXEL_PATTERNS[state] || PIXEL_PATTERNS.recording;
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
      gap: 10px;
      padding: 8px 14px;
      background: rgba(15, 15, 15, 0.85);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 22px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      min-width: ${OVERLAY_WIDTH - 20}px;
      max-width: 500px;
    }
    .pixel-grid {
      display: grid;
      grid-template-columns: repeat(3, 6px);
      grid-template-rows: repeat(3, 6px);
      gap: 2px;
      flex-shrink: 0;
    }
    .pixel-cell {
      width: 6px;
      height: 6px;
      border-radius: 1.5px;
      background: rgba(15, 15, 15, 0.85);
      transition: background-color 0.12s ease-out, box-shadow 0.12s ease-out;
    }
    .pixel-cell.on {
      background: ${config.color};
      box-shadow: 0 0 6px 2px ${config.color}66, 0 0 12px 4px ${config.color}33;
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
  </style>
</head>
<body>
  <div class="overlay">
    <div class="pixel-grid" id="grid"></div>
    <div class="label">${escapeHtml(displayLabel)}</div>
  </div>
  <script>
    (function() {
      var frames = ${JSON.stringify(patternData.frames)};
      var cells = [];
      var grid = document.getElementById('grid');
      for (var i = 0; i < 9; i++) {
        var cell = document.createElement('div');
        cell.className = 'pixel-cell';
        cell.dataset.index = String(i + 1);
        grid.appendChild(cell);
        cells.push(cell);
      }
      var step = 0;
      function getActiveSet() {
        if (frames.length === 0) return new Set();
        return new Set(frames[step % frames.length].pixels);
      }
      function tick() {
        var active = getActiveSet();
        cells.forEach(function(cell) {
          var idx = parseInt(cell.dataset.index, 10);
          if (active.has(idx)) {
            cell.classList.add('on');
          } else {
            cell.classList.remove('on');
          }
        });
        step = (step + 1) % (frames.length || 1);
      }
      function scheduleNext() {
        var frame = frames[step % (frames.length || 1)];
        var delay = frame ? frame.duration : 200;
        tick();
        setTimeout(scheduleNext, delay);
      }
      scheduleNext();
    })();
  </script>
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