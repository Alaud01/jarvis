import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;
let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let overlayThemeIsDark = true;

const OVERLAY_WIDTH = 200;
const OVERLAY_MAX_WIDTH = 500;
const OVERLAY_HEIGHT = 44;
const OVERLAY_EXIT_MS = 160;

type PixelFrame = {
  pixels: number[];
  duration: number;
};

type OverlayState = 'recording' | 'processing' | 'complete' | 'error';

const STATE_CONFIG: Record<OverlayState, { color: string; label: string }> = {
  recording: {
    color: '#EF4444',
    label: 'Listening...',
  },
  processing: {
    color: '#F59E0B',
    label: 'Processing...',
  },
  complete: {
    color: '#22C55E',
    label: 'Transcribed',
  },
  error: {
    color: '#991B1B',
    label: 'Error',
  },
};

function getOverlayThemeColors(): {
  background: string;
  border: string;
  text: string;
  shadow: string;
} {
  if (overlayThemeIsDark) {
    return {
      background: 'rgba(15, 15, 15, 0.86)',
      border: 'rgba(255, 255, 255, 0.12)',
      text: 'rgba(255, 255, 255, 0.95)',
      shadow: '0 10px 28px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
    };
  }

  return {
    background: 'rgba(255, 255, 255, 0.9)',
    border: 'rgba(0, 0, 0, 0.12)',
    text: 'rgba(17, 17, 17, 0.94)',
    shadow: '0 10px 28px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.82)',
  };
}

const PIXEL_PATTERNS: Record<string, { frames: PixelFrame[] }> = {
  recording: {
    frames: [
      { pixels: [1, 2], duration: 130 },
      { pixels: [2, 3], duration: 130 },
      { pixels: [3, 6], duration: 130 },
      { pixels: [6, 9], duration: 130 },
      { pixels: [9, 8], duration: 130 },
      { pixels: [8, 7], duration: 130 },
      { pixels: [7, 4], duration: 130 },
      { pixels: [4, 1], duration: 130 },
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
  complete: {
    frames: [
      { pixels: [3, 5, 7], duration: 180 },
      { pixels: [2, 4, 5, 6, 8], duration: 220 },
      { pixels: [4, 5, 6], duration: 900 },
    ],
  },
  error: {
    frames: [
      { pixels: [1, 3, 5, 7, 9], duration: 240 },
      { pixels: [2, 4, 5, 6, 8], duration: 240 },
    ],
  },
};

function getOverlayDisplayLabel(state: OverlayState, transcript?: string, errorMessage?: string): string {
  if (state === 'error') {
    return errorMessage || STATE_CONFIG.error.label;
  }

  return transcript || STATE_CONFIG[state].label;
}

function getOverlayWidth(label: string): number {
  const estimatedTextWidth = Math.ceil(label.length * 7.2);
  return Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_WIDTH, estimatedTextWidth + 66));
}

function getOverlayPayload(state: OverlayState, transcript?: string, errorMessage?: string): {
  state: OverlayState;
  label: string;
  config: { color: string; label: string };
  frames: PixelFrame[];
} {
  return {
    state,
    label: getOverlayDisplayLabel(state, transcript, errorMessage),
    config: STATE_CONFIG[state],
    frames: PIXEL_PATTERNS[state]?.frames || PIXEL_PATTERNS.recording.frames,
  };
}

