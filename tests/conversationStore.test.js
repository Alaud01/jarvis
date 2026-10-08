const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-store-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let values;
  let failKey;
  class FakeStore {
    constructor(options) { values ??= structuredClone(options.defaults); this.path = path.join(directory, 'settings.json'); }
    get(key, fallback) { return structuredClone(values[key] ?? fallback); }
    set(key, value) {
      if (failKey === key) { failKey = undefined; throw new Error('simulated settings failure'); }
      values[key] = structuredClone(value);
    }
    delete(key) { delete values[key]; }
  }
  function restart() {
    const originalLoad = Module._load;
    try {
      Module._load = function(request, parent, isMain) {
        return request === 'electron-store' ? FakeStore : originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[require.resolve('../dist/main/store')];
      return require('../dist/main/store');
    } finally {
      Module._load = originalLoad;
    }
  }
  return { directory, store: restart(), restart, failNext: key => { failKey = key; } };
}

const chat = id => ({ id, messages: [{ id: 'm', text: id }], title: id, timestamp: '2026-01-01', folderId: null });

test('conversation storage serializes mutations and ignores snapshots arriving after deletion', async t => {
  const { directory, store } = await setup(t);
  await Promise.all([store.saveConversation(chat('a')), store.saveConversation(chat('b'))]);
  assert.deepEqual((await store.loadConversationMetadata()).map(c => c.id).sort(), ['a', 'b']);
  const staleList = await store.loadConversationMetadata();
  await Promise.all([
    store.saveConversation({ ...chat('a'), messages: [{ text: 'last write' }] }),
    store.deleteConversation('a'),
    store.saveConversation(chat('a')),
    store.saveConversationMetadata(staleList),
  ]);
  assert.equal(await store.loadConversation('a'), null);
  assert.equal((await store.loadConversations()).length, 1);
  await fs.access(path.join(directory, 'jarvis-conversations', 'a.json'));
  assert.equal((await store.listDeletedConversations())[0].id, 'a');
  await fs.writeFile(path.join(directory, 'jarvis-conversations', 'b.json'), '{broken');
  await assert.rejects(store.loadConversation('b'), /could not be read or recovered/);
  await store.flushConversationStorage();
});

test('restart preserves trash, full branches and attachments, and old IDs remain blocked after restore', async t => {
  const harness = await setup(t);
  let store = harness.store;
  const original = {
    ...chat('original'), isPinned: true, folderId: 'folder',
    messages: [{ id: 'm', text: 'active', attachments: [{ name: 'image', data: 'base64-payload' }] }],
    branches: { nodes: { archived: { id: 'archived', text: 'other answer' } }, parents: { archived: 'm' }, selections: { m: 'archived' } },
  };
  store.saveFolders([{ id: 'folder', name: 'Folder', timestamp: '2026-01-01' }]);
  await store.saveConversation(original);
  await store.deleteConversation(original.id);
  const deleted = (await store.listDeletedConversations())[0];
  assert.equal(Date.parse(deleted.expiresAt) - Date.parse(deleted.deletedAt), 30 * 86400000);
  assert.equal(deleted.messages, undefined);
  store = harness.restart();
  await store.saveConversation({ ...original, messages: [] });
  await store.saveConversationMetadata([original]);
  assert.equal(await store.loadConversation(original.id), null);
  const restored = await store.restoreConversation(original.id);
  assert.notEqual(restored.id, original.id);
  assert.deepEqual(restored, { ...original, id: restored.id });
  store = harness.restart();
  await store.saveConversation(original);
  await store.saveConversationMetadata([original]);
  assert.deepEqual(await store.loadConversations(), [restored]);
  assert.deepEqual(await store.listDeletedConversations(), []);
  await assert.rejects(fs.access(path.join(harness.directory, 'jarvis-conversations', 'original.json')));
});

test('folder deletion retains children and restores to root when their folder is gone', async t => {
  const { store } = await setup(t);
  store.saveFolders([{ id: 'folder', name: 'Folder' }]);
  await store.saveConversations([{ ...chat('a'), folderId: 'folder' }, { ...chat('b'), folderId: 'folder' }, chat('root')]);
  assert.deepEqual((await store.deleteFolderAndConversations('folder')).sort(), ['a', 'b']);
  assert.deepEqual(store.loadFolders(), []);
  assert.deepEqual((await store.loadConversations()).map(c => c.id), ['root']);
  assert.equal((await store.listDeletedConversations()).length, 2);
  assert.equal((await store.restoreConversation('a')).folderId, null);
});

