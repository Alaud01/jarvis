const test = require('node:test');
const assert = require('node:assert/strict');
const { forkConversation, selectConversationVersion, getConversationVersions } = require('../dist/shared/conversationBranches');
const node = (id, extra = {}) => ({ id, text: id, ...extra });
const original = () => ({ messages: ['u1', 'a1', 'u2', 'a2'].map(id => node(id)) });

test('editing preserves the original tail and shares the prefix without duplicate messages', () => {
  const before = original();
  const edited = forkConversation(before, 2, [node('u2b'), node('a2b')]);
  assert.deepEqual(edited.messages.map(m => m.id), ['u1', 'a1', 'u2b', 'a2b']);
  assert.deepEqual(edited.branches.archived.map(m => m.id), ['u2', 'a2']);
  assert.equal(edited.messages[0], before.messages[0]);
  assert.deepEqual(getConversationVersions(edited), { u2b: ['u2', 'u2b'] });
  const restored = selectConversationVersion(edited, 'u2b', 'u2');
  assert.deepEqual(restored.messages, before.messages);
  assert.deepEqual(selectConversationVersion(restored, 'u2', 'u2b').messages, edited.messages);
});

test('nested edits remember each continuation, including messages appended after switching', () => {
  let c = forkConversation(original(), 0, [node('u1b'), node('a1b')]);
  c.messages.push(node('u3'), node('a3'));
  c = forkConversation(c, 2, [node('u3b'), node('a3b')]);
  c = selectConversationVersion(c, 'u1b', 'u1');
  c.messages.push(node('u4'), node('a4'));
  c = selectConversationVersion(c, 'u1', 'u1b');
  assert.deepEqual(c.messages.map(m => m.id), ['u1b', 'a1b', 'u3b', 'a3b']);
  c = selectConversationVersion(c, 'u3b', 'u3');
  assert.deepEqual(c.messages.map(m => m.id), ['u1b', 'a1b', 'u3', 'a3']);
  c = selectConversationVersion(c, 'u1b', 'u1');
  assert.deepEqual(c.messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2', 'u4', 'a4']);
  const all = [...c.messages, ...c.branches.archived];
  assert.equal(new Set(all.map(m => m.id)).size, all.length);
});

test('version order survives repeated edits of an older version and JSON persistence', () => {
  let c = forkConversation(original(), 0, [node('v2'), node('answer2')]);
  c = selectConversationVersion(c, 'v2', 'u1');
  c = forkConversation(c, 0, [node('v3'), node('answer3')]);
  c = JSON.parse(JSON.stringify(c));
  assert.deepEqual(getConversationVersions(c).v3, ['u1', 'v2', 'v3']);
  c = selectConversationVersion(c, 'v3', 'u1');
  assert.deepEqual(c.messages, original().messages);
});

test('attachments and sources remain intact; regeneration also preserves later messages', () => {
  const c = original();
  c.messages[0].attachments = [{ name: 'image.png', base64: 'data' }];
  c.messages[1].searchSources = [{ title: 'source' }];
  const regenerated = forkConversation(c, 1, [node('newAnswer')]);
  const restored = selectConversationVersion(regenerated, 'newAnswer', 'a1');
  assert.deepEqual(restored.messages, c.messages);
});

test('streaming, invalid targets, and stale selections cannot mutate the active transcript', () => {
  const c = forkConversation(original(), 0, [node('v2'), node('answer', { isStreaming: true })]);
  assert.equal(selectConversationVersion(c, 'v2', 'u1'), c);
  assert.equal(forkConversation(c, 0, [node('v3')]), c);
  const idle = { ...c, messages: c.messages.map(m => ({ ...m, isStreaming: false })) };
  assert.equal(selectConversationVersion(idle, 'v2', 'a2'), idle);
  assert.equal(selectConversationVersion(idle, 'missing', 'u1'), idle);
  assert.equal(forkConversation(idle, -1, []), idle);
});

test('renderer serialization round-trips archived dates and detects version-only saves', () => {
  const ts = require('typescript');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { outputText } = ts.transpileModule(fs.readFileSync(require.resolve('../src/renderer/utils/conversation.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const exported = {};
  vm.runInNewContext(outputText, {
    exports: exported,
    require: name => name === '../../shared/saveQueue' ? require('../dist/shared/saveQueue') : require(name),
    Date,
  });
  const { serializeConversation, deserializeConversation, getConversationRevision } = exported;
  const now = new Date('2026-09-07T00:00:00Z');
  const c = { ...original(), id: 'chat', title: 'Title', timestamp: now, isLoaded: true, folderId: null, isPinned: false };
  c.messages = c.messages.map(m => ({ ...m, sender: 'user', timestamp: now, compactions: [{ id: 'compact', startedAt: now, completedAt: now, status: 'completed' }] }));
  const edited = forkConversation(c, 0, [{ ...c.messages[0], id: 'edited' }]);
  const restored = deserializeConversation(JSON.parse(JSON.stringify(serializeConversation(edited))));
  assert.equal(restored.branches.archived[0].timestamp.toISOString(), now.toISOString());
  assert.equal(restored.branches.archived[0].compactions[0].completedAt.toISOString(), now.toISOString());
  assert.equal(getConversationRevision(restored), getConversationRevision(edited));
  assert.notEqual(getConversationRevision(edited), getConversationRevision({ ...edited, branches: undefined }));
  assert.equal(selectConversationVersion(restored, 'edited', 'u1').messages.length, 4);
});
