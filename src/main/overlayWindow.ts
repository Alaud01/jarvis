import { BrowserWindow, screen } from 'electron';

type OverlayAnchorBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

let overlayWindow: BrowserWindow | null = null;
let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let overlayReady = false;
let overlayDesiredVisible = false;
let overlayPresentationId = 0;
let overlayAnchorBounds: OverlayAnchorBounds | null = null;
let pendingOverlayPayload: {
  payload: ReturnType<typeof getOverlayPayload>;
  state: OverlayState;
  transcript?: string;
  errorMessage?: string;
  presentationId: number;
} | null = null;

const OVERLAY_MAX_WIDTH = 500;
const OVERLAY_X_PADDING = 24;
const OVERLAY_CONTENT_GAP = 12;
const PIXEL_SPINNER_SIZE = 20;
const OVERLAY_Y_PADDING = 10;
const OVERLAY_HEIGHT = (OVERLAY_Y_PADDING * 2) + PIXEL_SPINNER_SIZE;
const OVERLAY_MIN_WIDTH = 300;
const OVERLAY_SHADOW_MARGIN = 16;
const OVERLAY_EXIT_MS = 180;
const OVERLAY_WIDTH_MS = 420;
const OVERLAY_LABEL_MS = 320;
const PROCESSING_FILL_MS = 260;
const COMPLETE_FILL_MS = 300;
const STATUS_PULSE_MS = 420;

const OVERLAY_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

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
  // The surface blends into the physical cutout in either application theme.
  return {
      background: 'rgb(0, 0, 0)',
      border: 'rgba(255, 255, 255, 0.12)',
      text: 'rgba(255, 255, 255, 0.95)',
      shadow: 'none',
  };
}

function getOverlayDisplayLabel(state: OverlayState, transcript?: string, errorMessage?: string): string {
  if (state === 'error') {
    // The voice service includes VAD diagnostics in this error. Keep those in
    // logs and renderer events without letting them resize the status surface.
    if (/^No speech detected\b/i.test(errorMessage ?? '')) {
      return 'No speech detected';
    }
    return errorMessage || STATE_CONFIG.error.label;
  }

  return transcript || STATE_CONFIG[state].label;
}