function createOverlayHTML(state: OverlayState, transcript?: string, errorMessage?: string): string {
  const payload = getOverlayPayload(state, transcript, errorMessage);
  const themeColors = getOverlayThemeColors();
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      --overlay-bg: ${themeColors.background};
      --overlay-border: ${themeColors.border};
      --overlay-text: ${themeColors.text};
      --overlay-shadow: ${themeColors.shadow};
      --cell-color: ${payload.config.color};
      --cell-glow: ${payload.config.color}66;
      --cell-glow-soft: ${payload.config.color}33;
      background: transparent;
      overflow: hidden;
      -webkit-app-region: no-drag;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
    }
    @keyframes overlayIn {
      from {
        opacity: 0;
        transform: translateY(-8px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }
    @keyframes overlayOut {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      to {
        opacity: 0;
        transform: translateY(-6px) scale(0.98);
      }
    }
    .overlay {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: var(--overlay-bg);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 999px;
      border: 1px solid var(--overlay-border);
      box-shadow: var(--overlay-shadow);
      min-width: ${OVERLAY_WIDTH - 20}px;
      max-width: 500px;
      transform-origin: top center;
      animation: overlayIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
      will-change: opacity, transform;
    }
    body.exiting .overlay {
      animation: overlayOut ${OVERLAY_EXIT_MS}ms cubic-bezier(0.4, 0, 1, 1) both;
    }
    .pixel-grid {
      display: grid;
      grid-template-columns: repeat(3, 7px);
      grid-template-rows: repeat(3, 7px);
      gap: 2px;
      flex-shrink: 0;
    }
    .pixel-cell {
      width: 7px;
      height: 7px;
      border-radius: 2px;
      background: transparent;
      opacity: 0;
      transform: scale(0.82);
      transition:
        background-color 130ms linear,
        box-shadow 130ms linear,
        opacity 130ms ease-out,
        transform 130ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .pixel-cell.on {
      background: var(--cell-color);
      box-shadow: 0 0 7px 2px var(--cell-glow), 0 0 16px 4px var(--cell-glow-soft);
      opacity: 1;
      transform: scale(1);
    }
    .label {
      color: var(--overlay-text);
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 460px;
      transition: opacity 130ms ease, transform 130ms ease;
    }
    .label.is-changing {
      opacity: 0;
      transform: translateY(-2px);
    }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="pixel-grid" id="grid"></div>
    <div class="label" id="label">${escapeHtml(payload.label)}</div>
  </div>
  <script>
    (function() {
      var frames = ${JSON.stringify(payload.frames)};
      var state = ${JSON.stringify(state)};
      var cells = [];
      var activePixels = new Set();
      var timer = null;
      var labelTimer = null;
      var grid = document.getElementById('grid');
      var label = document.getElementById('label');
      for (var i = 0; i < 9; i++) {
        var cell = document.createElement('div');
        cell.className = 'pixel-cell';
        cell.dataset.index = String(i + 1);
        grid.appendChild(cell);
        cells.push(cell);
      }
      var step = 0;
      function setColor(color) {
        document.body.style.setProperty('--cell-color', color);
        document.body.style.setProperty('--cell-glow', color + '66');
        document.body.style.setProperty('--cell-glow-soft', color + '33');
      }
      function setLabel(nextLabel) {
        if (!label || label.textContent === nextLabel) return;
        if (labelTimer) clearTimeout(labelTimer);
        label.classList.add('is-changing');
        labelTimer = setTimeout(function() {
          label.textContent = nextLabel;
          requestAnimationFrame(function() {
            label.classList.remove('is-changing');
          });
        }, 95);
      }
      function getActiveSet() {
        if (frames.length === 0) return new Set();
        return new Set(frames[step % frames.length].pixels);
      }
      function paint(active) {
        activePixels = active;
        cells.forEach(function(cell) {
          var idx = parseInt(cell.dataset.index, 10);
          if (active.has(idx)) {
            cell.classList.add('on');
          } else {
            cell.classList.remove('on');
          }
        });
      }
      function tick() {
        var frame = frames[step % (frames.length || 1)];
        paint(getActiveSet());
        step = (step + 1) % (frames.length || 1);
        timer = setTimeout(tick, frame ? frame.duration : 200);
      }
      window.updateOverlayState = function(payload) {
        document.body.classList.remove('exiting');
        state = payload.state;
        setColor(payload.config.color);
        setLabel(payload.label);

        var nextFrames = payload.frames || [];
        var firstNextFrame = nextFrames.length > 0 ? nextFrames[0].pixels : [];
        var bridgeFrames = activePixels.size > 0
          ? [
              { pixels: Array.from(activePixels), duration: 90 },
              { pixels: firstNextFrame, duration: 130 },
            ]
          : [];

        frames = bridgeFrames.concat(nextFrames);
        step = 0;
        if (timer) clearTimeout(timer);
        tick();
      };
      window.updateOverlayTheme = function(colors) {
        document.body.style.setProperty('--overlay-bg', colors.background);
        document.body.style.setProperty('--overlay-border', colors.border);
        document.body.style.setProperty('--overlay-text', colors.text);
        document.body.style.setProperty('--overlay-shadow', colors.shadow);
      };
      tick();
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

function getOverlayPosition(width = OVERLAY_WIDTH): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const { width: screenWidth } = display.workAreaSize;
  const wa = display.workArea;
  return {
    x: wa.x + Math.floor((screenWidth - width) / 2),
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

export function setOverlayThemeBackground(isDark: boolean): void {
  overlayThemeIsDark = isDark;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  const colors = getOverlayThemeColors();
  overlayWindow.webContents.executeJavaScript(`
    if (window.updateOverlayTheme) {
      window.updateOverlayTheme(${JSON.stringify(colors)});
    } else {
      document.body.style.setProperty('--overlay-bg', ${JSON.stringify(colors.background)});
      document.body.style.setProperty('--overlay-border', ${JSON.stringify(colors.border)});
      document.body.style.setProperty('--overlay-text', ${JSON.stringify(colors.text)});
      document.body.style.setProperty('--overlay-shadow', ${JSON.stringify(colors.shadow)});
    }
  `).catch(() => {
    // The overlay may be between data URL loads; the next show call will pick up the theme.
  });
}

export function showOverlay(state: OverlayState, transcript?: string, errorMessage?: string): void {
  const payload = getOverlayPayload(state, transcript, errorMessage);
  const overlayWidth = getOverlayWidth(payload.label);
  const pos = getOverlayPosition(overlayWidth);
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = null;
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.executeJavaScript(`
      if (window.updateOverlayState) {
        window.updateOverlayState(${JSON.stringify(payload)});
      }
    `).catch(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.loadURL(
          `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML(state, transcript, errorMessage))}`
        );
      }
    });
    overlayWindow.setBounds({ x: pos.x, y: pos.y, width: overlayWidth, height: OVERLAY_HEIGHT }, true);
    if (!overlayWindow.isVisible()) {
      showOverlayWithoutFocus(overlayWindow);
    }
    return;
  }

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
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
    overlayWindow.webContents.executeJavaScript("document.body.classList.add('exiting');").catch(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
      }
    });
    hideOverlayTimer = setTimeout(() => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.hide();
      }
      hideOverlayTimer = null;
    }, OVERLAY_EXIT_MS);
  }
}

export function destroyOverlay(): void {
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }
  overlayWindow = null;
}