test('bulk replacement soft deletes omissions without pruning existing trash', async t => {
  const { store } = await setup(t);
  await store.saveConversations([chat('a'), chat('b'), chat('c')]);
  await store.deleteConversation('a');
  await store.saveConversations([chat('a'), chat('c')]);
  assert.deepEqual((await store.listDeletedConversations()).map(c => c.id).sort(), ['a', 'b']);
  assert.deepEqual((await store.restoreConversation('a')).messages, chat('a').messages);
  assert.deepEqual((await store.restoreConversation('b')).messages, chat('b').messages);
});

test('expiration includes the exact 30-day cutoff and leaves persistent tombstones', async t => {
  const harness = await setup(t);
  let store = harness.store;
  const now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await store.saveConversation(chat('a'));
  await store.saveConversation({ ...chat('a'), title: 'second snapshot' });
  await store.deleteConversation('a');
  Date.now.mock.mockImplementation(() => now + store.CONVERSATION_RETENTION_MS - 1);
  assert.equal((await store.listDeletedConversations()).length, 1);
  Date.now.mock.mockImplementation(() => now + store.CONVERSATION_RETENTION_MS);
  store = harness.restart();
  await store.cleanupDeletedConversations();
  assert.deepEqual(await store.listDeletedConversations(), []);
  assert.deepEqual(await fs.readdir(path.join(harness.directory, 'jarvis-conversations')), []);
  await assert.rejects(store.restoreConversation('a'), /no longer available/);
  await store.saveConversation(chat('a'));
  assert.deepEqual(await store.loadConversations(), []);
});

test('permanent deletion removes backups and cannot be bypassed by stale bulk saves after restart', async t => {
  const harness = await setup(t);
  let store = harness.store;
  await store.saveConversation(chat('a'));
  await store.saveConversation(chat('a'));
  await assert.rejects(store.permanentlyDeleteConversation('a'), /Only recently deleted/);
  await store.deleteConversation('a');
  await store.permanentlyDeleteConversation('a');
  assert.deepEqual(await fs.readdir(path.join(harness.directory, 'jarvis-conversations')), []);
  store = harness.restart();
  await store.saveConversations([chat('a')]);
  assert.deepEqual(await store.loadConversations(), []);
  assert.deepEqual(await store.listDeletedConversations(), []);
});

test('failed delete index write and failed restore publication retain recoverable content across restart', async t => {
  const harness = await setup(t);
  let store = harness.store;
  await store.saveConversation(chat('a'));
  harness.failNext('conversationMetadata');
  await assert.rejects(store.deleteConversation('a'), /simulated/);
  store = harness.restart();
  assert.deepEqual(await store.loadConversations(), []);
  assert.equal((await store.listDeletedConversations()).length, 1);
  harness.failNext('conversationMetadata');
  await assert.rejects(store.restoreConversation('a'), /simulated/);
  const destination = store.default.get('conversationDeletions')[0].restoredId;
  store = harness.restart();
  const restored = await store.restoreConversation('a');
  assert.equal(restored.id, destination);
  assert.deepEqual(restored.messages, chat('a').messages);
  assert.equal((await store.loadConversations()).length, 1);
});

test('startup and running cleanup use a caught nonblocking task and an unref timer', async t => {
  const { store } = await setup(t);
  const now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  await store.saveConversation(chat('startup'));
  await store.deleteConversation('startup');
  Date.now.mock.mockImplementation(() => now + store.CONVERSATION_RETENTION_MS);
  let callback;
  let unref = false;
  let cleared = false;
  const timer = { unref() { unref = true; } };
  t.mock.method(global, 'setInterval', (fn, ms) => { callback = fn; assert.equal(ms, 60000); return timer; });
  t.mock.method(global, 'clearInterval', value => { assert.equal(value, timer); cleared = true; });
  const stop = store.startDeletedConversationCleanup();
  await store.flushConversationStorage();
  assert.equal(store.default.get('conversationDeletions')[0].metadata, undefined);
  await store.saveConversation(chat('running'));
  await store.deleteConversation('running');
  Date.now.mock.mockImplementation(() => now + 2 * store.CONVERSATION_RETENTION_MS);
  callback();
  await store.flushConversationStorage();
  assert.equal(store.default.get('conversationDeletions')[1].metadata, undefined);
  assert.equal(unref, true);
  stop();
  assert.equal(cleared, true);
});