function getOverlayWidth(label: string): number {
  const estimatedTextWidth = Math.ceil(label.length * 7.2);
  const contentWidth = (OVERLAY_X_PADDING * 2) + PIXEL_SPINNER_SIZE + OVERLAY_CONTENT_GAP + estimatedTextWidth;
  return Math.max(OVERLAY_MIN_WIDTH, Math.min(OVERLAY_MAX_WIDTH, contentWidth));
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
  0: [0.25, 0, 1, 0.5],
  1: [0.5, 0.25, 0, 1],
  2: [1, 0.5, 0.25, 0],
  3: [0, 1, 0.5, 0.25],
  4: [0.5, 1, 1, 1],
  5: [1, 0.5, 1, 1],
  6: [1, 1, 0.5, 1],
  7: [1, 1, 1, 0.5],
  8: [1, 0.5, 0.25, 1],
  9: [1, 1, 0.5, 0.25],
  10: [0.25, 1, 1, 0.5],
  11: [0.5, 0.25, 1, 1],
  12: [1, 0.5, 0.25, 0],
  13: [0, 1, 0.5, 0.25],
  14: [0.25, 0, 1, 0.5],
  15: [0.5, 0.25, 0, 1],
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

function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = lightness - chroma * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// Match listening: full saturation, 63% / 58% lightness, warm hue shift on the gradient end.
function buildPixelStageColors(hue: number, toHueShift = 22): PixelStageColors {
  const from = hslToHex(hue, 100, 63);
  const to = hslToHex((hue + toHueShift + 360) % 360, 100, 58);
  return { from, to, glow: from };
}

const PIXEL_STAGE_COLORS: Record<'recording' | 'processing' | 'complete' | 'error', PixelStageColors> = {
  recording: { from: '#ff416c', to: '#ff4b2b', glow: '#ff416c' },
  // Keep both stops in the gold/yellow family (complete uses the same -20° shift within green).
  processing: buildPixelStageColors(48, 12),
  complete: buildPixelStageColors(145, -20),
  error: buildPixelStageColors(0),
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
      height: 100%;
      width: 100%;
    }
    body {
      --overlay-bg: ${themeColors.background};
      --overlay-text: ${themeColors.text};
      --top-reserve: 0px;
      --surface-width: ${payload.width}px;
      background: transparent;
      overflow: hidden;
      -webkit-app-region: no-drag;
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
      height: 100%;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    .overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: ${OVERLAY_CONTENT_GAP}px;
      position: relative;
      width: var(--surface-width);
      min-width: 0;
      height: calc(var(--top-reserve) + ${OVERLAY_HEIGHT}px);
      padding: calc(var(--top-reserve) + ${OVERLAY_Y_PADDING}px) ${OVERLAY_X_PADDING}px ${OVERLAY_Y_PADDING}px;
      background: var(--overlay-bg);
      border-radius: 0 0 22px 22px;
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.2);
      transform-origin: top center;
      transition: width ${OVERLAY_WIDTH_MS}ms ${OVERLAY_EASE},
        transform ${OVERLAY_WIDTH_MS}ms ${OVERLAY_EASE},
        opacity ${OVERLAY_EXIT_MS}ms ease;
    }
    .overlay::before, .overlay::after {
      content: '';
      position: absolute;
      top: 0;
      width: 12px;
      height: 12px;
    }
    .overlay::before {
      left: -12px;
      background: radial-gradient(circle at 0 100%, transparent 12px, var(--overlay-bg) 12.5px);
    }
    .overlay::after {
      right: -12px;
      background: radial-gradient(circle at 100% 100%, transparent 12px, var(--overlay-bg) 12.5px);
    }
    body.preparing .overlay {
      opacity: 0;
      transform: translateY(-${OVERLAY_HEIGHT}px) scaleX(0.92);
      transition: none;
    }
    body.exiting .overlay {
      opacity: 0;
      transform: translateY(-${OVERLAY_HEIGHT}px) scaleX(0.92);
      transition-duration: ${OVERLAY_EXIT_MS}ms;
    }
    @media (prefers-reduced-motion: reduce) {
      .overlay, .label, .pixel-spinner .cell { transition: none !important; }
      .overlay, .label, .pixel-spinner { animation: none !important; }
      .pixel-spinner .cell { animation-duration: 2400ms !important; }
      body.preparing .overlay, body.exiting .overlay { transform: none; }
    }
    .pixel-spinner {
      display: inline-grid;
      grid-template-columns: repeat(4, 5px);
      gap: 0;
      flex-shrink: 0;
      transform-origin: center;
    }
    .pixel-spinner.is-changing {
      animation: spinner-stage-change ${STATUS_PULSE_MS}ms ${OVERLAY_EASE} both;
    }
    .pixel-spinner .cell {
      width: 5px;
      height: 5px;
      opacity: 0;
      animation-duration: 1200ms;
      animation-iteration-count: infinite;
      animation-timing-function: linear;
      transition:
        opacity 260ms ${OVERLAY_EASE},
        background 320ms ${OVERLAY_EASE},
        box-shadow 320ms ${OVERLAY_EASE},
        transform 260ms ${OVERLAY_EASE};
      will-change: opacity, transform;
    }
${PIXEL_STAGE_STYLES}
    .pixel-spinner.stage-processing-fill .cell {
      animation: none;
      transition:
        opacity ${PROCESSING_FILL_MS}ms ${OVERLAY_EASE},
        background 320ms ${OVERLAY_EASE},
        box-shadow 320ms ${OVERLAY_EASE},
        transform ${PROCESSING_FILL_MS}ms ${OVERLAY_EASE};
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
      animation: pixel-complete-fill ${COMPLETE_FILL_MS}ms ${OVERLAY_EASE} both;
    }
