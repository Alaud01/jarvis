const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenCodeGoProvider } = require('../dist/main/providers/opencode-go');
const {
  isImageInputUnsupportedError,
  stripToolImages,
  toToolImageFields,
} = require('../dist/main/providers/toolImages');

const history = [
  { role: 'system', content: 'Jarvis' },
  { role: 'user', content: 'What is on the page?' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { type: 'function', id: 'call_1', function: { name: 'browser_screenshot', arguments: {} } },
      { type: 'function', id: 'call_2', function: { name: 'browser_read', arguments: {} } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'Screenshot: captured (image attached).', images: ['AAAA'], imageMimeTypes: ['image/png'] },
  { role: 'tool', tool_call_id: 'call_2', content: 'Page text' },
];

async function captureBody(t, model) {
  let body;
  t.mock.method(global, 'fetch', async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('{"error":{"message":"stop"}}', { status: 500 });
  });
  await assert.rejects(new OpenCodeGoProvider('test-key').streamChat(model, history, new AbortController(), () => {}, {}));
  return body;
}

test('tool data URLs become message image fields', () => {
  assert.deepEqual(toToolImageFields(['data:image/jpeg;base64,QUJD', 'not-a-data-url']), {
    images: ['QUJD'],
    imageMimeTypes: ['image/jpeg'],
  });
  assert.deepEqual(toToolImageFields(undefined), {});
});

test('chat completions sends tool images in a user message after the tool run', async t => {
  const body = await captureBody(t, 'kimi-k3');
  const roles = body.messages.map(message => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool', 'user']);
  assert.equal(body.messages[3].content, 'Screenshot: captured (image attached).');
  assert.deepEqual(body.messages[5].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
});

test('anthropic messages embed tool images inside the tool_result', async t => {
  const body = await captureBody(t, 'minimax-m3');
  const toolResult = body.messages[2].content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.deepEqual(toolResult.content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  });
});

test('responses input follows function outputs with an input_image message', async t => {
  const body = await captureBody(t, 'gpt-6-luna');
  const types = body.input.map(item => item.type ?? item.role);
  assert.deepEqual(types.slice(-3), ['function_call_output', 'function_call_output', 'user']);
  assert.deepEqual(body.input.at(-1).content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
});

test('stripping tool images leaves a note and keeps other messages untouched', () => {
  const messages = history.map(message => ({ ...message }));
  stripToolImages(messages, 'unsupported');
  assert.equal(messages[3].images, undefined);
  assert.match(messages[3].content, /does not accept image input/);
  assert.equal(messages[4].content, 'Page text');
});

test('only 4xx image-related errors trigger the text-only retry', () => {
  assert.equal(isImageInputUnsupportedError(new Error('OpenCode Go request failed (400): model does not support image input')), true);
  assert.equal(isImageInputUnsupportedError(new Error('OpenCode Go request failed (500): image service down')), false);
  assert.equal(isImageInputUnsupportedError(new Error('OpenCode Go request failed (400): bad tool schema')), false);
});
