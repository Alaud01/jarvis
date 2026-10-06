const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createRequire } = require('node:module');

// A small hook runner lets the existing node test suite exercise IPC ordering
// and rendered button contracts without adding a browser or test dependency.
function harness(source, exportName, assistant, props = {}) {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const intervals = new Map();
  const listeners = new Map();
  let cursor = 0;
  let timerId = 0;
  let result;
  let beforeQuit;
  const alerts = [];
  const confirmations = [];
  const window = {
    assistant: { ...assistant, onBeforeQuit: callback => { beforeQuit = callback; return () => {}; } },
    confirm: message => { confirmations.push(message); return true; },
    alert: message => alerts.push(message),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id),
  };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps, effect: true };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const cache = new Map();
  const load = filename => {
    if (cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const localRequire = createRequire(filename);
    const requireSource = name => {
      if (name === 'react') return react;
      if (name.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filename), name);
        for (const extension of ['.ts', '.tsx']) {
          if (fs.existsSync(resolved + extension)) return load(resolved + extension);
        }
      }
      return localRequire(name);
    };
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    vm.runInNewContext(outputText, {
      exports, require: requireSource, window, console: { error() {} },
      setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, Date,
      crypto: require('node:crypto').webcrypto,
    }, { filename });
    return exports;
  };
  const component = load(path.resolve(__dirname, '..', source))[exportName];
  const render = (commit = true) => {
    cursor = 0;
    result = component(props);
    if (commit) effects.splice(0).forEach(effect => effect());
    return result;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(resolve => setImmediate(resolve));
      render();
    }
    return result;
  };
  render();
  return {
    render, settle, window, alerts, confirmations, intervals, listeners,
    get value() { return result; },
    flush: () => beforeQuit(),
    unmount: () => slots.forEach(slot => { if (slot?.effect) slot.cleanup?.(); }),
  };
}

