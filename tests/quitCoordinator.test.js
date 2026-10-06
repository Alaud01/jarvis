const test = require('node:test');
const assert = require('node:assert/strict');
const { QuitCoordinator } = require('../dist/main/app/quitCoordinator');

function setup(overrides = {}) {
  const events = [];
  const dependencies = {
    flushRenderer: async () => { events.push('renderer'); },
    flushStorage: async () => { events.push('storage'); },
    confirm: async () => { events.push('dialog'); return 'cancel'; },
    beginShutdown: () => events.push('begin'),
    stopServices: async () => { events.push('services'); },
    exit: forced => events.push(forced ? 'forced-exit' : 'exit'),
    report: () => events.push('error'),
    ...overrides,
  };
  return { events, coordinator: new QuitCoordinator(dependencies, 10, 10) };
}

test('normal quit saves before cleanup and concurrent requests share one attempt', async () => {
  const { events, coordinator } = setup();
  const first = coordinator.request();
  assert.equal(coordinator.request(), first);
  await first;
  assert.deepEqual(events, ['renderer', 'storage', 'begin', 'storage', 'services', 'exit']);
});

test('cancel leaves the app running and a later quit can retry', async () => {
  let fail = true;
  const { events, coordinator } = setup({ flushRenderer: async () => {
    if (fail) throw new Error('disk full');
  } });
  await coordinator.request();
  assert.deepEqual(events, ['dialog']);
  fail = false;
  await coordinator.request();
  assert.equal(events.at(-1), 'exit');
});

test('retry repeats saving before shutdown', async () => {
  let attempts = 0;
  const { events, coordinator } = setup({
    flushRenderer: async () => { if (++attempts === 1) throw new Error('disk full'); },
    confirm: async () => 'retry',
  });
  await coordinator.request();
  assert.equal(attempts, 2);
  assert.equal(events.at(-1), 'exit');
});

test('unresponsive renderer can quit anyway while main writes and services still clean up', async () => {
  const { events, coordinator } = setup({
    flushRenderer: () => new Promise(() => {}),
    confirm: async error => { assert.match(error.message, /deadline/); return 'quit'; },
  });
  await coordinator.request();
  assert.deepEqual(events, ['begin', 'storage', 'services', 'forced-exit']);
});

test('termination skips renderer and dialog and exits despite stuck cleanup', async () => {
  const { events, coordinator } = setup({ flushStorage: () => new Promise(() => {}) });
  await coordinator.request(true);
  assert.deepEqual(events, ['begin', 'services', 'error', 'forced-exit']);
});

test('termination interrupts an ongoing save attempt without opening a dialog', async () => {
  const { events, coordinator } = setup({ flushRenderer: () => new Promise(() => {}) });
  const pending = coordinator.request();
  assert.equal(coordinator.request(true), pending);
  await pending;
  assert.deepEqual(events, ['begin', 'storage', 'services', 'forced-exit']);
});

test('termination closes an open native dialog and escalates the same quit attempt', async () => {
  let dialogOpened;
  const opened = new Promise(resolve => { dialogOpened = resolve; });
  const { events, coordinator } = setup({
    flushRenderer: async () => { throw new Error('save failed'); },
    confirm: (_error, signal) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve('cancel'), { once: true });
      dialogOpened();
    }),
  });
  const pending = coordinator.request();
  await opened;
  assert.equal(coordinator.request(true), pending);
  await pending;
  assert.deepEqual(events, ['begin', 'storage', 'services', 'forced-exit']);
});
