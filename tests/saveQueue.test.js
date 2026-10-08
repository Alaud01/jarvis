const test = require('node:test');
const assert = require('node:assert/strict');
const { SaveQueue, memoizeRevision } = require('../dist/shared/saveQueue');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('failed saves remain dirty and retry without a new edit', async () => {
  const retried = deferred();
  const errors = [];
  const queue = new SaveQueue(60_000, (_, error) => errors.push(error), 1);
  let attempts = 0;
  queue.schedule('chat', 'v1', async () => {
    if (++attempts === 1) throw new Error('disk full');
    retried.resolve();
  });
  await assert.rejects(queue.flush(), /disk full/);
  assert.equal(queue.hasPending('chat'), true);
  await retried.promise;
  await queue.flush();
  queue.schedule('chat', 'v1', async () => assert.fail('already acknowledged'));
  assert.equal(queue.hasPending('chat'), false);
  assert.equal(attempts, 2);
  assert.equal(errors.length, 1);
});

test('flush coalesces edits but preserves the latest snapshot during an in-flight save', async () => {
  const queue = new SaveQueue(60_000, () => {});
  const started = deferred();
  const release = deferred();
  const writes = [];
  queue.schedule('chat', 'v1', async () => {
    started.resolve();
    await release.promise;
    writes.push('v1');
  });
  const flushing = queue.flush();
  await started.promise;
  queue.schedule('chat', 'v2', async () => writes.push('v2'));
  queue.schedule('chat', 'v3', async () => writes.push('v3'));
  release.resolve();
  await flushing;
  assert.deepEqual(writes, ['v1', 'v3']);
  assert.equal(queue.hasPending('chat'), false);
});

test('overlapping flushes serialize newer snapshots after an in-flight write', async () => {
  const queue = new SaveQueue(60_000, () => {});
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const writes = [];
  let activeWrites = 0;
  let maximumConcurrentWrites = 0;
  const write = revision => async () => {
    activeWrites++;
    maximumConcurrentWrites = Math.max(maximumConcurrentWrites, activeWrites);
    writes.push(revision);
    if (revision === 'v1') {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else {
      await releaseSecond.promise;
    }
    activeWrites--;
  };
  queue.schedule('chat', 'v1', write('v1'));
  const firstFlush = queue.flush();
  await firstStarted.promise;
  queue.schedule('chat', 'v2', write('v2'));
  const otherFlushes = [queue.flush(), queue.flush()];
  releaseFirst.resolve();
  await new Promise(resolve => setImmediate(resolve));
  releaseSecond.resolve();
  await Promise.all([firstFlush, ...otherFlushes]);
  assert.equal(maximumConcurrentWrites, 1);
  assert.deepEqual(writes, ['v1', 'v2']);
  assert.equal(queue.hasPending('chat'), false);
});

test('reverting an edit while its save is in flight writes the original revision again', async () => {
  const queue = new SaveQueue(60_000, () => {});
  const release = deferred();
  queue.seed('chat', 'original');
  const writes = [];
  queue.schedule('chat', 'edited', async () => { await release.promise; writes.push('edited'); });
  const flushing = queue.flush();
  queue.schedule('chat', 'original', async () => writes.push('original'));
  release.resolve();
  await flushing;
  assert.deepEqual(writes, ['edited', 'original']);
});

test('canceling deletion snapshots suppresses pending writes and late acknowledgements', async () => {
  const queue = new SaveQueue(60_000, () => {});
  const release = deferred();
  queue.schedule('chat', 'v1', async () => release.promise);
  const flushing = queue.flush();
  queue.schedule('chat', 'v2', async () => assert.fail('deleted snapshot'));
  queue.cancel('chat');
  release.resolve();
  await flushing;
  assert.equal(queue.hasPending('chat'), false);
  let recreated = false;
  queue.schedule('chat', 'v1', async () => { recreated = true; });
  await queue.flush();
  assert.equal(recreated, true);
});

test('unchanged background histories are hashed once while new snapshots are recalculated', () => {
  let scans = 0;
  const revision = memoizeRevision(value => { scans++; return value.text; });
  const backgrounds = Array.from({ length: 5 }, () => ({ text: 'x'.repeat(100_000) }));
  for (let flush = 0; flush < 100; flush++) backgrounds.forEach(revision);
  assert.equal(scans, 5);
  assert.equal(revision({ ...backgrounds[0], text: 'changed' }), 'changed');
  assert.equal(scans, 6);
});

test('synchronous serialization failures can be retried and superseded', async () => {
  const queue = new SaveQueue(60_000, () => {});
  queue.schedule('chat', 'invalid', () => { throw new Error('serialization failed'); });
  await assert.rejects(queue.flush(), /serialization failed/);
  let saved = false;
  queue.schedule('chat', 'valid', async () => { saved = true; });
  await queue.flush();
  assert.equal(saved, true);
});
