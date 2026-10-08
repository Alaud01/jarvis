const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the hook with batched state updates: flushing a buffered chunk must
// precede appending the error, even before React renders the new message text.
function harness() {
  const listeners = {};
  const timers = new Map();
  const updates = [];
  const refs = [];
  const effects = [];
  let conversations = [{ id: 'chat', messages: [{ id: 'answer', text: 'Already rendered. ', isStreaming: true }] }];
  let unread = new Set();
  let stops = 0;
  let timerId = 0;
  const window = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    assistant: Object.fromEntries(['onChunk', 'onDone', 'onError', 'onSearchSources', 'onCompaction'].map(name => [name, callback => {
      listeners[name] = callback;
      return () => {};
    }])),
  };
  window.assistant.stopStream = async () => { stops++; };
  const exports = {};
  const filename = path.resolve(__dirname, '../src/renderer/hooks/useStreaming.ts');
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  vm.runInNewContext(outputText, {
    exports, window, console: { error() {} },
    require(name) {
      if (name === 'react') return {
        useRef: initial => { const ref = { current: initial }; refs.push(ref); return ref; },
        useCallback: callback => callback,
        useEffect: callback => effects.push(callback),
      };
      if (name === '../utils/conversation') return { STREAM_FLUSH_MS: 30 };
      throw new Error(`Unexpected import: ${name}`);
    },
  }, { filename });
  const hook = exports.useStreaming(conversations, 'chat', updater => updates.push(updater), updater => { unread = updater(unread); });
  effects.forEach(effect => effect());
  hook.registerStreamSession('chat', 'answer');
  const context = { conversationId: 'chat', assistantMessageId: 'answer' };
  return {
    hook, context, timers,
    chunk: chunk => listeners.onChunk({ ...context, chunk }),
    error: error => listeners.onError({ ...context, error }),
    done: () => listeners.onDone(context),
    hideConversation: () => { refs[3].current = 'other'; },
    get unread() { return unread; },
    get stops() { return stops; },
    message() {
      updates.splice(0).forEach(update => { conversations = update(conversations); });
      return conversations[0].messages[0];
    },
  };
}

for (const first of ['event', 'rejection']) {
  test(`partial text survives ${first}-first errors and the duplicate error path`, () => {
    const runner = harness();
    runner.hideConversation();
    runner.chunk('Buffered text.');
    const reject = () => runner.hook.handleStreamFailure('chat', 'answer', 'connection interrupted');
    if (first === 'event') { runner.error('connection interrupted'); reject(); }
    else { reject(); runner.error('connection interrupted'); }
    runner.chunk('late chunk');
    runner.done();
    const message = runner.message();
    assert.equal(message.text, 'Already rendered. Buffered text.\n\nError: connection interrupted');
    assert.equal(message.isStreaming, false);
    assert.equal(runner.timers.size, 0);
    assert.ok(runner.unread.has('chat'));
  });
}

test('failure before any content shows an error rather than claiming to retain a partial response', () => {
  const runner = harness();
  runner.hook.updateMessageInConversation('chat', 'answer', message => ({ ...message, text: '' }));
  runner.error('upstream failed');
  const message = runner.message();
  assert.equal(message.text, 'Error: upstream failed. Make sure your selected provider is running and configured.');
  assert.equal(message.isStreaming, false);
});

test('intentional stop flushes partial text and does not append a later failure', async () => {
  const runner = harness();
  runner.chunk('Keep this.');
  await runner.hook.handleStopStreaming();
  runner.error('Aborted');
  assert.equal(runner.message().text, 'Already rendered. Keep this.');
  assert.equal(runner.message().isStreaming, false);
  assert.equal(runner.stops, 1);
  assert.equal(runner.timers.size, 0);
});
