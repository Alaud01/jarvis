const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { folderDeletionMessage } = require('../dist/shared/folderDeletion');

// Exercise the renderer's detector with the real installed dnd-kit algorithms.
const { outputText } = ts.transpileModule(
  fs.readFileSync(require.resolve('../src/renderer/utils/sidebarCollision.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
);
const detectorExports = {};
vm.runInNewContext(outputText, { exports: detectorExports, require });
const { sidebarCollision } = detectorExports;
const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});
const targets = [
  { id: 'root', type: 'root', rect: rect(0, 0, 256, 400) },
  { id: 'row', type: 'conversation', rect: rect(8, 80, 240, 32) },
];
const detect = (x, y) => sidebarCollision({
  pointerCoordinates: { x, y },
  collisionRect: rect(x - 120, y - 16, 240, 32),
  droppableContainers: targets.map(({ id, type }) => ({ id, data: { current: { type } } })),
  droppableRects: new Map(targets.map(({ id, rect: bounds }) => [id, bounds])),
});

test('dropping outside the sidebar has no target, even with a nearby row', () => {
  assert.equal(detect(700, 96).length, 0);
  // The dragged rectangle still overlaps the sidebar, but the pointer does not.
  assert.equal(detect(270, 96).length, 0);
});

test('a row takes priority over its enclosing drop zone', () => {
  const hits = detect(120, 96);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'row');
});

test('empty space inside a drop zone remains a valid target', () => {
  assert.equal(detect(120, 250)[0].id, 'root');
});

test('folder deletion names every pinned chat and counts all members', () => {
  const message = folderDeletionMessage('Work', [
    { title: 'Visible chat', isPinned: false },
    { title: 'Important notes', isPinned: true },
    { title: 'Research', isPinned: true },
  ]);
  assert.match(message, /delete 3 conversations/);
  assert.match(message, /restore these conversations from Recently Deleted for 30 days/);
  assert.match(message, /pinned chats:\n• Important notes\n• Research/);
});

test('folders containing only pinned chats are not described as empty', () => {
  assert.match(folderDeletionMessage('Work', [{ title: 'Notes', isPinned: true }]), /delete 1 conversation inside it/);
  assert.equal(folderDeletionMessage('Empty', []), 'Delete empty folder "Empty"?');
  assert.doesNotMatch(folderDeletionMessage('Work', [{ title: 'Notes', isPinned: false }]), /pinned/);
});