${PIXEL_CELL_ANIMATION_RULES}
    @keyframes pixel-complete-fill {
      from {
        opacity: 0;
        transform: scale(0.9);
      }
      45% {
        opacity: 1;
        transform: scale(1.08);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }
    @keyframes spinner-stage-change {
      0% {
        transform: scale(0.76) rotate(-8deg);
        filter: saturate(0.75);
      }
      58% {
        transform: scale(1.1) rotate(2deg);
        filter: saturate(1.2);
      }
      100% {
        transform: scale(1) rotate(0);
        filter: saturate(1);
      }
    }
    @keyframes overlay-status-change {
      0% { transform: scaleX(0.985); }
      62% { transform: scaleX(1.012); }
      100% { transform: scaleX(1); }
    }
    @keyframes label-enter {
      0% {
        opacity: 0;
        transform: translateY(8px) scale(0.97);
        filter: blur(4px);
      }
      68% {
        opacity: 1;
        transform: translateY(-1px) scale(1.005);
        filter: blur(0);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
        filter: blur(0);
      }
    }
    @keyframes label-leave {
      from {
        opacity: 1;
        transform: translateY(0) scale(1);
        filter: blur(0);
      }
      to {
        opacity: 0;
        transform: translateY(-8px) scale(0.97);
        filter: blur(4px);
      }
    }
    .overlay.is-changing {
      animation: overlay-status-change ${STATUS_PULSE_MS}ms ${OVERLAY_EASE} both;
    }
${PIXEL_SPINNER_KEYFRAMES}
    .label {
      grid-area: 1 / 1;
      color: var(--overlay-text);
      flex: 0 1 auto;
      min-width: 0;
      font-size: 13px;
      line-height: ${PIXEL_SPINNER_SIZE}px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: ${OVERLAY_MAX_WIDTH - (OVERLAY_X_PADDING * 2) - PIXEL_SPINNER_SIZE - OVERLAY_CONTENT_GAP}px;
      will-change: opacity, transform, filter;
    }
    .label-stack {
      display: grid;
      align-items: center;
      min-width: 0;
      max-width: ${OVERLAY_MAX_WIDTH - (OVERLAY_X_PADDING * 2) - PIXEL_SPINNER_SIZE - OVERLAY_CONTENT_GAP}px;
      overflow: hidden;
    }
    .label.is-entering {
      animation: label-enter ${OVERLAY_LABEL_MS}ms ${OVERLAY_EASE} both;
    }
    .label.is-leaving {
      animation: label-leave ${OVERLAY_LABEL_MS}ms ${OVERLAY_EASE} both;
    }
  </style>
</head>
<body class="preparing">
  <div class="overlay" role="status" aria-live="polite">
    <div class="pixel-spinner stage-${payload.stage}" id="spinner">
      ${PIXEL_SPINNER_CELLS}
    </div>
    <div class="label-stack" id="label-stack">
      <div class="label" id="label">${escapeHtml(payload.label)}</div>
    </div>
  </div>
  <script>
    (function() {
      var state = ${JSON.stringify(state)};
      var fillTimer = null;
      var statusTimer = null;
      var overlay = document.querySelector('.overlay');
      var spinner = document.getElementById('spinner');
      var labelStack = document.getElementById('label-stack');
      var label = document.getElementById('label');

      function setLabel(nextLabel) {
        if (!label || label.textContent === nextLabel) return;
        var outgoingLabels = Array.prototype.slice.call(labelStack.querySelectorAll('.label'));
        var incoming = document.createElement('div');
        incoming.className = 'label is-entering';
        incoming.textContent = nextLabel;
        labelStack.appendChild(incoming);
        label = incoming;
        outgoingLabels.forEach(function(outgoing) {
          outgoing.classList.add('is-leaving');
        });
        setTimeout(function() {
          outgoingLabels.forEach(function(outgoing) {
            if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
          });
        }, ${OVERLAY_LABEL_MS});
      }
      function setStage(stage) {
        if (!spinner) return;
        spinner.className = 'pixel-spinner stage-' + stage;
        void spinner.offsetWidth;
        spinner.classList.add('is-changing');
      }
      function animateStatusChange() {
        if (!overlay) return;
        if (statusTimer) clearTimeout(statusTimer);
        overlay.classList.remove('is-changing');
        void overlay.offsetWidth;
        overlay.classList.add('is-changing');
        statusTimer = setTimeout(function() {
          overlay.classList.remove('is-changing');
          if (spinner) spinner.classList.remove('is-changing');
          statusTimer = null;
        }, ${STATUS_PULSE_MS});
      }
      function setOverlayWidth(width) {
        document.body.style.setProperty('--surface-width', width + 'px');
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

        var previousState = state;
        state = payload.state;
        if (previousState !== payload.state) animateStatusChange();

        if (previousState === 'recording' && payload.state === 'processing') {
          setOverlayWidth(payload.width);
          setLabel(payload.label);
          setStage('processing-fill');
          fillTimer = setTimeout(function() {
            setStage(payload.stage);
            fillTimer = null;
          }, ${PROCESSING_FILL_MS});
          return;
        }

        if (previousState === 'processing' && payload.state === 'complete') {
          setOverlayWidth(payload.width);
          setLabel(payload.label);
          setStage('complete-fill');
          fillTimer = setTimeout(function() {
            setStage(payload.stage);
            fillTimer = null;
          }, ${COMPLETE_FILL_MS});
          return;
        }

        applyPayload(payload);
      };
      window.prepareOverlayShow = function() {
        document.body.classList.remove('exiting');
        document.body.classList.add('preparing');
        void document.body.offsetWidth;
      };
      window.startOverlayShow = function() {
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            document.body.classList.remove('preparing');
          });
        });
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

