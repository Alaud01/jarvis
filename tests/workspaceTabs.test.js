const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DICTIONARY_TAB_ID,
  USAGE_TAB_ID,
  isValidOpenTabId,
} = require('../dist/shared/workspaceTabs');

test('keeps conversation and workspace tab references while pruning unknown tabs', () => {
  const conversationIds = new Set(['conversation-1']);

  assert.equal(isValidOpenTabId('conversation-1', conversationIds), true);
  assert.equal(isValidOpenTabId(DICTIONARY_TAB_ID, conversationIds), true);
  assert.equal(isValidOpenTabId(USAGE_TAB_ID, conversationIds), true);
  assert.equal(isValidOpenTabId('workspace:unknown', conversationIds), false);
  assert.equal(isValidOpenTabId('deleted-conversation', conversationIds), false);
});
