const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const vm = require('node:vm');
const {
  isMicrophoneUnavailableErrorName,
  NO_MIC_DETECTED_MESSAGE,
} = require('../dist/shared/audioCapture');

test('normalizes unavailable microphone capture failures', () => {
  for (const errorName of [
    'AbortError',
    'DevicesNotFoundError',
    'NotFoundError',
    'NotReadableError',
    'TrackStartError',
  ]) {
    assert.equal(isMicrophoneUnavailableErrorName(errorName), true, errorName);
  }

  assert.equal(NO_MIC_DETECTED_MESSAGE, 'No mic detected');
});

test('does not treat permission failures as a missing microphone', () => {
  assert.equal(isMicrophoneUnavailableErrorName('NotAllowedError'), false);
  assert.equal(isMicrophoneUnavailableErrorName('SecurityError'), false);
  assert.equal(isMicrophoneUnavailableErrorName(undefined), false);
});

test('reports an unavailable macOS capture device as no mic detected', async t => {
  const originalLoad = Module._load;
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: class FakeBrowserWindow {},
        ipcMain: { on() {} },
        systemPreferences: {
          getMediaAccessStatus: () => 'granted',
          askForMediaAccess: async () => true,
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const modulePath = require.resolve('../dist/main/audioRecorder');
  delete require.cache[modulePath];
  const audioRecorder = require(modulePath);

  t.after(() => {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  });

  audioRecorder.setMainWindow({
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => ({
        success: false,
        error: 'Could not start audio source',
        errorName: 'NotReadableError',
      }),
    },
  });

  assert.deepEqual(await audioRecorder.startRecording(), {
    success: false,
    error: 'No mic detected',
  });
});

test('checks the lid even when getUserMedia would return a live stream', async t => {
  const originalLoad = Module._load;
  let lidClosed = true;
  let enumerateCalls = 0;
  Module._load = function(request, parent, isMain) {
    if (request === './macLidState') return { isMacLidClosed: async () => lidClosed };
    if (request === 'electron') return {
      ipcMain: { on() {} },
      systemPreferences: { getMediaAccessStatus: () => 'granted' },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve('../dist/main/audioRecorder');
  delete require.cache[modulePath];
  const recorder = require(modulePath);
  t.after(() => {
    delete require.cache[modulePath];
    Module._load = originalLoad;
  });

  async function attempt(defaultLabel, trackLabel, repeat = false) {
    let blobUrls = 0;
    const loadedModules = [];
    let opened = false;
    let stopped = false;
    const track = { label: trackLabel, readyState: 'live', stop() { stopped = true; } };
    class AudioContext {
      state = 'running';
      audioWorklet = { addModule: async url => loadedModules.push(url) };
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      close() {}
    }
    const context = vm.createContext({
      navigator: { mediaDevices: {
        enumerateDevices: async () => (enumerateCalls++, [{ kind: 'audioinput', deviceId: 'default', label: defaultLabel }]),
        getUserMedia: async () => {
          opened = true;
          return { getAudioTracks: () => [track], getTracks: () => [track] };
        },
      } },
      window: { AudioContext },
      AudioWorkletNode: class { port = {}; connect() {} disconnect() {} },
      URL: { createObjectURL: () => `blob:test-${++blobUrls}` },
      Blob, performance,
    });
    recorder.setMainWindow({
      isDestroyed: () => false,
      webContents: { executeJavaScript: script => vm.runInContext(script, context) },
    });
    const result = await recorder.startRecording();
    await recorder.cleanupAudioCapture();
    if (repeat) {
      assert.equal(result.success, true);
      assert.equal((await recorder.startRecording()).success, true);
      await recorder.cleanupAudioCapture();
      assert.equal(blobUrls, 1, 'repeat recordings reuse the module URL');
      assert.deepEqual(loadedModules, ['blob:test-1', 'blob:test-1'], 'each new context loads the cached module');
    }
    return { result, opened, stopped };
  }

  assert.deepEqual(await attempt('Default - MacBook Pro Microphone', 'MacBook Pro Microphone'), {
    result: { success: false, error: 'No mic detected' }, opened: false, stopped: false,
  });
  assert.deepEqual(await attempt('Default', 'MacBook Pro Microphone'), {
    result: { success: false, error: 'No mic detected' }, opened: true, stopped: true,
  });
  assert.equal((await attempt('Default - USB Microphone', 'USB Microphone')).result.success, true);
  lidClosed = false;
  enumerateCalls = 0;
  assert.equal((await attempt('Default - MacBook Pro Microphone', 'MacBook Pro Microphone')).result.success, true);
  assert.equal(enumerateCalls, 0, 'an open lid must not wait for device enumeration');
  await attempt('Default - USB Microphone', 'USB Microphone', true);
});
