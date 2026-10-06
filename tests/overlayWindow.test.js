const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const vm = require('node:vm');

const waitForAsyncWork = () => new Promise(resolve => setImmediate(resolve));

test('overlay lifecycle ignores stale windows and cancels stale hides', async t => {
  const timingLogs = [];
  t.mock.method(console, 'warn', line => timingLogs.push(line));
  const originalLoad = Module._load;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  let display = {
    bounds: { x: 1440, y: -200, width: 1512, height: 982 },
    workArea: { x: 1440, y: -162, width: 1512, height: 944 },
    internal: true,
  };

  class FakeWebContents {
    constructor() {
      this.scripts = [];
      this.url = '';
    }

    loadURL(url) {
      this.url = url;
      return Promise.resolve();
    }

    executeJavaScript(script) {
      this.scripts.push(script);
      if (this.failPresentation && script.includes('window.revealOverlay(')) {
        this.failPresentation = false;
        return Promise.reject(new Error('renderer lost'));
      }
      return Promise.resolve();
    }
  }

  class FakeBrowserWindow extends EventEmitter {
    static instances = [];

    static getFocusedWindow() {
      return null;
    }

    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.bounds = {
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height,
      };
      this.destroyed = false;
      this.visible = false;
      FakeBrowserWindow.instances.push(this);
    }

    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setWindowButtonVisibility() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
    }
  }

  Object.defineProperty(process, 'platform', { value: 'darwin' });
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: FakeBrowserWindow,
        screen: {
          getCursorScreenPoint: () => ({ x: 100, y: 100 }),
          getDisplayNearestPoint: () => display,
          getDisplayMatching: () => display,
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../dist/main/overlayWindow');
  delete require.cache[modulePath];
  const overlay = require(modulePath);

  t.after(() => {
    overlay.destroyOverlay();
    delete require.cache[modulePath];
    Module._load = originalLoad;
    Object.defineProperty(process, 'platform', platformDescriptor);
  });

  const timingContext = { requestId: 'overlay-test', startedAt: performance.now() };
  overlay.showOverlay('starting', undefined, undefined, timingContext);
  overlay.showOverlay('processing', undefined, undefined, timingContext);

  assert.equal(FakeBrowserWindow.instances.length, 1, 'a loading window must not be recreated');
  const firstWindow = FakeBrowserWindow.instances[0];
  assert.equal(firstWindow.options.backgroundColor, '#00000000');
  assert.equal(firstWindow.options.focusable, false);
  assert.equal(firstWindow.options.hiddenInMissionControl, true);
  assert.equal(firstWindow.options.webPreferences.backgroundThrottling, false);
  assert.equal(firstWindow.bounds.y, -200, 'attach to the display edge, not its work area');
  assert.equal(firstWindow.bounds.x + firstWindow.bounds.width / 2, 2196);

  const html = decodeURIComponent(firstWindow.webContents.url.split(',')[1]);
  assert.match(html, /<body class="idle">/);
  assert.match(html, /body\.idle \.overlay \{\s*display: none;/);
  assert.match(html, /body\.exiting/);
  assert.match(html, /@keyframes label-enter/);
  assert.match(html, /@keyframes label-leave/);
  assert.match(html, /@keyframes spinner-stage-change/);
  assert.match(html, /previousState !== payload\.state/,
    'every actual status change must restart the coordinated transition');

  // Execute the actual renderer lifecycle, including a canceled dismissal.
  const timers = new Map();
  let timerId = 0;
  const node = (className = '') => {
    const value = { className, textContent: '', style: { setProperty() {} } };
    value.classList = {
      add: (...names) => { value.className = [...new Set([...value.className.split(' '), ...names])].join(' ').trim(); },
      remove: (...names) => { value.className = value.className.split(' ').filter(name => !names.includes(name)).join(' '); },
      contains: name => value.className.split(' ').includes(name),
    };
    return value;
  };
  const body = node('idle');
  const pill = node('overlay');
  const spinner = node('pixel-spinner');
  const initialLabel = node('label');
  const labels = [initialLabel];
  const stack = {
    querySelectorAll: () => [...labels],
    appendChild: item => { labels.push(item); item.parentNode = stack; },
    removeChild: item => { labels.splice(labels.indexOf(item), 1); item.parentNode = null; },
  };
  initialLabel.parentNode = stack;
  const renderer = vm.createContext({
    window: {},
    document: {
      body, querySelector: () => pill, createElement: () => node(),
      getElementById: id => ({ spinner, 'label-stack': stack, label: initialLabel })[id],
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], renderer);
  renderer.window.revealOverlay({ state: 'starting', label: 'Starting microphone...', stage: 'processing', width: 300 });
  assert.equal(body.classList.contains('idle'), false);
  assert.equal(initialLabel.textContent, 'Starting microphone...');
  renderer.window.dismissOverlay();
  renderer.window.revealOverlay({ state: 'recording', label: 'Listening...', stage: 'recording', width: 300 });
  for (const callback of timers.values()) callback();
  timers.clear();
  assert.equal(body.classList.contains('idle'), false, 'an old dismissal cannot hide a new recording');
  assert.equal(body.classList.contains('exiting'), false);
  assert.equal(initialLabel.textContent, 'Listening...');
  renderer.window.dismissOverlay();
  for (const callback of timers.values()) callback();
  assert.equal(body.classList.contains('idle'), true, 'dismissed content stops painting');

  firstWindow.emit('ready-to-show');
  await waitForAsyncWork();
  await waitForAsyncWork();
  assert.equal(firstWindow.visible, true);
  assert.equal(timingLogs.length, 1, 'only the current presentation should acknowledge a renderer frame');
  assert.match(timingLogs[0], /^\[VoiceTiming overlay-test\] overlay \(processing; renderer frame acknowledged\)/);
  assert.match(timingLogs[0], /phaseStartToRendererFrameMs=\d+ms/);
  assert.match(firstWindow.webContents.scripts.join('\n'), /window\.revealOverlay\(\{"state":"processing"/);
  assert.match(firstWindow.webContents.scripts.join('\n'), /--top-reserve', '40px'/);
  overlay.showOverlay('starting');
  await waitForAsyncWork();
  assert.match(firstWindow.webContents.scripts.at(-1), /Starting microphone\.\.\./);
  const initialBounds = { ...firstWindow.bounds };

  overlay.hideOverlay();
  overlay.showOverlay('complete', 'Hello');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(firstWindow.visible, true, 'an old hide timer must not hide a newer presentation');
  assert.deepEqual(firstWindow.bounds, initialBounds, 'status changes morph within fixed window bounds');

  overlay.showOverlay('error', undefined, 'No speech detected (duration: 0ms, min: 250ms)');
  await waitForAsyncWork();
  assert.match(
    firstWindow.webContents.scripts.join('\n'),
    /"label":"No speech detected","stage":"error","width":300/,
    'VAD diagnostics must not widen the no-speech status',
  );

  display = {
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 24, width: 1920, height: 1056 },
    internal: false,
  };
  overlay.setOverlayAnchorBounds(display.bounds);
  assert.equal(firstWindow.bounds.x + firstWindow.bounds.width / 2, -960);
  assert.equal(firstWindow.bounds.y, 0);
  assert.match(firstWindow.webContents.scripts.join('\n'), /--top-reserve', '0px'/);
  assert.equal(firstWindow.bounds.height, initialBounds.height - 40,
    'external displays omit the built-in display cutout clearance');

  overlay.hideOverlay();
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(firstWindow.visible, true, 'idle macOS overlay remains shown and transparent');
  assert.match(firstWindow.webContents.scripts.at(-1), /window\.dismissOverlay\(\)/);

  const scriptsBeforeReshow = firstWindow.webContents.scripts.length;
  overlay.showOverlay('recording');
  await waitForAsyncWork();
  assert.equal(FakeBrowserWindow.instances.length, 1, 'reuse the renderer on later recordings');
  assert.equal(firstWindow.destroyed, false);
  assert.match(firstWindow.webContents.scripts.slice(scriptsBeforeReshow).join('\n'),
    /window\.revealOverlay\(\{"state":"recording"/);

  firstWindow.hide();
  overlay.hideOverlay();
  overlay.showOverlay('recording');
  assert.equal(firstWindow.destroyed, true, 'replace a macOS window that was externally hidden');
  assert.equal(FakeBrowserWindow.instances.length, 2);

  const secondWindow = FakeBrowserWindow.instances[1];
  overlay.destroyOverlay();
  overlay.showOverlay('recording');
  const thirdWindow = FakeBrowserWindow.instances[2];

  secondWindow.emit('ready-to-show');
  await waitForAsyncWork();
  assert.equal(thirdWindow.visible, false, 'a stale ready event must not reveal the current window');

  thirdWindow.emit('ready-to-show');
  await waitForAsyncWork();
  await waitForAsyncWork();
  assert.equal(thirdWindow.visible, true);

  thirdWindow.webContents.failPresentation = true;
  overlay.showOverlay('processing');
  await waitForAsyncWork();
  assert.equal(thirdWindow.destroyed, true, 'replace a broken overlay renderer');
  const replacement = FakeBrowserWindow.instances[3];
  replacement.emit('ready-to-show');
  await waitForAsyncWork();
  assert.equal(replacement.visible, true);
  assert.match(replacement.webContents.scripts.join('\n'), /window\.revealOverlay\(\{"state":"processing"/);
});