const timestamp = '2026-09-01T00:00:00.000Z';
const stored = (id = 'chat') => ({
  id, title: id, timestamp, folderId: 'folder', isPinned: false,
  messages: [{ id: 'message', sender: 'user', text: 'Original', timestamp }],
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function conversationHarness(overrides = {}) {
  const writes = [];
  const assistant = {
    storeLoadConversationList: async () => [stored()],
    storeLoadConversation: async id => stored(id),
    storeLoadFolders: async () => [{ id: 'folder', name: 'Work', timestamp }],
    storeLoadCurrentConversationId: async () => 'chat',
    storeLoadConversationDrafts: async () => ({}),
    storeLoadWorkspaceView: async () => 'chat',
    storeLoadScrollPositions: async () => ({}),
    storeSaveConversationList: async list => { writes.push(['metadata', list]); return { success: true }; },
    storeSaveConversation: async conversation => { writes.push(['save', conversation]); return { success: true }; },
    storeSaveFolders: async () => ({ success: true }),
    storeSaveCurrentConversationId: async () => ({ success: true }),
    storeSaveConversationDrafts: async () => ({ success: true }),
    storeDeleteConversation: async id => { writes.push(['delete', id]); return { success: true }; },
    storeDeleteFolder: async id => { writes.push(['folder', id]); return { success: true }; },
    storeRestoreConversation: async () => stored('restored-id'),
    ...overrides,
  };
  const runner = harness('src/renderer/hooks/useConversations.ts', 'useConversations', assistant);
  await runner.settle();
  return { runner, writes };
}

test('failed initial storage hydration blocks chat and voice edit entry points', async () => {
  const { runner, writes } = await conversationHarness({
    storeLoadConversationList: async () => { throw new Error('Unreadable index'); },
  });
  assert.equal(runner.value.hasHydratedStore, false);
  assert.match(runner.value.storeLoadError, /Restart Jarvis/);
  assert.equal(runner.value.canEditConversation(null), false);
  assert.equal(runner.value.canEditConversation('chat'), false);
  assert.equal(runner.value.handleCreateFolder(), '');
  await runner.settle();
  await runner.flush();
  assert.equal(writes.length, 0);
  assert.equal(runner.value.folders.length, 0);
});

test('soft deletion saves the latest render even before its save effect, then retains a tombstone', async () => {
  const { runner, writes } = await conversationHarness();
  runner.value.setConversations(prev => prev.map(c => ({ ...c, messages: [...c.messages, {
    id: 'latest', sender: 'assistant', text: 'Just completed', timestamp: new Date(timestamp),
  }] })));
  runner.render(false);
  runner.value.handleDeleteConversation('chat');
  assert.equal(runner.value.canEditConversation('chat'), false);
  await runner.settle();
  const deletionIndex = writes.findIndex(([kind]) => kind === 'delete');
  const saved = writes.slice(0, deletionIndex).filter(([kind]) => kind === 'save').at(-1)[1];
  assert.equal(saved.messages.at(-1).text, 'Just completed');
  assert.equal(runner.value.conversations.length, 0);
  assert.equal(runner.value.canEditConversation('chat'), false);
  await runner.flush();
  assert.equal(writes.slice(deletionIndex + 1).some(([kind]) => kind === 'save'), false);
  assert.match(runner.confirmations[0], /Recently Deleted for 30 days/);
});

test('normal quit saves the latest partial response even after its initial streaming snapshot was saved', async () => {
  const { runner, writes } = await conversationHarness();
  const updateAnswer = text => runner.value.setConversations(prev => prev.map(c => ({
    ...c, messages: [...c.messages.filter(m => m.id !== 'answer'), {
      id: 'answer', sender: 'assistant', text, isStreaming: true, timestamp: new Date(timestamp),
    }],
  })));
  updateAnswer('First tokens');
  await runner.settle();
  await runner.flush();
  assert.equal(writes.filter(([kind]) => kind === 'save').at(-1)[1].messages.at(-1).text, 'First tokens');
  updateAnswer('First tokens and the latest rendered text');
  await runner.settle();
  assert.equal(writes.filter(([kind]) => kind === 'save').at(-1)[1].messages.at(-1).text, 'First tokens');
  await runner.flush();
  const saved = writes.filter(([kind]) => kind === 'save').at(-1)[1];
  assert.equal(saved.messages.at(-1).text, 'First tokens and the latest rendered text');
  assert.equal(saved.messages.at(-1).isStreaming, undefined);
});

test('streaming conversations block both individual and folder deletion before confirmation or flushing', async () => {
  const { runner, writes } = await conversationHarness();
  runner.value.setConversations(prev => prev.map(c => ({ ...c, isPinned: true, messages: c.messages.map(m => ({ ...m, isStreaming: true })) })));
  runner.render();
  runner.value.handleDeleteConversation('chat');
  runner.value.handleDeleteFolder('folder');
  await runner.settle();
  assert.equal(runner.confirmations.length, 0);
  assert.equal(runner.alerts.length, 2);
  assert.equal(writes.some(([kind]) => kind === 'delete' || kind === 'folder'), false);
  assert.equal(runner.value.conversations.length, 1);
});

test('a failed pending save aborts deletion and keeps the conversation editable', async () => {
  const { runner, writes } = await conversationHarness({ storeSaveConversation: async () => { throw new Error('Disk full'); } });
  runner.value.setConversations(prev => prev.map(c => ({ ...c, title: 'Unsaved title' })));
  runner.render();
  runner.value.handleDeleteConversation('chat');
  await runner.settle();
  assert.equal(writes.some(([kind]) => kind === 'delete'), false);
  assert.equal(runner.value.conversations[0].title, 'Unsaved title');
  assert.equal(runner.value.canEditConversation('chat'), true);
  assert.match(runner.alerts[0], /Failed to delete/);
});

test('restore drains metadata before IPC, pauses later metadata, and merges a new ID without replacing edits', async () => {
  const metadata = deferred();
  const restore = deferred();
  const events = [];
  const { runner } = await conversationHarness({
    storeSaveConversationList: async list => { events.push(['metadata', list.map(c => c.id)]); await metadata.promise; return { success: true }; },
    storeRestoreConversation: async () => { events.push(['restore']); return restore.promise; },
  });
  runner.value.handleRenameConversation('chat', 'Before restore');
  runner.render();
  const pending = runner.value.handleRestoreConversation('deleted-id');
  await runner.settle();
  assert.equal(events.some(([kind]) => kind === 'restore'), false);
  metadata.resolve();
  await runner.settle();
  assert.equal(events.at(-1)[0], 'restore');
  const count = events.length;
  runner.value.setConversations(prev => prev.map(c => ({ ...c, title: 'Current local edit' })));
  runner.render();
  await runner.settle();
  assert.equal(events.length, count);
  restore.resolve(stored('new-restored-id'));
  await pending;
  await runner.settle();
  assert.equal(runner.value.conversations.find(c => c.id === 'chat').title, 'Current local edit');
  assert.equal(runner.value.conversations[0].id, 'new-restored-id');
  assert.equal(runner.value.currentConversationId, 'chat');
  await runner.flush();
  assert.deepEqual(Array.from(events.at(-1)[1]), ['new-restored-id', 'chat']);
});

for (const operation of ['conversation', 'folder']) {
  test(`${operation} deletion reconciles durable membership after a post-commit storage failure`, async () => {
    const { runner } = await conversationHarness();
    runner.window.assistant.storeLoadConversationList = async () => [];
    runner.window.assistant.storeLoadFolders = async () => operation === 'folder' ? [] : [{ id: 'folder', name: 'Work', timestamp }];
    const failedDelete = async () => { throw new Error('metadata failed after deletion was committed'); };
    runner.window.assistant.storeDeleteConversation = failedDelete;
    runner.window.assistant.storeDeleteFolder = failedDelete;
    if (operation === 'conversation') runner.value.handleDeleteConversation('chat');
    else runner.value.handleDeleteFolder('folder');
    await runner.settle();
    assert.equal(runner.value.conversations.length, 0);
    assert.equal(runner.value.currentConversationId, null);
    assert.equal(runner.value.canEditConversation('chat'), false);
    assert.equal(runner.value.folders.length, operation === 'folder' ? 0 : 1);
    assert.equal(runner.value.isStoreMutationPending, false);
  });
}

test('unreadable membership after a mutation failure blocks edits instead of accepting unsavable messages', async () => {
  const { runner } = await conversationHarness();
  runner.window.assistant.storeDeleteConversation = async () => { throw new Error('post-commit error'); };
  runner.window.assistant.storeLoadConversationList = async () => { throw new Error('store unavailable'); };
  runner.value.handleDeleteConversation('chat');
  await runner.settle();
  assert.equal(runner.value.canEditConversation('chat'), false);
  assert.equal(runner.value.canEditConversation(null), false);
  assert.match(runner.value.storeLoadError, /Restart Jarvis/);
});

test('folder deletion saves every loaded member before deleting and preserves other conversations', async () => {
  const { runner, writes } = await conversationHarness();
  runner.value.setConversations(prev => [...prev, { ...prev[0], id: 'outside', folderId: null }]);
  runner.render(false);
  runner.value.handleDeleteFolder('folder');
  await runner.settle();
  const index = writes.findIndex(([kind]) => kind === 'folder');
  assert.ok(writes.slice(0, index).some(([kind, value]) => kind === 'save' && value.id === 'chat'));
  assert.equal(runner.value.conversations.length, 1);
  assert.equal(runner.value.conversations[0].id, 'outside');
  assert.equal(runner.value.folders.length, 0);
});

test('a late load cannot overwrite a restored conversation even when the backend reuses its ID', async () => {
  const loading = deferred();
  const { runner } = await conversationHarness();
  runner.window.assistant.storeLoadConversation = async () => loading.promise;
  runner.window.assistant.storeRestoreConversation = async () => ({ ...stored(), title: 'Restored snapshot' });
  runner.value.setConversations(prev => prev.map(c => ({ ...c, isLoaded: false, messages: [] })));
  runner.render();
  runner.value.handleDeleteConversation('chat');
  await runner.settle();
  await runner.value.handleRestoreConversation('chat');
  await runner.settle();
  loading.resolve({ ...stored(), title: 'Stale loaded snapshot' });
  await runner.settle();
  assert.equal(runner.value.conversations[0].title, 'Restored snapshot');
  assert.equal(runner.value.canEditConversation('chat'), true);
});

function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  const children = tree.props?.children;
  return [tree, ...[children].flat(Infinity).flatMap(nodes)];
}
const text = tree => {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return [tree.props?.children].flat(Infinity).map(text).join(' ');
};
const button = (runner, label) => nodes(runner.value).find(node => node.type === 'button' && (node.props['aria-label'] === label || text(node) === label));
const deleted = () => ({ ...stored(), deletedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
const viewHarness = (assistant, props = {}) => harness('src/renderer/components/RecentlyDeleted.tsx', 'default', assistant, {
  onRestore: async () => {}, isStoreMutationPending: false, ...props,
});

test('Recently Deleted renders loading, empty, error and retry states and stops polling on unmount', async () => {
  let fail = true;
  const runner = viewHarness({ storeListDeletedConversations: async () => { if (fail) throw new Error('Offline'); return []; } });
  assert.match(text(runner.value), /Loading deleted conversations/);
  await runner.settle();
  assert.match(text(runner.value), /could not be loaded/);
  fail = false;
  await button(runner, 'Refresh').props.onClick();
  await runner.settle();
  assert.match(text(runner.value), /No recently deleted conversations/);
  assert.equal(runner.intervals.size, 1);
  runner.unmount();
  assert.equal(runner.intervals.size, 0);
  assert.equal(runner.listeners.has('focus'), false);
});

test('Recently Deleted shows days remaining, restores with feedback, and confirms permanent deletion', async () => {
  const item = deleted();
  let items = [item];
  const removed = [];
  const runner = viewHarness({
    storeListDeletedConversations: async () => items,
    storePermanentlyDeleteConversation: async id => { removed.push(id); items = []; return { success: true }; },
  }, { onRestore: async id => { removed.push(`restore:${id}`); items = []; } });
  await runner.settle();
  assert.match(text(runner.value), /2 days remaining/);
  await button(runner, 'Restore chat').props.onClick();
  await runner.settle();
  assert.deepEqual(removed, ['restore:chat']);
  assert.match(text(runner.value), /Conversation restored/);
  items = [item];
  runner.intervals.values().next().value();
  await runner.settle();
  runner.window.confirm = () => false;
  await button(runner, 'Permanently delete chat').props.onClick();
  assert.equal(removed.length, 1);
  runner.window.confirm = message => { assert.match(message, /cannot be undone/); return true; };
  await button(runner, 'Permanently delete chat').props.onClick();
  await runner.settle();
  assert.deepEqual(removed, ['restore:chat', 'chat']);
  assert.match(text(runner.value), /Conversation permanently deleted/);
});

test('expiry refresh removes expired rows; failed restores retain the row and display an error', async () => {
  let items = [deleted()];
  const runner = viewHarness({ storeListDeletedConversations: async () => items }, {
    onRestore: async () => { throw new Error('Expired'); },
  });
  await runner.settle();
  await button(runner, 'Restore chat').props.onClick();
  await runner.settle();
  assert.match(text(runner.value), /could not be restored/);
  assert.ok(button(runner, 'Restore chat'));
  items = [{ ...items[0], expiresAt: timestamp }];
  runner.intervals.values().next().value();
  await runner.settle();
  assert.match(text(runner.value), /No recently deleted conversations/);
});

test('pending restore disables actions and an older poll cannot put a restored row back', async () => {
  const poll = deferred();
  const restore = deferred();
  let calls = 0;
  const runner = viewHarness({ storeListDeletedConversations: async () => {
    calls++;
    return calls === 1 ? [deleted()] : calls === 2 ? poll.promise : [];
  } }, { onRestore: async () => restore.promise });
  await runner.settle();
  runner.intervals.values().next().value();
  button(runner, 'Restore chat').props.onClick();
  runner.render();
  assert.equal(button(runner, 'Restore chat').props.disabled, true);
  assert.equal(button(runner, 'Permanently delete chat').props.disabled, true);
  restore.resolve();
  await runner.settle();
  poll.resolve([deleted()]);
  await runner.settle();
  assert.match(text(runner.value), /No recently deleted conversations/);
});
