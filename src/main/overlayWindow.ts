import { BrowserWindow, screen } from 'electron';

let overlayWindow: BrowserWindow | null = null;
let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let overlayThemeIsDark = true;

const OVERLAY_MAX_WIDTH = 500;
const OVERLAY_X_PADDING = 18;
const OVERLAY_CONTENT_GAP = 12;
const PIXEL_SPINNER_SIZE = 20;
const OVERLAY_Y_PADDING = 10;
const OVERLAY_HEIGHT = (OVERLAY_Y_PADDING * 2) + PIXEL_SPINNER_SIZE;
const OVERLAY_EXIT_MS = 160;
const PROCESSING_FILL_MS = 180;
const COMPLETE_FILL_MS = 220;

type OverlayState = 'recording' | 'processing' | 'complete' | 'error';
type OverlayVisualStage = OverlayState | 'processing-fill' | 'complete-fill';

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
      shadow: 'none',
    };
  }

  return {
    background: 'rgba(255, 255, 255, 0.9)',
    border: 'rgba(0, 0, 0, 0.12)',
    text: 'rgba(17, 17, 17, 0.94)',
    shadow: 'none',
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
  const contentWidth = (OVERLAY_X_PADDING * 2) + PIXEL_SPINNER_SIZE + OVERLAY_CONTENT_GAP + estimatedTextWidth;
  return Math.min(OVERLAY_MAX_WIDTH, contentWidth);
}

function getOverlayPayload(state: OverlayState, transcript?: string, errorMessage?: string): {
  state: OverlayState;
  label: string;
  stage: OverlayVisualStage;
  width: number;
} {
  const label = getOverlayDisplayLabel(state, transcript, errorMessage);
  return {
    state,
    label,
    stage: STATE_CONFIG[state].stage,
    width: getOverlayWidth(label),
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
  0: [0.25, 0.15, 1, 0.5],
  1: [0.5, 0.25, 0.15, 1],
  2: [1, 0.5, 0.25, 0.15],
  3: [0.15, 1, 0.5, 0.25],
  4: [0.5, 1, 1, 1],
  5: [1, 0.5, 1, 1],
  6: [1, 1, 0.5, 1],
  7: [1, 1, 1, 0.5],
  8: [1, 0.5, 0.25, 1],
  9: [1, 1, 0.5, 0.25],
  10: [0.25, 1, 1, 0.5],
  11: [0.5, 0.25, 1, 1],
  12: [1, 0.5, 0.25, 0.15],
  13: [0.15, 1, 0.5, 0.25],
  14: [0.25, 0.15, 1, 0.5],
  15: [0.5, 0.25, 0.15, 1],
};

const ERROR_OPACITIES: PixelOpacityMap = {
  0: [1, 0.25, 0.15, 0, 1],
  1: [0.25, 1, 0.25, 0.15, 0],
  2: [1, 0.5, 1, 0.5, 1],
  3: [0.15, 0.25, 1, 0.25, 0.15],
  4: [1, 0.15, 0, 0.15, 1],
  5: [0.5, 1, 0.5, 1, 0.5],
  6: [1, 0.5, 1, 0.5, 1],
  7: [0, 0.15, 1, 0.25, 1],
  8: [1, 0.25, 0.15, 0.25, 1],
  9: [0.5, 1, 0.5, 1, 0.5],
  10: [1, 0.5, 1, 0.5, 1],
  11: [0.15, 0.25, 1, 0.25, 0.15],
  12: [1, 0.15, 0, 0, 1],
  13: [1, 1, 0.5, 1, 1],
  14: [0.5, 0.15, 0.5, 0.15, 0.5],
  15: [1, 0.25, 0.15, 0, 1],
};

type PixelStageColors = { from: string; to: string; glow: string };

const PIXEL_STAGE_COLORS: Record<'recording' | 'processing' | 'complete' | 'error', PixelStageColors> = {
  recording: { from: '#ff416c', to: '#ff4b2b', glow: '#ff416c' },
  processing: { from: '#f6d365', to: '#fda085', glow: '#f6d365' },
  complete: { from: '#1aad4f', to: '#33ff5c', glow: '#1aad4f' },
  error: { from: '#7f1d1d', to: '#ef4444', glow: '#7f1d1d' },
};

function pixelCellBackground(colors: PixelStageColors): string {
  return `linear-gradient(135deg, ${colors.from}, ${colors.to})`;
}

function pixelCellGlow(colors: PixelStageColors): string {
  return `0 0 4px ${colors.glow}, 0 0 10px ${colors.glow}80, 0 0 19px ${colors.glow}55`;
}

function buildPixelStageColorRule(stage: string, colors: PixelStageColors): string {
  return `.pixel-spinner.stage-${stage} .cell {
      background: ${pixelCellBackground(colors)};
      box-shadow: ${pixelCellGlow(colors)};
    }`;
}

function buildPixelCellAnimationRules(stage: string, opacitiesByCell: PixelOpacityMap): string {
  return Object.keys(opacitiesByCell)
    .sort((a, b) => Number(a) - Number(b))
    .map((cell) => `.pixel-spinner.stage-${stage} .cell-${cell} { animation-name: ${stage}-ps-${cell}; }`)
    .join('\n    ');
}

const PIXEL_STAGE_STYLES = [
  buildPixelStageColorRule('recording', PIXEL_STAGE_COLORS.recording),
  buildPixelStageColorRule('processing', PIXEL_STAGE_COLORS.processing),
  buildPixelStageColorRule('complete', PIXEL_STAGE_COLORS.complete),
  buildPixelStageColorRule('error', PIXEL_STAGE_COLORS.error),
  buildPixelStageColorRule('processing-fill', PIXEL_STAGE_COLORS.processing),
  buildPixelStageColorRule('complete-fill', PIXEL_STAGE_COLORS.complete),
].join('\n    ');

const PIXEL_CELL_ANIMATION_RULES = [
  buildPixelCellAnimationRules('recording', RECORDING_OPACITIES),
  buildPixelCellAnimationRules('processing', PROCESSING_OPACITIES),
  buildPixelCellAnimationRules('complete', COMPLETE_OPACITIES),
  buildPixelCellAnimationRules('error', ERROR_OPACITIES),
].join('\n    ');

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
  buildPixelKeyframes('error', ERROR_OPACITIES),
].join('\n');

