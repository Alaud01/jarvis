const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ConversationFiles, SerialTaskQueue } = require('../dist/main/conversationFiles');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-conversations-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, files: new ConversationFiles(directory) };
}

test('atomically replaces conversations, preserves branches, and recovers a damaged primary', async t => {
  const { directory, files } = await setup(t);
  const original = { id: 'chat', messages: [{ text: 'hello' }], branches: { archived: [{ text: 'old answer' }] } };
  await files.write(original);
  await files.write({ ...original, messages: [{ text: 'new answer' }] });
  await fs.writeFile(path.join(directory, 'chat.json'), '{broken');
  assert.deepEqual(await files.read('chat'), original);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'chat.json'), 'utf8')), original);
  assert.ok((await fs.readdir(directory)).some(name => name.includes('.corrupt-')));
  assert.ok(!(await fs.readdir(directory)).some(name => name.endsWith('.tmp')));
});

test('unrecoverable corruption is surfaced and never overwritten with an empty history', async t => {
  const { directory, files } = await setup(t);
  const primary = path.join(directory, 'chat.json');
  await fs.writeFile(primary, '{broken');
  await assert.rejects(files.read('chat'), /could not be read or recovered/);
  await assert.rejects(files.write({ id: 'chat', messages: [] }), /could not be read or recovered/);
  assert.equal(await fs.readFile(primary, 'utf8'), '{broken');
  assert.equal(await files.read('missing'), null);
});

test('a failed replacement leaves the live file intact and the queue continues', async t => {
  const { files } = await setup(t);
  const queue = new SerialTaskQueue();
  const original = { id: 'chat', messages: ['original'] };
  await queue.run(() => files.write(original));
  // JSON serialization fails after the temporary file is opened.
  const invalid = { id: 'chat', messages: [1n] };
  const failed = queue.run(() => files.write(invalid));
  const read = queue.run(() => files.read('chat'));
  await assert.rejects(failed, /BigInt/);
  assert.deepEqual(await read, original);
  await queue.flush();
});

test('queued writes and deletes execute in order and remove recovery backups', async t => {
  const { directory, files } = await setup(t);
  const queue = new SerialTaskQueue();
  await Promise.all([
    queue.run(() => files.write({ id: 'chat', messages: ['first'] })),
    queue.run(() => files.write({ id: 'chat', messages: ['second'] })),
    queue.run(() => files.delete('chat')),
  ]);
  assert.equal(await files.read('chat'), null);
  assert.deepEqual(await fs.readdir(directory), []);
});