test('failure to persist a deletion leaves the active transcript unchanged', async t => {
  const harness = await setup(t);
  await harness.store.saveConversation(chat('a'));
  harness.failNext('conversationDeletions');
  await assert.rejects(harness.store.deleteConversation('a'), /simulated/);
  const store = harness.restart();
  assert.deepEqual((await store.loadConversation('a')).messages, chat('a').messages);
  assert.deepEqual(await store.listDeletedConversations(), []);
});

test('failed permanent unlink is journaled and retried after restart without resurrection', async t => {
  const harness = await setup(t);
  await harness.store.saveConversation(chat('a'));
  await harness.store.deleteConversation('a');
  const originalRm = fs.rm;
  let failed = false;
  t.mock.method(fs, 'rm', async (file, options) => {
    if (!failed && file.endsWith('a.json')) {
      failed = true;
      throw new Error('simulated unlink failure');
    }
    return originalRm(file, options);
  });
  await assert.rejects(harness.store.permanentlyDeleteConversation('a'), /simulated unlink/);
  assert.equal(harness.store.default.get('conversationDeletions')[0].purgePending, true);
  const store = harness.restart();
  await store.cleanupDeletedConversations();
  assert.deepEqual(await store.listDeletedConversations(), []);
  await store.saveConversation(chat('a'));
  assert.deepEqual(await store.loadConversations(), []);
  await assert.rejects(fs.access(path.join(harness.directory, 'jarvis-conversations', 'a.json')));
});

test('an undeletable expired file does not block active storage, other purges, or restores', async t => {
  const harness = await setup(t);
  let store = harness.store;
  const now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const errors = t.mock.method(console, 'error', () => {});
  await store.saveConversations([chat('blocked'), chat('expired'), chat('active'), chat('recoverable')]);
  await store.deleteConversation('blocked');
  await store.deleteConversation('expired');
  Date.now.mock.mockImplementation(() => now + 86400000);
  await store.deleteConversation('recoverable');
  const originalRm = fs.rm;
  let blocked = true;
  t.mock.method(fs, 'rm', async (file, options) => {
    if (blocked && file.endsWith('blocked.json')) throw new Error('permission denied');
    return originalRm(file, options);
  });
  Date.now.mock.mockImplementation(() => now + store.CONVERSATION_RETENTION_MS);
  await store.cleanupDeletedConversations();
  await fs.access(path.join(harness.directory, 'jarvis-conversations', 'blocked.json'));
  await assert.rejects(fs.access(path.join(harness.directory, 'jarvis-conversations', 'expired.json')));
  assert.equal(store.default.get('conversationDeletions').find(c => c.id === 'blocked').purgePending, true);
  assert.deepEqual((await store.listDeletedConversations()).map(c => c.id), ['recoverable']);
  await assert.rejects(store.restoreConversation('blocked'), /no longer available/);
  await store.saveConversation({ ...chat('active'), title: 'still editable' });
  assert.equal((await store.loadConversation('active')).title, 'still editable');
  assert.deepEqual((await store.loadConversationMetadata()).map(c => c.id), ['active']);
  const restored = await store.restoreConversation('recoverable');
  assert.deepEqual(restored.messages, chat('recoverable').messages);
  await assert.rejects(store.permanentlyDeleteConversation('blocked'), /permission denied/);
  // A different explicit purge must succeed even while the blocked entry is retried.
  await store.deleteConversation(restored.id);
  await store.permanentlyDeleteConversation(restored.id);
  store = harness.restart();
  assert.equal((await store.loadConversations())[0].title, 'still editable');
  assert.ok(errors.mock.callCount() > 0);
  blocked = false;
  await store.cleanupDeletedConversations();
  await assert.rejects(fs.access(path.join(harness.directory, 'jarvis-conversations', 'blocked.json')));
  assert.equal(store.default.get('conversationDeletions').find(c => c.id === 'blocked').purgePending, undefined);
});

test('expired rows stay hidden and unrestorable even if persisting purge intent fails', async t => {
  const harness = await setup(t);
  const { store } = harness;
  const now = Date.parse('2026-01-01T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  await store.saveConversation(chat('expired'));
  await store.deleteConversation('expired');
  Date.now.mock.mockImplementation(() => now + store.CONVERSATION_RETENTION_MS);
  harness.failNext('conversationDeletions');
  assert.deepEqual(await store.listDeletedConversations(), []);
  assert.ok(store.default.get('conversationDeletions')[0].metadata);
  harness.failNext('conversationDeletions');
  await assert.rejects(store.restoreConversation('expired'), /no longer available/);
  await fs.access(path.join(harness.directory, 'jarvis-conversations', 'expired.json'));
});