function createOverlayHTML(state: OverlayState, transcript?: string, errorMessage?: string): string {
  const payload = getOverlayPayload(state, transcript, errorMessage);
  const themeColors = getOverlayThemeColors();
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html {
      background: transparent;
      height: ${OVERLAY_HEIGHT}px;
      width: ${payload.width}px;
    }
    body {
      --overlay-bg: ${themeColors.background};
      --overlay-text: ${themeColors.text};
      background: var(--overlay-bg);
      overflow: hidden;
      -webkit-app-region: no-drag;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      height: ${OVERLAY_HEIGHT}px;
      width: ${payload.width}px;
      display: flex;
      align-items: center;
      transform-origin: center center;
      animation: overlayIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
      transition: width 210ms cubic-bezier(0.16, 1, 0.3, 1);
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
      gap: ${OVERLAY_CONTENT_GAP}px;
      flex: 1;
      min-width: 0;
      height: 100%;
      padding: ${OVERLAY_Y_PADDING}px ${OVERLAY_X_PADDING}px;
    }
    body.exiting {
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
      transition:
        opacity 180ms ease,
        background 220ms ease,
        box-shadow 220ms ease,
        transform 180ms ease;
      will-change: opacity, transform;
    }
${PIXEL_STAGE_STYLES}
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
    .pixel-spinner.stage-complete-fill .cell {
      animation: pixel-complete-fill ${COMPLETE_FILL_MS}ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
${PIXEL_CELL_ANIMATION_RULES}
    @keyframes pixel-complete-fill {
      from {
        opacity: 0.35;
        transform: scale(0.86);
      }
      55% {
        opacity: 1;
        transform: scale(1.12);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
${PIXEL_SPINNER_KEYFRAMES}
    .label {
      color: var(--overlay-text);
      flex: 1;
      min-width: 0;
      font-size: 13px;
      line-height: ${PIXEL_SPINNER_SIZE}px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 460px;
      transition: opacity 150ms ease, transform 150ms ease;
      will-change: opacity, transform;
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
      function setOverlayWidth(width) {
        document.documentElement.style.width = width + 'px';
        document.body.style.width = width + 'px';
      }
      function applyPayload(payload) {
        state = payload.state;
        setOverlayWidth(payload.width);
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

        if (state === 'processing' && payload.state === 'complete') {
          setOverlayWidth(payload.width);
          setLabel(payload.label);
          setStage('complete-fill');
          fillTimer = setTimeout(function() {
            applyPayload(payload);
            fillTimer = null;
          }, ${COMPLETE_FILL_MS});
          return;
        }

        applyPayload(payload);
      };
      window.updateOverlayTheme = function(colors) {
        document.body.style.setProperty('--overlay-bg', colors.background);
        document.body.style.setProperty('--overlay-text', colors.text);
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

function getOverlayPosition(width: number): { x: number; y: number } {
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
      document.body.style.setProperty('--overlay-text', ${JSON.stringify(colors.text)});
    }
  `).catch(() => {
    // The overlay may be between data URL loads; the next show call will pick up the theme.
  });
}

export function showOverlay(state: OverlayState, transcript?: string, errorMessage?: string): void {
  const payload = getOverlayPayload(state, transcript, errorMessage);
  const pos = getOverlayPosition(payload.width);
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
    overlayWindow.setBounds({ x: pos.x, y: pos.y, width: payload.width, height: OVERLAY_HEIGHT }, false);
    if (!overlayWindow.isVisible()) {
      showOverlayWithoutFocus(overlayWindow);
    }
    return;
  }

  overlayWindow = new BrowserWindow({
    width: payload.width,
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
