const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DICTIONARY_TAB_ID,
  USAGE_TAB_ID,
  isValidOpenTabId,
  resolveLastActiveTabId,
  resolveWorkspaceView,
  scrollKeyForConversation,
  visibleConversationIdForWorkspace,
} = require('../dist/shared/workspaceTabs');

test('keeps conversation and workspace tab references while pruning unknown tabs', () => {
  const conversationIds = new Set(['conversation-1']);

  assert.equal(isValidOpenTabId('conversation-1', conversationIds), true);
  assert.equal(isValidOpenTabId(DICTIONARY_TAB_ID, conversationIds), true);
  assert.equal(isValidOpenTabId(USAGE_TAB_ID, conversationIds), true);
  assert.equal(isValidOpenTabId('workspace:unknown', conversationIds), false);
  assert.equal(isValidOpenTabId('deleted-conversation', conversationIds), false);
});

test('resolves stored workspace views and falls back safely', () => {
  const conversationIds = new Set(['conversation-1']);

  assert.equal(resolveWorkspaceView({
    storedView: 'dictionary',
    openTabIds: [DICTIONARY_TAB_ID],
    currentConversationId: 'conversation-1',
    validConversationIds: conversationIds,
  }), 'dictionary');

  assert.equal(resolveWorkspaceView({
    storedView: 'usage',
    openTabIds: [USAGE_TAB_ID],
    currentConversationId: null,
    validConversationIds: conversationIds,
  }), 'usage');

  assert.equal(resolveWorkspaceView({
    storedView: 'chat',
    openTabIds: ['conversation-1'],
    currentConversationId: 'conversation-1',
    validConversationIds: conversationIds,
  }), 'chat');

  assert.equal(resolveWorkspaceView({
    storedView: 'chat',
    openTabIds: [],
    currentConversationId: 'missing',
    validConversationIds: conversationIds,
  }), 'home');

  assert.equal(resolveWorkspaceView({
    storedView: 'home',
    openTabIds: ['conversation-1'],
    currentConversationId: 'conversation-1',
    validConversationIds: conversationIds,
  }), 'home');
});

test('builds stable scroll keys for conversations', () => {
  assert.equal(scrollKeyForConversation('abc'), 'conversation:abc');
  assert.equal(scrollKeyForConversation(null), 'conversation:new');
});

test('treats a conversation as visible only in the chat workspace', () => {
  assert.equal(visibleConversationIdForWorkspace('chat', 'conversation-1'), 'conversation-1');
  assert.equal(visibleConversationIdForWorkspace('home', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace('dictionary', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace('usage', 'conversation-1'), null);
  assert.equal(visibleConversationIdForWorkspace(null, 'conversation-1'), null);
});

test('restores a valid tab target when home is hydrated', () => {
  const conversationIds = new Set(['conversation-1', 'conversation-2']);

  assert.equal(resolveLastActiveTabId({
    openTabIds: ['conversation-1', USAGE_TAB_ID],
    currentConversationId: 'conversation-1',
    validConversationIds: conversationIds,
  }), 'conversation-1');

  assert.equal(resolveLastActiveTabId({
    openTabIds: ['missing', DICTIONARY_TAB_ID, 'conversation-2'],
    currentConversationId: 'missing',
    validConversationIds: conversationIds,
  }), 'conversation-2');

  assert.equal(resolveLastActiveTabId({
    openTabIds: [DICTIONARY_TAB_ID],
    currentConversationId: null,
    validConversationIds: conversationIds,
  }), DICTIONARY_TAB_ID);

  assert.equal(resolveLastActiveTabId({
    openTabIds: ['missing'],
    currentConversationId: 'missing',
    validConversationIds: conversationIds,
  }), null);
});
