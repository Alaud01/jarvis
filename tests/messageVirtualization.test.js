const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MESSAGE_COUNT_VIRTUALIZATION_THRESHOLD,
  SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD,
  TOTAL_TEXT_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeMessages,
} = require('../dist/shared/messageVirtualization');

const message = (text) => ({ text });

test('leaves genuinely small conversations unvirtualized', () => {
  assert.equal(shouldVirtualizeMessages([
    message('Short question'),
    message('Short answer'),
  ]), false);
});

test('virtualizes conversations with many short messages', () => {
  const messages = Array.from(
    { length: MESSAGE_COUNT_VIRTUALIZATION_THRESHOLD + 1 },
    () => message('ok'),
  );

  assert.equal(shouldVirtualizeMessages(messages), true);
});

test('virtualizes conversations with a large combined text payload', () => {
  const halfThreshold = Math.ceil(TOTAL_TEXT_VIRTUALIZATION_THRESHOLD / 2);

  assert.equal(shouldVirtualizeMessages([
    message('a'.repeat(halfThreshold)),
    message('b'.repeat(halfThreshold)),
  ]), true);
});

test('virtualizes a single expensive Markdown-sized response', () => {
  assert.equal(shouldVirtualizeMessages([
    message('x'.repeat(SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD)),
  ]), true);
});

test('keeps payloads below every threshold unvirtualized', () => {
  assert.equal(shouldVirtualizeMessages([
    message('a'.repeat(SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD - 1)),
    message('b'.repeat(SINGLE_MESSAGE_TEXT_VIRTUALIZATION_THRESHOLD - 1)),
  ]), false);
});

test('virtualizes the render profile of the previously slow interview conversation', () => {
  const messages = Array.from({ length: 44 }, () => message('x'.repeat(3_452)));

  assert.equal(shouldVirtualizeMessages(messages), true);
});
