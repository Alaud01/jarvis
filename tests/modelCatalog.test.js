const test = require('node:test');
const assert = require('node:assert/strict');
const { ModelCatalog } = require('../dist/main/providers/modelCatalog');
const { OpenCodeGoProvider } = require('../dist/main/providers/opencode-go');

test('a stalled optional reasoning catalog cannot discard a successful Go model list', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reasoningSignal;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://models.dev/')) {
      reasoningSignal = options.signal;
      return new Promise(() => {});
    }
    return Response.json({ data: [{ id: 'gpt-6-luna' }] });
  });
  const provider = new OpenCodeGoProvider('test-key');
  const catalog = new ModelCatalog();
  const pending = catalog.refresh(provider);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1_500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(catalog.snapshot([provider]).models[0]?.id, 'gpt-6-luna');
  assert.equal(reasoningSignal.aborted, true);
  t.mock.timers.tick(5_000);
  const models = await pending;
  assert.equal(models[0].id, 'gpt-6-luna');
  assert.deepEqual(models[0].reasoningEfforts.map(option => option.value), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('chat lookup never waits for discovery and refresh requests are deduplicated', async () => {
  let calls = 0;
  let release;
  const provider = { id: 'local', fetchModels: () => { calls++; return new Promise(resolve => { release = resolve; }); } };
  const catalog = new ModelCatalog();
  assert.equal(catalog.get(provider, 'model'), undefined);
  const first = catalog.refresh(provider);
  const second = catalog.refresh(provider, true);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release([{ id: 'model', provider: 'local', contextLength: 8192 }]);
  await first;
  assert.equal(catalog.get(provider, 'model').contextLength, 8192);
  assert.equal(calls, 1);
});

test('metadata is scoped by provider even when model ids collide', async () => {
  const catalog = new ModelCatalog();
  const left = { id: 'a', fetchModels: async () => [{ id: 'same', contextLength: 4096 }] };
  const right = { id: 'b', fetchModels: async () => [{ id: 'same', contextLength: 65536 }] };
  await Promise.all([catalog.refresh(left), catalog.refresh(right)]);
  assert.equal(catalog.get(left, 'same').contextLength, 4096);
  assert.equal(catalog.get(right, 'same').contextLength, 65536);
});

test('timed out discovery aborts and preserves cached metadata without accepting late results', async () => {
  const catalog = new ModelCatalog(5);
  let signal;
  let release;
  const provider = { id: 'remote', fetchModels: async () => [{ id: 'model', contextLength: 8192 }] };
  await catalog.refresh(provider);
  provider.fetchModels = value => { signal = value; return new Promise(resolve => { release = resolve; }); };
  const result = await catalog.refresh(provider, true);
  assert.equal(signal.aborted, true);
  assert.equal(result[0].contextLength, 8192);
  release([{ id: 'model', contextLength: 1 }]);
  await Promise.resolve();
  assert.equal(catalog.get(provider, 'model').contextLength, 8192);
});

const model = (id, provider = 'ollama') => ({ id, name: id, provider });
const { OllamaProvider } = require('../dist/main/providers/ollama');

test('cold Ollama local results publish before a stalled cloud request times out', async t => {
  const previous = process.env.OLLAMA_INCLUDE_CLOUD_MODELS;
  process.env.OLLAMA_INCLUDE_CLOUD_MODELS = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.OLLAMA_INCLUDE_CLOUD_MODELS;
    else process.env.OLLAMA_INCLUDE_CLOUD_MODELS = previous;
  });
  const signals = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    signals.push(options.signal);
    if (new URL(url).hostname === 'local.test') {
      return { ok: true, json: async () => ({ models: [{ name: 'local-model' }] }) };
    }
    return new Promise(() => {});
  });
  const provider = new OllamaProvider('http://local.test');
  const catalog = new ModelCatalog(30);
  const snapshots = [];
  catalog.subscribe(() => snapshots.push(catalog.snapshot([provider])));
  const refreshing = catalog.refresh(provider);
  await new Promise(resolve => setImmediate(resolve));
  const partial = catalog.snapshot([provider]);
  assert.deepEqual(partial.models.map(m => m.id), ['local-model']);
  assert.equal(partial.loading, true);
  await refreshing;
  assert.deepEqual(catalog.snapshot([provider]).models.map(m => m.id), ['local-model']);
  assert.equal(catalog.snapshot([provider]).loading, false);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0].aborted, false);
  assert.equal(signals[1].aborted, true);
  assert.ok(snapshots.some(snapshot => snapshot.loading && snapshot.models.length === 1));
});

test('source failures retain cloud cache while local refreshes and reads respect backoff', async () => {
  let localCalls = 0;
  let cloudCalls = 0;
  let failCloud = false;
  const provider = { id: 'ollama', modelSources: [
    { id: 'local', fetchModels: async () => [model(`local-${++localCalls}`)] },
    { id: 'cloud', fetchModels: async () => {
      cloudCalls++;
      if (failCloud) throw new Error('offline');
      return [model('remote:cloud')];
    } },
  ] };
  const catalog = new ModelCatalog();
  await catalog.refresh(provider);
  failCloud = true;
  await catalog.refresh(provider, true);
  assert.deepEqual(catalog.snapshot([provider]).models.map(m => m.id), ['local-2', 'remote:cloud']);
  await catalog.refresh(provider);
  assert.equal(localCalls, 2);
  assert.equal(cloudCalls, 2);
});

test('slow providers do not withhold other providers and late cleared results are ignored', async () => {
  let release;
  const slow = { id: 'slow', fetchModels: () => new Promise(resolve => { release = resolve; }) };
  const fast = { id: 'fast', fetchModels: async () => [model('ready', 'fast')] };
  const catalog = new ModelCatalog();
  const pending = catalog.refresh(slow);
  await catalog.refresh(fast);
  assert.deepEqual(catalog.snapshot([slow, fast]).models.map(m => m.id), ['ready']);
  assert.equal(catalog.snapshot([slow, fast]).loading, true);
  catalog.clear();
  const clearedRevision = catalog.snapshot([slow, fast]).revision;
  release([model('obsolete', 'slow')]);
  await pending;
  assert.deepEqual(catalog.snapshot([slow, fast]).models, []);
  assert.equal(catalog.snapshot([slow, fast]).revision, clearedRevision);
});

test('a successful empty local source removes deleted models without erasing cloud models', async () => {
  let localModels = [model('installed')];
  const provider = { id: 'ollama', modelSources: [
    { id: 'local', fetchModels: async () => localModels },
    { id: 'cloud', fetchModels: async () => [model('remote:cloud')] },
  ] };
  const catalog = new ModelCatalog();
  await catalog.refresh(provider);
  localModels = [];
  await catalog.refresh(provider, true);
  assert.deepEqual(catalog.snapshot([provider]).models.map(m => m.id), ['remote:cloud']);
});
