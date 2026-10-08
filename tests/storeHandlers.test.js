const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('delete IPC reports committed deletion despite ancillary cleanup failures, but propagates storage failures', async t => {
  const handlers = new Map();
  const calls = [];
  let storageFails = false;
  const store = {
    startDeletedConversationCleanup() {},
    async deleteConversation(id) {
      if (storageFails) throw new Error('storage failure');
      calls.push(['conversation', id]);
    },
    async deleteFolderAndConversations(id) {
      if (storageFails) throw new Error('storage failure');
      calls.push(['folder', id]);
      return ['child'];
    },
    async permanentlyDeleteConversation() { throw new Error('unlink failure'); },
  };
  const warnings = t.mock.method(console, 'warn', () => {});
  const modulePath = require.resolve('../dist/main/ipc/storeHandlers');
  const originalLoad = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (parent?.filename === modulePath) {
        if (request === 'electron') return { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } };
        if (request === '../store') return store;
        if (request === '../providers/registry') return {
          deleteProviderConversationState(ids) {
            calls.push(['provider', ids]);
            if (ids[0] === 'chat') throw new Error('synchronous provider failure');
            return Promise.reject(new Error('asynchronous provider failure'));
          },
        };
        return {};
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[modulePath];
    require(modulePath).registerStoreHandlers();
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
  assert.deepEqual(await handlers.get('store:delete-conversation')(null, 'chat'), { success: true });
  assert.deepEqual(await handlers.get('store:delete-folder')(null, 'folder'), { success: true });
  assert.deepEqual(calls, [['conversation', 'chat'], ['provider', ['chat']], ['folder', 'folder'], ['provider', ['child']]]);
  assert.equal(warnings.mock.callCount(), 2);
  storageFails = true;
  await assert.rejects(handlers.get('store:delete-conversation')(null, 'chat'), /storage failure/);
  await assert.rejects(handlers.get('store:delete-folder')(null, 'folder'), /storage failure/);
  await assert.rejects(handlers.get('store:permanently-delete-conversation')(null, 'chat'), /unlink failure/);
  assert.equal(calls.length, 4);
});
