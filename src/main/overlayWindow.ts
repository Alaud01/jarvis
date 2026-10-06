import { BrowserWindow, screen } from 'electron';
import { logVoiceTiming } from './voiceTiming';

type OverlayTimingContext = { requestId: string; startedAt: number };
let overlayTimingContext: OverlayTimingContext | undefined;
let overlayRequestedAt = 0;

type OverlayAnchorBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

let overlayWindow: BrowserWindow | null = null;
let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;
let overlayReady = false;
// Whether the pill is on screen (or entering). On macOS the window itself stays
// shown and transparent; only its contents are revealed and dismissed.
let overlayContentVisible = false;
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
const OVERLAY_ENTER_MS = 300;
const OVERLAY_EXIT_MS = 220;
const OVERLAY_WIDTH_MS = 260;
const OVERLAY_LABEL_MS = 200;
const PIXEL_MORPH_MS = 280;
const PIXEL_LOOP_MS = 1200;

const OVERLAY_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

type OverlayState = 'recording' | 'processing' | 'complete' | 'error';
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
  stage: OverlayState;
  width: number;
} {
  const label = getOverlayDisplayLabel(state, transcript, errorMessage);
  return {
    state,
    label,
    stage: state,
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

type PixelStageColors = { from: string; to: string };

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
  return { from, to };
}

// Each status is data for the same grid; transitions share one phase and loop.
const STATE_CONFIG: Record<OverlayState, {
  label: string;
  colors: PixelStageColors;
  opacities: PixelOpacityMap;
}> = {
  recording: { label: 'Listening...', colors: { from: '#ff416c', to: '#ff4b2b' }, opacities: RECORDING_OPACITIES },
  processing: { label: 'Processing...', colors: buildPixelStageColors(48, 12), opacities: PROCESSING_OPACITIES },
  complete: { label: 'Transcribed', colors: buildPixelStageColors(145, -20), opacities: COMPLETE_OPACITIES },
  error: { label: 'Error', colors: buildPixelStageColors(0), opacities: ERROR_OPACITIES },
};

const PIXEL_STATES = Object.fromEntries(Object.entries(STATE_CONFIG).map(([state, config]) => {
  const rgb = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return [state, { opacities: config.opacities, from: rgb(config.colors.from), to: rgb(config.colors.to) }];
}));

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
        transform ${OVERLAY_ENTER_MS}ms ${OVERLAY_EASE},
        opacity ${OVERLAY_ENTER_MS}ms ease;
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
      transform: translateY(-${OVERLAY_HEIGHT}px) scaleX(0.96);
      transition: none;
    }
    body.exiting .overlay {
      opacity: 0;
      transform: translateY(-${OVERLAY_HEIGHT}px) scaleX(0.96);
      transition-duration: ${OVERLAY_EXIT_MS}ms;
    }
    /* Resting state of the persistent window: nothing painted, no spinner animations running. */
    body.idle .overlay {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      .overlay, .overlay-content, .label { transition: none !important; animation: none !important; }
      body.preparing .overlay, body.exiting .overlay { transform: none; }
    }
    .overlay-content {
      display: flex;
      align-items: center;
      gap: ${OVERLAY_CONTENT_GAP}px;
      width: var(--content-width);
      min-width: 0;
      max-width: 100%;
      transition: width ${OVERLAY_WIDTH_MS}ms ${OVERLAY_EASE};
    }
    .pixel-spinner {
      display: inline-grid;
      grid-template-columns: repeat(4, 5px);
      flex-shrink: 0;
    }
    .pixel-spinner .cell {
      width: 5px;
      height: 5px;
      opacity: 0;
      background: linear-gradient(135deg, var(--pixel-from), var(--pixel-to));
      box-shadow: 0 0 4px var(--pixel-from), 0 0 10px rgba(var(--pixel-glow), 0.5), 0 0 19px rgba(var(--pixel-glow), 0.33);
      will-change: opacity;
    }
    @keyframes label-enter {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes label-leave {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(-4px); }
    }
    .label, .label-measure {
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
      will-change: opacity, transform;
    }
    .label-measure {
      position: absolute;
      visibility: hidden;
      width: max-content;
      pointer-events: none;
    }
    .label-stack {
      flex: 1;
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
<body class="idle">
  <span class="label-measure" id="label-measure" aria-hidden="true"></span>
  <div class="overlay" role="status" aria-live="polite">
    <div class="overlay-content">
      <div class="pixel-spinner" id="spinner">${PIXEL_SPINNER_CELLS}</div>
      <div class="label-stack" id="label-stack">
        <div class="label" id="label">${escapeHtml(payload.label)}</div>
      </div>
    </div>
  </div>
  <script>
    (function() {
      var revealFrame = null;
      var idleTimer = null;
      var spinner = document.getElementById('spinner');
      var labelStack = document.getElementById('label-stack');
      var label = document.getElementById('label');
      var labelMeasure = document.getElementById('label-measure');

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
      var pixelStates = ${JSON.stringify(PIXEL_STATES)};
      var pixelStages = Object.keys(pixelStates);
      var cells = Array.prototype.slice.call(spinner.children);
      var pixelStage = null;
      var weights = pixelStages.map(function() { return 0; });
      var fromWeights = null;
      var morphStartedAt = 0;
      var pixelFrame = null;
      var pixelsActive = false;
      var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

      function updateWeights(now) {
        if (!fromWeights) return;
        var t = Math.min(1, (now - morphStartedAt) / ${PIXEL_MORPH_MS});
        var blend = t * t * (3 - 2 * t);
        weights = fromWeights.map(function(weight, index) {
          return weight + ((pixelStages[index] === pixelStage ? 1 : 0) - weight) * blend;
        });
        if (t === 1) fromWeights = null;
      }
      function paintPixels(now) {
        updateWeights(now);
        var phase = reducedMotion.matches ? 0 : (now % ${PIXEL_LOOP_MS}) / ${PIXEL_LOOP_MS};
        var opacity = cells.map(function() { return 0; });
        var from = [0, 0, 0], to = [0, 0, 0];
        pixelStages.forEach(function(stage, index) {
          var weight = weights[index];
          if (!weight) return;
          var pattern = pixelStates[stage];
          cells.forEach(function(cell, cellIndex) {
            var stops = pattern.opacities[cellIndex];
            if (!stops) return;
            var position = phase * stops.length;
            var step = Math.floor(position);
            var value = stops[step] + (stops[(step + 1) % stops.length] - stops[step]) * (position - step);
            opacity[cellIndex] += value * weight;
          });
          from.forEach(function(_, channel) {
            from[channel] += pattern.from[channel] * weight;
            to[channel] += pattern.to[channel] * weight;
          });
        });
        spinner.style.setProperty('--pixel-from', 'rgb(' + from.join(',') + ')');
        spinner.style.setProperty('--pixel-to', 'rgb(' + to.join(',') + ')');
        spinner.style.setProperty('--pixel-glow', from.join(','));
        cells.forEach(function(cell, index) { cell.style.opacity = opacity[index]; });
      }
      function animatePixels(now) {
        pixelFrame = null;
        if (!pixelsActive) return;
        paintPixels(now);
        if (!reducedMotion.matches) pixelFrame = requestAnimationFrame(animatePixels);
      }
      function startPixels() {
        pixelsActive = true;
        if (pixelFrame === null) animatePixels(performance.now());
      }
      function stopPixels() {
        pixelsActive = false;
        if (pixelFrame !== null) cancelAnimationFrame(pixelFrame);
        pixelFrame = null;
      }
      function setStage(stage, reset) {
        if (stage === pixelStage && !reset) return;
        var now = performance.now();
        updateWeights(now);
        fromWeights = reset || reducedMotion.matches ? null : weights.slice();
        morphStartedAt = now;
        pixelStage = stage;
        if (!fromWeights) {
          weights = pixelStages.map(function(value) { return value === stage ? 1 : 0; });
          paintPixels(now);
        }
      }
      reducedMotion.addEventListener('change', function() {
        setStage(pixelStage, true);
        stopPixels();
        if (!document.body.classList.contains('idle')) startPixels();
      });
      function setLayout(payload) {
        labelMeasure.textContent = payload.label;
        document.body.style.setProperty('--surface-width', payload.width + 'px');
        // The outgoing label cannot resize this row when it is later removed.
        var width = Math.min(payload.width - ${OVERLAY_X_PADDING * 2}, Math.ceil(labelMeasure.getBoundingClientRect().width) + ${PIXEL_SPINNER_SIZE + OVERLAY_CONTENT_GAP});
        document.body.style.setProperty('--content-width', width + 'px');
      }
      function applyPayload(payload) {
        setLayout(payload);
        setLabel(payload.label);
        setStage(payload.stage);
      }
      function resetToPayload(payload) {
        Array.prototype.slice.call(labelStack.querySelectorAll('.label')).forEach(function(node) {
          if (node !== label && node.parentNode) node.parentNode.removeChild(node);
        });
        label.className = 'label';
        label.textContent = payload.label;
        setStage(payload.stage, true);
        setLayout(payload);
      }
      window.revealOverlay = function(payload) {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (revealFrame !== null) {
          cancelAnimationFrame(revealFrame);
          revealFrame = null;
        }
        var wasIdle = document.body.classList.contains('idle');
        if (wasIdle) {
          document.body.classList.add('preparing');
          resetToPayload(payload);
        } else {
          window.updateOverlayState(payload);
        }
        document.body.classList.remove('idle', 'exiting');
        startPixels();
        // An interrupted dismissal reverses from its current position. Only a
        // fully idle surface starts offscreen; status changes never transform it.
        if (wasIdle || document.body.classList.contains('preparing')) {
          void document.body.offsetWidth;
          revealFrame = requestAnimationFrame(function() {
            revealFrame = null;
            document.body.classList.remove('preparing');
          });
        }
      };
      window.dismissOverlay = function() {
        if (revealFrame !== null) {
          cancelAnimationFrame(revealFrame);
          revealFrame = null;
        }
        document.body.classList.add('exiting');
        document.body.classList.remove('preparing');
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function() {
          idleTimer = null;
          document.body.classList.remove('exiting');
          document.body.classList.add('idle');
          stopPixels();
        }, ${OVERLAY_EXIT_MS});
      };
      window.updateOverlayState = applyPayload;
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

// On macOS the overlay window is created once and kept shown (transparent and
// click-through, on every Space); showing the pill is then a single renderer
// call instead of a new window, renderer process and page load. A shown window
// also follows Space switches, which hidden macOS windows do not.
function keepsOverlayWindowShown(): boolean {
  return process.platform === 'darwin';
}

async function applyOverlayPayload(
  win: BrowserWindow,
  payload: ReturnType<typeof getOverlayPayload>,
  entering: boolean,
): Promise<void> {
  if (win !== overlayWindow || win.isDestroyed()) {
    return;
  }

  hideOverlayWindowButtons(win);
  await win.webContents.executeJavaScript(`
    if (!window.updateOverlayState || !window.revealOverlay) {
      throw new Error('Overlay renderer is not ready');
    }
    if (${entering}) {
      window.revealOverlay(${JSON.stringify(payload)});
    } else {
      window.updateOverlayState(${JSON.stringify(payload)});
    }
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  `);
}

function destroyOverlayWindow(win: BrowserWindow): void {
  if (win === overlayWindow) {
    overlayWindow = null;
    overlayReady = false;
    overlayContentVisible = false;
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
  createOverlayWindow();
}

async function presentOverlay(
  win: BrowserWindow,
  payload: ReturnType<typeof getOverlayPayload>,
  state: OverlayState,
  transcript?: string,
  errorMessage?: string,
  presentationId = overlayPresentationId,
): Promise<void> {
  if (
    win !== overlayWindow || win.isDestroyed() || !overlayDesiredVisible
    || presentationId !== overlayPresentationId
  ) return;

  const entering = !overlayContentVisible || !win.isVisible();
  const timingContext = overlayTimingContext;
  const requestedAt = overlayRequestedAt;
  overlayContentVisible = true;
  if (entering) {
    // The persistent page is idle and paints nothing until its reveal call.
    positionOverlay(win);
    if (!win.isVisible()) showOverlayWithoutFocus(win);
  }
  try {
    await applyOverlayPayload(win, payload, entering);
    if (timingContext && win === overlayWindow && !win.isDestroyed()
      && overlayDesiredVisible && presentationId === overlayPresentationId) {
      logVoiceTiming(timingContext.requestId, `overlay (${state}; renderer frame acknowledged)`, {
        requestToRendererFrameMs: performance.now() - requestedAt,
        phaseStartToRendererFrameMs: performance.now() - timingContext.startedAt,
      });
    }
  } catch {
    recreateOverlayAfterRendererFailure(win, payload, state, transcript, errorMessage, presentationId);
  }
}

function recreateHiddenOverlayForCurrentMacSpace(): boolean {
  if (
    process.platform !== 'darwin' ||
    !overlayWindow ||
    overlayWindow.isDestroyed() ||
    !overlayReady ||
    overlayWindow.isVisible()
  ) {
    return false;
  }

  // The persistent window should always be shown; if something hid it (e.g. the
  // app was hidden), it may be tied to the Space it was hidden on.
  const previousOverlayWindow = overlayWindow;
  destroyOverlayWindow(previousOverlayWindow);
  return true;
}

function createOverlayWindow(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return;
  }

  overlayReady = false;
  overlayContentVisible = false;
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
    hiddenInMissionControl: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Keep the idle page's timers and animations at full speed so a reveal
      // starts on the very next frame.
      backgroundThrottling: false,
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
      overlayContentVisible = false;
    }
  });

  win.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHTML('recording'))}`
  );

  win.once('ready-to-show', () => {
    if (win !== overlayWindow || win.isDestroyed()) {
      return;
    }

    overlayReady = true;
    hideOverlayWindowButtons(win);

    if (keepsOverlayWindowShown()) {
      // The page starts idle, so the shown window paints nothing.
      positionOverlay(win);
      showOverlayWithoutFocus(win);
    }

    const pending = pendingOverlayPayload;
    if (
      pending &&
      overlayDesiredVisible &&
      pending.presentationId === overlayPresentationId
    ) {
      pendingOverlayPayload = null;
      void presentOverlay(
        win,
        pending.payload,
        pending.state,
        pending.transcript,
        pending.errorMessage,
        pending.presentationId,
      );
    }
  });
}

export function preloadOverlay(): void {
  createOverlayWindow();
}

export function setOverlayAnchorBounds(bounds: OverlayAnchorBounds | null): void {
  overlayAnchorBounds = bounds;
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayContentVisible) {
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
    // The overlay may still be loading; its HTML already embeds the theme colors.
  });
}

export function showOverlay(
  state: OverlayState, transcript?: string, errorMessage?: string, timingContext?: OverlayTimingContext,
): void {
  overlayTimingContext = timingContext;
  overlayRequestedAt = performance.now();
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
    createOverlayWindow();
    return;
  }

  if (!overlayReady) {
    pendingOverlayPayload = { payload, state, transcript, errorMessage, presentationId };
    return;
  }

  pendingOverlayPayload = null;
  void presentOverlay(overlayWindow, payload, state, transcript, errorMessage, presentationId);
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
  const keepShown = keepsOverlayWindowShown();
  if (!overlayReady || !overlayContentVisible) {
    if (!keepShown) win.hide();
    return;
  }

  overlayContentVisible = false;
  void win.webContents.executeJavaScript('window.dismissOverlay();').catch(() => {
    if (win !== overlayWindow || presentationId !== overlayPresentationId || win.isDestroyed()) {
      return;
    }
    if (keepShown) {
      // The renderer is broken; replace it so the next show starts from a working page.
      destroyOverlayWindow(win);
      createOverlayWindow();
    } else {
      win.hide();
    }
  });
  if (keepShown) {
    return;
  }
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
  overlayContentVisible = false;
  pendingOverlayPayload = null;
}
