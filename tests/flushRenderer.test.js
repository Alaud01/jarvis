const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');

test('quit flushing accepts only the matching renderer acknowledgement and propagates failure', async () => {
  const ipcMain = new EventEmitter();
  const originalLoad = Module._load;
  let flushRenderer;
  try {
    Module._load = function(request, parent, isMain) {
      return request === 'electron' ? { ipcMain } : originalLoad.call(this, request, parent, isMain);
    };
    ({ flushRenderer } = require('../dist/main/ipc/flushRenderer'));
  } finally {
    Module._load = originalLoad;
  }
  let requestId;
  const sender = { isDestroyed: () => false, send: (_channel, id) => { requestId = id; } };
  let settled = false;
  const flushing = flushRenderer(sender).then(() => { settled = true; });
  ipcMain.emit('store:flushed', { sender: {} }, requestId);
  ipcMain.emit('store:flushed', { sender }, 'stale-request');
  await Promise.resolve();
  assert.equal(settled, false);
  ipcMain.emit('store:flushed', { sender }, requestId);
  await flushing;
  assert.equal(ipcMain.listenerCount('store:flushed'), 0);

  const failed = flushRenderer(sender);
  ipcMain.emit('store:flushed', { sender }, requestId, 'disk full');
  await assert.rejects(failed, /disk full/);
  assert.equal(ipcMain.listenerCount('store:flushed'), 0);
  await assert.rejects(flushRenderer({ ...sender, send: () => { throw new Error('renderer gone'); } }), /renderer gone/);
  assert.equal(ipcMain.listenerCount('store:flushed'), 0);
});
