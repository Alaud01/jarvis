const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveWorkspaceView,
  scrollKeyForConversation,
  visibleConversationIdForWorkspace,
} = require('../dist/shared/workspaceViews');

test('restores supported workspace views and migrates legacy values to chat', () => {
  assert.equal(resolveWorkspaceView('dictionary'), 'dictionary');
  assert.equal(resolveWorkspaceView('usage'), 'usage');
  assert.equal(resolveWorkspaceView('recently-deleted'), 'recently-deleted');
  assert.equal(resolveWorkspaceView('chat'), 'chat');
  assert.equal(resolveWorkspaceView('home'), 'chat');
  assert.equal(resolveWorkspaceView('workspace:dictionary'), 'chat');
  assert.equal(resolveWorkspaceView(undefined), 'chat');
});

test('builds stable scroll keys for conversations', () => {
  assert.equal(scrollKeyForConversation('abc'), 'conversation:abc');
  assert.equal(scrollKeyForConversation(null), 'conversation:new');
});

test('treats a conversation as visible only in the chat workspace', () => {
  assert.equal(visibleConversationIdForWorkspace('chat', 'conversation-1'), 'conversation-1');
  assert.equal(visibleConversationIdForWorkspace('dictionary', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace('usage', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace('recently-deleted', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace(null, 'conversation-1'), null);
});
