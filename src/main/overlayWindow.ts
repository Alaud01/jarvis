import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;
let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let overlayThemeIsDark = true;

const OVERLAY_WIDTH = 200;
const OVERLAY_MAX_WIDTH = 500;
const OVERLAY_HEIGHT = 56;
const OVERLAY_EXIT_MS = 160;
const PROCESSING_FILL_MS = 180;

type OverlayState = 'recording' | 'processing' | 'complete' | 'error';
type OverlayVisualStage = OverlayState | 'processing-fill';

const STATE_CONFIG: Record<OverlayState, { label: string; stage: OverlayVisualStage }> = {
  recording: {
    label: 'Listening...',
    stage: 'recording',
  },
  processing: {
    label: 'Processing...',
    stage: 'processing',
  },
  complete: {
    label: 'Transcribed',
    stage: 'complete',
  },
  error: {
    label: 'Error',
    stage: 'error',
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

function getOverlayDisplayLabel(state: OverlayState, transcript?: string, errorMessage?: string): string {
  if (state === 'error') {
    return errorMessage || STATE_CONFIG.error.label;
  }

  return transcript || STATE_CONFIG[state].label;
}

function getOverlayWidth(label: string): number {
  const estimatedTextWidth = Math.ceil(label.length * 7.2);
  return Math.min(OVERLAY_MAX_WIDTH, Math.max(OVERLAY_WIDTH, estimatedTextWidth + 78));
}

function getOverlayPayload(state: OverlayState, transcript?: string, errorMessage?: string): {
  state: OverlayState;
  label: string;
  stage: OverlayVisualStage;
} {
  return {
    state,
    label: getOverlayDisplayLabel(state, transcript, errorMessage),
    stage: STATE_CONFIG[state].stage,
  };
}

const PIXEL_SPINNER_CELLS = Array.from(
  { length: 16 },
  (_, index) => `<div class="cell cell-${index}"></div>`
).join('');

type PixelOpacityMap = Record<number, number[]>;

const RECORDING_OPACITIES: PixelOpacityMap = {
  0: [1, 0.5, 0.25, 0.15, 0, 1],
  1: [1, 0.5, 0.25, 0.15, 0, 0],
  2: [1, 1, 0.5, 0.25, 0.15, 0],
  3: [0, 1, 0.5, 0.25, 0.15, 0],
  4: [0.5, 0.25, 0.15, 0, 0, 1],
  7: [0, 1, 1, 0.5, 0.25, 0.15],
  8: [0.5, 0.25, 0.15, 0, 1, 1],
  11: [0, 0, 1, 0.5, 0.25, 0.15],
  12: [0.25, 0.15, 0, 0, 1, 0.5],
  13: [0.25, 0.15, 0, 1, 1, 0.5],
  14: [0.15, 0, 0, 1, 0.5, 0.25],
  15: [0.15, 0, 1, 1, 0.5, 0.25],
};

const PROCESSING_OPACITIES: PixelOpacityMap = {
  0: [0.15, 1, 0.5, 0.25],
  1: [0.15, 1, 0.5, 0.25],
  2: [0.15, 1, 0.5, 0.25],
  3: [0.15, 1, 0.5, 0.25],
  4: [0.15, 1, 0.5, 0.25],
  5: [1, 0.5, 0.25, 1],
  6: [1, 0.5, 0.25, 1],
  7: [0.15, 1, 0.5, 0.25],
  8: [0.15, 1, 0.5, 0.25],
  9: [1, 0.5, 0.25, 1],
  10: [1, 0.5, 0.25, 1],
  11: [0.15, 1, 0.5, 0.25],
  12: [0.15, 1, 0.5, 0.25],
  13: [0.15, 1, 0.5, 0.25],
  14: [0.15, 1, 0.5, 0.25],
  15: [0.15, 1, 0.5, 0.25],
};

const COMPLETE_OPACITIES: PixelOpacityMap = {
  0: [1, 0.5, 0.25, 0.15, 1, 0.5],
  1: [0, 1, 0.5, 0.25, 0.15, 0],
  2: [0.5, 0.25, 1, 0.5, 0.25, 1],
  3: [0.15, 0, 0, 1, 0.5, 0.25],
  4: [0, 1, 0.5, 0.25, 0.15, 0],
  5: [1, 0.5, 0.25, 0.15, 0, 1],
  6: [0.25, 0.15, 0, 1, 1, 0.5],
  7: [0, 0, 1, 0.5, 0.25, 0.15],
  8: [0, 0, 1, 0.5, 0.25, 0.15],
  9: [0.25, 0.15, 0, 1, 1, 0.5],
  10: [0.5, 1, 0.5, 0.25, 0.15, 1],
  11: [1, 0.5, 0.25, 0.15, 0, 0],
  12: [0.15, 0, 0, 1, 0.5, 0.25],
  13: [0.5, 0.25, 1, 0.5, 0.25, 1],
  14: [1, 0.5, 0.25, 0.15, 0, 0],
  15: [0.25, 1, 0.5, 0.25, 1, 0.5],
};

function buildPixelKeyframes(prefix: string, opacitiesByCell: PixelOpacityMap): string {
  return Object.entries(opacitiesByCell)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([cell, opacities]) => {
      const loopedOpacities = [...opacities, opacities[0]];
      const stepSize = 100 / opacities.length;
      const steps = loopedOpacities
        .map((opacity, index) => `      ${(index * stepSize).toFixed(2)}% { opacity: ${opacity}; }`)
        .join('\n');
      return `    @keyframes ${prefix}-ps-${cell} {\n${steps}\n    }`;
    })
    .join('\n');
}

const PIXEL_SPINNER_KEYFRAMES = [
  buildPixelKeyframes('recording', RECORDING_OPACITIES),
  buildPixelKeyframes('processing', PROCESSING_OPACITIES),
  buildPixelKeyframes('complete', COMPLETE_OPACITIES),
].join('\n');

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
      gap: 12px;
      padding: 10px 18px;
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
    .pixel-spinner {
      display: inline-grid;
      grid-template-columns: repeat(4, 5px);
      gap: 0;
      flex-shrink: 0;
    }
    .pixel-spinner .cell {
      width: 5px;
      height: 5px;
      opacity: 0;
      animation-duration: 1200ms;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
      background: linear-gradient(135deg, #ff416c, #ff4b2b);
      box-shadow:
        0 0 4px #ff416c,
        0 0 10px #ff416c80,
        0 0 19px #ff416c55;
    }
    .pixel-spinner.stage-processing-fill .cell {
      animation: none;
    }
    .pixel-spinner.stage-processing-fill .cell-0,
    .pixel-spinner.stage-processing-fill .cell-1,
    .pixel-spinner.stage-processing-fill .cell-2,
    .pixel-spinner.stage-processing-fill .cell-3,
    .pixel-spinner.stage-processing-fill .cell-4,
    .pixel-spinner.stage-processing-fill .cell-7,
    .pixel-spinner.stage-processing-fill .cell-8,
    .pixel-spinner.stage-processing-fill .cell-11,
    .pixel-spinner.stage-processing-fill .cell-12,
    .pixel-spinner.stage-processing-fill .cell-13,
    .pixel-spinner.stage-processing-fill .cell-14,
    .pixel-spinner.stage-processing-fill .cell-15 {
      opacity: 1;
    }
    .pixel-spinner.stage-processing .cell {
      animation-duration: 800ms;
      background: linear-gradient(135deg, #f6d365, #fda085);
      box-shadow:
        0 0 4px #fda085,
        0 0 10px #fda08580,
        0 0 19px #fda08555;
    }
    .pixel-spinner.stage-complete .cell {
      animation-duration: 1200ms;
      background: linear-gradient(135deg, #134e5e, #33ff5c);
      box-shadow:
        0 0 4px #33ff5c,
        0 0 10px #33ff5c80,
        0 0 19px #33ff5c55;
    }
    .pixel-spinner.stage-error .cell {
      animation: pixel-error-pulse 900ms ease-in-out infinite alternate;
      background: linear-gradient(135deg, #7f1d1d, #ef4444);
      box-shadow:
        0 0 4px #ef4444,
        0 0 10px #ef444480,
        0 0 19px #ef444455;
      opacity: 0.45;
    }
    .pixel-spinner.stage-error .cell-0,
    .pixel-spinner.stage-error .cell-3,
    .pixel-spinner.stage-error .cell-5,
    .pixel-spinner.stage-error .cell-6,
    .pixel-spinner.stage-error .cell-9,
    .pixel-spinner.stage-error .cell-10,
    .pixel-spinner.stage-error .cell-12,
    .pixel-spinner.stage-error .cell-15 {
      animation-delay: 120ms;
    }
    .pixel-spinner.stage-recording .cell-0 { animation-name: recording-ps-0; }
    .pixel-spinner.stage-recording .cell-1 { animation-name: recording-ps-1; }
    .pixel-spinner.stage-recording .cell-2 { animation-name: recording-ps-2; }
    .pixel-spinner.stage-recording .cell-3 { animation-name: recording-ps-3; }
    .pixel-spinner.stage-recording .cell-4 { animation-name: recording-ps-4; }
    .pixel-spinner.stage-recording .cell-7 { animation-name: recording-ps-7; }
    .pixel-spinner.stage-recording .cell-8 { animation-name: recording-ps-8; }
    .pixel-spinner.stage-recording .cell-11 { animation-name: recording-ps-11; }
    .pixel-spinner.stage-recording .cell-12 { animation-name: recording-ps-12; }
    .pixel-spinner.stage-recording .cell-13 { animation-name: recording-ps-13; }
    .pixel-spinner.stage-recording .cell-14 { animation-name: recording-ps-14; }
    .pixel-spinner.stage-recording .cell-15 { animation-name: recording-ps-15; }
    .pixel-spinner.stage-processing .cell-0 { animation-name: processing-ps-0; }
    .pixel-spinner.stage-processing .cell-1 { animation-name: processing-ps-1; }
    .pixel-spinner.stage-processing .cell-2 { animation-name: processing-ps-2; }
    .pixel-spinner.stage-processing .cell-3 { animation-name: processing-ps-3; }
    .pixel-spinner.stage-processing .cell-4 { animation-name: processing-ps-4; }
    .pixel-spinner.stage-processing .cell-5 { animation-name: processing-ps-5; }
    .pixel-spinner.stage-processing .cell-6 { animation-name: processing-ps-6; }
    .pixel-spinner.stage-processing .cell-7 { animation-name: processing-ps-7; }
    .pixel-spinner.stage-processing .cell-8 { animation-name: processing-ps-8; }
    .pixel-spinner.stage-processing .cell-9 { animation-name: processing-ps-9; }
    .pixel-spinner.stage-processing .cell-10 { animation-name: processing-ps-10; }
    .pixel-spinner.stage-processing .cell-11 { animation-name: processing-ps-11; }
    .pixel-spinner.stage-processing .cell-12 { animation-name: processing-ps-12; }
    .pixel-spinner.stage-processing .cell-13 { animation-name: processing-ps-13; }
    .pixel-spinner.stage-processing .cell-14 { animation-name: processing-ps-14; }
    .pixel-spinner.stage-processing .cell-15 { animation-name: processing-ps-15; }
    .pixel-spinner.stage-complete .cell-0 { animation-name: complete-ps-0; }
    .pixel-spinner.stage-complete .cell-1 { animation-name: complete-ps-1; }
    .pixel-spinner.stage-complete .cell-2 { animation-name: complete-ps-2; }
    .pixel-spinner.stage-complete .cell-3 { animation-name: complete-ps-3; }
    .pixel-spinner.stage-complete .cell-4 { animation-name: complete-ps-4; }
    .pixel-spinner.stage-complete .cell-5 { animation-name: complete-ps-5; }
    .pixel-spinner.stage-complete .cell-6 { animation-name: complete-ps-6; }
    .pixel-spinner.stage-complete .cell-7 { animation-name: complete-ps-7; }
    .pixel-spinner.stage-complete .cell-8 { animation-name: complete-ps-8; }
    .pixel-spinner.stage-complete .cell-9 { animation-name: complete-ps-9; }
    .pixel-spinner.stage-complete .cell-10 { animation-name: complete-ps-10; }
    .pixel-spinner.stage-complete .cell-11 { animation-name: complete-ps-11; }
    .pixel-spinner.stage-complete .cell-12 { animation-name: complete-ps-12; }
    .pixel-spinner.stage-complete .cell-13 { animation-name: complete-ps-13; }
    .pixel-spinner.stage-complete .cell-14 { animation-name: complete-ps-14; }
    .pixel-spinner.stage-complete .cell-15 { animation-name: complete-ps-15; }
    @keyframes pixel-error-pulse {
      from { opacity: 0.35; }
      to { opacity: 1; }
    }
${PIXEL_SPINNER_KEYFRAMES}
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
    <div class="pixel-spinner stage-${payload.stage}" id="spinner">
      ${PIXEL_SPINNER_CELLS}
    </div>
    <div class="label" id="label">${escapeHtml(payload.label)}</div>
  </div>
  <script>
    (function() {
      var state = ${JSON.stringify(state)};
      var fillTimer = null;
      var labelTimer = null;
      var spinner = document.getElementById('spinner');
      var label = document.getElementById('label');
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
      function setStage(stage) {
        if (!spinner) return;
        spinner.className = 'pixel-spinner stage-' + stage;
      }
      function applyPayload(payload) {
        state = payload.state;
        setLabel(payload.label);
        setStage(payload.stage);
      }
      window.updateOverlayState = function(payload) {
        document.body.classList.remove('exiting');
        if (fillTimer) {
          clearTimeout(fillTimer);
          fillTimer = null;
        }

        if (state === 'recording' && payload.state === 'processing') {
          setStage('processing-fill');
          fillTimer = setTimeout(function() {
            applyPayload(payload);
            fillTimer = null;
          }, ${PROCESSING_FILL_MS});
          return;
        }

        applyPayload(payload);
      };
      window.updateOverlayTheme = function(colors) {
        document.body.style.setProperty('--overlay-bg', colors.background);
        document.body.style.setProperty('--overlay-border', colors.border);
        document.body.style.setProperty('--overlay-text', colors.text);
        document.body.style.setProperty('--overlay-shadow', colors.shadow);
      };
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

function hideOverlayWindowButtons(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false);
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
    hideOverlayWindowButtons(overlayWindow);
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
    closable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
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
  hideOverlayWindowButtons(overlayWindow);

  overlayWindow.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML(state, transcript, errorMessage))}`
  );

  overlayWindow.once('ready-to-show', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      hideOverlayWindowButtons(overlayWindow);
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
