const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

const waitForAsyncWork = () => new Promise(resolve => setImmediate(resolve));

test('overlay lifecycle ignores stale windows and cancels stale hides', async t => {
  const originalLoad = Module._load;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

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
          getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 1440, height: 900 },
            workAreaSize: { width: 1440, height: 900 },
          }),
          getDisplayMatching: () => ({
            workArea: { x: 0, y: 0, width: 1440, height: 900 },
            workAreaSize: { width: 1440, height: 900 },
          }),
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

  overlay.showOverlay('recording');
  overlay.showOverlay('processing');

  assert.equal(FakeBrowserWindow.instances.length, 1, 'a loading window must not be recreated');
  const firstWindow = FakeBrowserWindow.instances[0];
  assert.equal(firstWindow.options.backgroundColor, '#00000000');

  const html = decodeURIComponent(firstWindow.webContents.url.split(',')[1]);
  assert.match(html, /<body class="preparing">/);
  assert.match(html, /body\.exiting/);

  firstWindow.emit('ready-to-show');
  await waitForAsyncWork();
  await waitForAsyncWork();
  assert.equal(firstWindow.visible, true);
  assert.match(firstWindow.webContents.scripts.join('\n'), /prepareOverlayShow/);
  assert.match(firstWindow.webContents.scripts.join('\n'), /startOverlayShow/);

  overlay.hideOverlay();
  overlay.showOverlay('complete', 'Hello');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(firstWindow.visible, true, 'an old hide timer must not hide a newer presentation');

  overlay.hideOverlay();
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(firstWindow.visible, false);

  overlay.showOverlay('recording');
  assert.equal(firstWindow.destroyed, true, 'a hidden macOS window should be force-destroyed');
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
});
