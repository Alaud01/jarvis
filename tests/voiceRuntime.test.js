const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadVoiceModule(t, name) {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (request, ...args) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp/jarvis-voice-runtime-test', isPackaged: false } };
    }
    return originalLoad.call(this, request, ...args);
  });
  const modulePath = require.resolve(`../dist/main/${name}`);
  delete require.cache[modulePath];
  return require(modulePath);
}

test('a previous model-ready marker cannot select the managed Whisper runtime', t => {
  const runtime = loadVoiceModule(t, 'localVoiceModelSetup');
  const python = runtime.getManagedVoicePythonExecutable();
  const previousMarker = path.join(runtime.getManagedVoiceServiceDir(), 'parakeet-model-ready.json');
  t.mock.method(fs, 'existsSync', file => file === python || file === previousMarker);
  assert.equal(runtime.getReadyManagedVoicePythonExecutable(), null);
});

test('a completed Whisper install selects the managed runtime', t => {
  const runtime = loadVoiceModule(t, 'localVoiceModelSetup');
  const python = runtime.getManagedVoicePythonExecutable();
  const marker = path.join(runtime.getManagedVoiceServiceDir(), 'whisper-turbo-model-ready.json');
  t.mock.method(fs, 'existsSync', file => file === python || file === marker);
  assert.equal(runtime.getReadyManagedVoicePythonExecutable(), python);
});

test('service startup rejects a running previous transcription provider', async t => {
  const service = loadVoiceModule(t, 'pythonService');
  t.mock.method(global, 'fetch', async () => ({
    ok: true,
    json: async () => ({ status: 'healthy', models_loaded: true, transcription_provider: 'local-parakeet' }),
  }));
  assert.equal(await service.startPythonService(), false);
});

test('app startup reloads a reused idle Whisper service', async t => {
  const service = loadVoiceModule(t, 'pythonService');
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ status: 'healthy', models_loaded: true, transcription_provider: 'local-whisper', local_whisper_loaded: false }),
    };
  });
  assert.equal(await service.startPythonService(), true);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/health$/);
  assert.match(requests[1].url, /\/warmup$/);
  assert.equal(requests[1].options.method, 'POST');
});

test('warmup requests are sent directly to the voice service', async t => {
  const service = loadVoiceModule(t, 'pythonService');
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true };
  });
  await service.warmupVoiceModel();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/warmup$/);
  assert.equal(calls[0].options.method, 'POST');
});

test('recording warms the model in parallel and reveals the overlay only when capture is ready', async t => {
  const events = [];
  let releaseMicrophone;
  const microphoneReady = new Promise(resolve => { releaseMicrophone = resolve; });
  let releaseTarget;
  const targetReady = new Promise(resolve => { releaseTarget = resolve; });
  const originalLoad = Module._load;
  const noOp = () => {};
  const mocks = {
    electron: { ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } },
    './pythonService': {
      warmupVoiceModel: () => { events.push('warmup'); return new Promise(() => {}); },
    },
    './audioRecorder': { startRecording: async () => { events.push('recording'); await microphoneReady; return { success: true }; } },
    './hotkeyManager': {},
    './textInserter': { getFrontmostApp: async () => { await targetReady; return { pid: 1, name: 'Mail', bundleId: 'com.apple.mail' }; } },
    './overlayWindow': { setOverlayAnchorBounds: noOp, showOverlay: state => events.push(`overlay:${state}`) },
    './voiceContext': { captureVoiceContext: async () => ({}) },
  };
  t.mock.method(Module, '_load', function (request, ...args) {
    if (mocks[request]) return mocks[request];
    return originalLoad.call(this, request, ...args);
  });
  const modulePath = require.resolve('../dist/main/voiceFlow');
  delete require.cache[modulePath];
  const flow = require(modulePath);
  const starting = flow.startVoiceRecordingFromUI();
  assert.deepEqual(events, ['warmup', 'recording']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['warmup', 'recording'], 'microphone starts while target capture is pending');
  releaseTarget();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['warmup', 'recording'], 'Listening must wait for microphone readiness too');
  releaseMicrophone();
  assert.equal((await starting).success, true);
  assert.deepEqual(events, ['warmup', 'recording', 'overlay:recording']);
});

test('stopping ends microphone capture while context is still pending, then uses that context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  let releaseContext;
  const context = { destination: 'jarvis', app: null };
  const contextReady = new Promise(resolve => { releaseContext = resolve; });
  const originalLoad = Module._load;
  const noOp = () => {};
  const mocks = {
    electron: { ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } },
    './pythonService': {
      warmupVoiceModel: async () => {},
      processVoiceFlow: async (_audio, capturedContext) => {
        assert.equal(capturedContext, context);
        events.push('process');
        return { success: true, text: 'Jarvis hello' };
      },
    },
    './audioRecorder': {
      startRecording: async () => ({ success: true }),
      stopRecording: async () => {
        events.push('stop');
        return { durationMs: 1000, byteLength: 100, peak: 0.5, rms: 0.1 };
      },
    },
    './hotkeyManager': {},
    './textInserter': { getFrontmostApp: async () => ({ pid: process.pid, name: 'Jarvis' }) },
    './overlayWindow': { setOverlayAnchorBounds: noOp, showOverlay: noOp, hideOverlay: noOp },
    './voiceContext': { captureVoiceContext: () => contextReady },
  };
  t.mock.method(Module, '_load', function (request, ...args) {
    if (mocks[request]) return mocks[request];
    return originalLoad.call(this, request, ...args);
  });
  const modulePath = require.resolve('../dist/main/voiceFlow');
  delete require.cache[modulePath];
  const flow = require(modulePath);
  assert.equal((await flow.startVoiceRecordingFromUI()).success, true);
  const stopping = flow.stopVoiceRecordingFromUI();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['stop'], 'stop does not wait for context, and upload waits for it');
  releaseContext(context);
  for (let step = 0; step < 4; step++) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  assert.equal((await stopping).success, true);
  assert.deepEqual(events, ['stop', 'process']);
  assert.equal(flow.getVoiceFlowState(), 'idle');
});

test('dictation uploads immediately without a health-check round trip and carries its timing ID', async t => {
  const service = loadVoiceModule(t, 'pythonService');
  const requests = [];
  const logs = [];
  t.mock.method(console, 'warn', line => logs.push(line));
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      text: async () => JSON.stringify({ text: 'Hello.', success: true, diagnostics: { request_id: 'timing-test' } }),
    };
  });
  const result = await service.processVoiceFlow(Buffer.from('audio'), undefined, 'timing-test');
  assert.equal(result.success, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/process-flow$/);
  assert.equal(requests[0].options.headers['X-Voice-Request-Id'], 'timing-test');
  assert.equal(result.diagnostics.request_id, 'timing-test');
  assert.match(logs[0], /^\[VoiceTiming timing-test\] transport .*roundTripTotalMs=\d+ms$/);
});