function getOverlayDisplay() {
  if (overlayAnchorBounds) {
    return screen.getDisplayMatching(overlayAnchorBounds);
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow && focusedWindow !== overlayWindow && !focusedWindow.isDestroyed()) {
    return screen.getDisplayMatching(focusedWindow.getBounds());
  }

  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

function getOverlayLayout() {
  const display = getOverlayDisplay();
  const bounds = display.bounds ?? display.workArea;
  // Reserve camera/menu-bar space only on the built-in Mac display, including
  // when its menu bar auto-hides. External displays need no cutout clearance.
  const topReserve = process.platform === 'darwin' && display.internal
    ? Math.max(40, Math.min(64, display.workArea.y - bounds.y))
    : 0;
  const width = Math.min(bounds.width, OVERLAY_MAX_WIDTH + OVERLAY_SHADOW_MARGIN * 2);
  return {
    x: bounds.x + Math.floor((bounds.width - width) / 2),
    y: bounds.y,
    width,
    height: topReserve + OVERLAY_HEIGHT + OVERLAY_SHADOW_MARGIN,
    topReserve,
  };
}

function positionOverlay(win: BrowserWindow): void {
  const { topReserve, ...bounds } = getOverlayLayout();
  win.setBounds(bounds);
  void win.webContents.executeJavaScript(
    `document.body.style.setProperty('--top-reserve', '${topReserve}px');`
  ).catch(() => { /* A replacement renderer receives geometry on reveal. */ });
}

async function applyOverlayPayload(
  win: BrowserWindow,
  payload: ReturnType<typeof getOverlayPayload>,
  prepareForReveal: boolean,
): Promise<void> {
  if (win !== overlayWindow || win.isDestroyed()) {
    return;
  }

  hideOverlayWindowButtons(win);
  await win.webContents.executeJavaScript(`
    if (!window.updateOverlayState) {
      throw new Error('Overlay renderer is not ready');
    }
    window.updateOverlayState(${JSON.stringify(payload)});
    if (${prepareForReveal} && window.prepareOverlayShow) {
      window.prepareOverlayShow();
    }
  `);
}

function destroyOverlayWindow(win: BrowserWindow): void {
  if (win === overlayWindow) {
    overlayWindow = null;
    overlayReady = false;
  }
  if (!win.isDestroyed()) {
    win.destroy();
  }
}

function recreateOverlayAfterRendererFailure(
  win: BrowserWindow,
  payload: ReturnType<typeof getOverlayPayload>,
  state: OverlayState,
  transcript: string | undefined,
  errorMessage: string | undefined,
  presentationId: number,
): void {
  if (
    win !== overlayWindow ||
    win.isDestroyed() ||
    !overlayDesiredVisible ||
    presentationId !== overlayPresentationId
  ) {
    return;
  }

  destroyOverlayWindow(win);
  pendingOverlayPayload = { payload, state, transcript, errorMessage, presentationId };
  createOverlayWindow(state, transcript, errorMessage);
}

async function revealOverlay(
  win: BrowserWindow,
  payload: ReturnType<typeof getOverlayPayload>,
  state: OverlayState,
  transcript?: string,
  errorMessage?: string,
  presentationId = overlayPresentationId,
): Promise<void> {
  if (
    win !== overlayWindow ||
    win.isDestroyed() ||
    !overlayDesiredVisible ||
    presentationId !== overlayPresentationId
  ) {
    return;
  }

  const shouldShowWindow = !win.isVisible();
  try {
    await applyOverlayPayload(win, payload, shouldShowWindow);
  } catch {
    recreateOverlayAfterRendererFailure(
      win,
      payload,
      state,
      transcript,
      errorMessage,
      presentationId,
    );
    return;
  }

  if (
    win !== overlayWindow ||
    win.isDestroyed() ||
    !overlayDesiredVisible ||
    presentationId !== overlayPresentationId
  ) {
    return;
  }

  if (shouldShowWindow) {
    positionOverlay(win);
    showOverlayWithoutFocus(win);
    void win.webContents.executeJavaScript('window.startOverlayShow?.();').catch(() => {
      recreateOverlayAfterRendererFailure(
        win,
        payload,
        state,
        transcript,
        errorMessage,
        presentationId,
      );
    });
  }
}

function recreateHiddenOverlayForCurrentMacSpace(): void {
  if (
    process.platform !== 'darwin' ||
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayReady ||
    overlayWindow.isVisible()
  ) {
    return;
  }

  // Hidden macOS windows can remain tied to the Space where they were created.
  const previousOverlayWindow = overlayWindow;
  destroyOverlayWindow(previousOverlayWindow);
}

function createOverlayWindow(
  state: OverlayState,
  transcript?: string,
  errorMessage?: string,
  revealOnReady = true,
): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }

  overlayReady = false;
  const payload = getOverlayPayload(state, transcript, errorMessage);
  const layout = getOverlayLayout();

  const win = new BrowserWindow({
    width: layout.width,
    height: layout.height,
    x: layout.x,
    y: layout.y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    // Bypass AppKit's visible-frame constraint, which otherwise clamps y to
    // the bottom of the menu bar even when we request the display's top edge.
    enableLargerThanScreen: true,
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
  overlayWindow = win;

  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: process.platform === 'darwin',
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  hideOverlayWindowButtons(win);

  win.once('closed', () => {
    if (overlayWindow === win) {
      overlayWindow = null;
      overlayReady = false;
    }
  });

  win.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML(state, transcript, errorMessage))}`
  );

  win.once('ready-to-show', () => {
    if (win !== overlayWindow || win.isDestroyed()) {
      return;
    }

    overlayReady = true;
    hideOverlayWindowButtons(win);

    const pending = pendingOverlayPayload;
    if (
      pending &&
      overlayDesiredVisible &&
      pending.presentationId === overlayPresentationId
    ) {
      pendingOverlayPayload = null;
      void revealOverlay(
        win,
        pending.payload,
        pending.state,
        pending.transcript,
        pending.errorMessage,
        pending.presentationId,
      );
      return;
    }

    if (revealOnReady && overlayDesiredVisible) {
      void revealOverlay(win, payload, state, transcript, errorMessage);
    }
  });
}

export function preloadOverlay(): void {
  if (process.platform === 'darwin') {
    return;
  }

  createOverlayWindow('recording', undefined, undefined, false);
}

export function setOverlayAnchorBounds(bounds: OverlayAnchorBounds | null): void {
  overlayAnchorBounds = bounds;
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) {
    return;
  }

  positionOverlay(overlayWindow);
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

export function setOverlayThemeBackground(_isDark: boolean): void {
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
  const presentationId = ++overlayPresentationId;
  overlayDesiredVisible = true;
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = null;
  }

  recreateHiddenOverlayForCurrentMacSpace();

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    pendingOverlayPayload = { payload, state, transcript, errorMessage, presentationId };
    createOverlayWindow(state, transcript, errorMessage);
    return;
  }

  if (!overlayReady) {
    pendingOverlayPayload = { payload, state, transcript, errorMessage, presentationId };
    return;
  }

  pendingOverlayPayload = null;
  void revealOverlay(overlayWindow, payload, state, transcript, errorMessage, presentationId);
}

export function hideOverlay(): void {
  const presentationId = ++overlayPresentationId;
  overlayDesiredVisible = false;
  pendingOverlayPayload = null;
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = null;
  }

  const win = overlayWindow;
  if (!win || win.isDestroyed()) {
    return;
  }
  if (!overlayReady || !win.isVisible()) {
    win.hide();
    return;
  }

  void win.webContents.executeJavaScript("document.body.classList.add('exiting');").catch(() => {
    if (win === overlayWindow && presentationId === overlayPresentationId && !win.isDestroyed()) {
      win.hide();
    }
  });
  hideOverlayTimer = setTimeout(() => {
    if (win === overlayWindow && presentationId === overlayPresentationId && !win.isDestroyed()) {
      win.hide();
    }
    hideOverlayTimer = null;
  }, OVERLAY_EXIT_MS);
}

export function destroyOverlay(): void {
  ++overlayPresentationId;
  overlayDesiredVisible = false;
  if (hideOverlayTimer) {
    clearTimeout(hideOverlayTimer);
    hideOverlayTimer = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    destroyOverlayWindow(overlayWindow);
  }
  overlayWindow = null;
  overlayReady = false;
  pendingOverlayPayload = null;
}
