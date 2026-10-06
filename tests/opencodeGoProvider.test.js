const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenCodeGoProvider } = require('../dist/main/providers/opencode-go');

const messages = [{ role: 'system', content: 'Jarvis' }, { role: 'user', content: 'Help' }];
const options = { conversationId: 'stable-conversation' };
const completed = output => ({ type: 'response.completed', response: {
  status: 'completed', usage: { input_tokens: 10, output_tokens: 20 },
  ...(output === undefined ? {} : { output }),
} });
const textItem = (text, phase = 'final_answer') => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', phase,
  content: [{ type: 'output_text', text, annotations: [] }],
});
const functionItem = {
  type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"test"}', status: 'completed',
};
const reasoningItem = {
  type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'opaque-state',
};
const encodeEvents = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

function mockFetch(t, events, { split = false, raw, close = true } = {}) {
  const calls = [];
  let cancellations = 0;
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const bytes = new TextEncoder().encode(raw ?? encodeEvents(events));
    const body = new ReadableStream({
      start(controller) {
        if (split) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        } else {
          controller.enqueue(bytes);
        }
        if (close) controller.close();
      },
      cancel() { cancellations++; },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return { calls, get cancellations() { return cancellations; } };
}

async function stream(provider, model = 'gpt-6-luna', history = messages, chunks = [], controller = new AbortController()) {
  return provider.streamChat(model, history, controller, chunk => chunks.push(chunk), options);
}

test('reasoning, phases and call IDs survive stateless tool continuations in native order', async t => {
  const output = [reasoningItem, textItem('Looking it up.', 'commentary'), functionItem];
  const fixture = mockFetch(t, [
    { type: 'response.output_item.done', output_index: 2, item: functionItem },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    completed(output),
  ]);
  const provider = new OpenCodeGoProvider('test-key');
  const first = await stream(provider);
  assert.deepEqual(first.assistantMessage.openCodeGoResponse, { model: 'gpt-6-luna', output });
  assert.equal(first.assistantMessage.tool_calls[0].id, 'call_1');
  assert.deepEqual(first.assistantMessage.tool_calls[0].function.arguments, { query: 'test' });
  const history = [...messages, first.assistantMessage, { role: 'tool', content: 'found', tool_call_id: 'call_1' }];
  await stream(provider, 'gpt-6-luna', history);
  const request = fixture.calls[1];
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(request.body.input, [
    { role: 'user', content: 'Help' }, ...output,
    { type: 'function_call_output', call_id: 'call_1', output: 'found' },
  ]);
  assert.equal(request.init.headers['x-opencode-session'], options.conversationId);
  assert.deepEqual(first.usage.inputTokens, 10);

  await stream(provider, 'grok-4.7', history);
  assert.equal(fixture.calls[2].body.input.some(item => item.type === 'reasoning'), false);
  assert.equal(fixture.calls[2].body.input.some(item => item.id === 'msg_1'), false);
  assert.equal(fixture.calls[2].body.input.filter(item => item.type === 'function_call').length, 1);
});

test('item-done replay snapshots work when the terminal gateway event has no output array', async t => {
  mockFetch(t, [
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
    { type: 'response.output_item.done', output_index: 1, item: functionItem },
    completed(),
  ]);
  const result = await stream(new OpenCodeGoProvider('test-key'));
  assert.deepEqual(result.assistantMessage.openCodeGoResponse.output, [reasoningItem, functionItem]);
  assert.equal(result.assistantMessage.tool_calls.length, 1);
});

test('function argument deltas are finalized once after a completed response', async t => {
  mockFetch(t, [
    { type: 'response.output_item.added', output_index: 0, item: { ...functionItem, arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"query":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"test"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: functionItem.arguments },
    { type: 'response.output_item.done', output_index: 0, item: functionItem }, completed([functionItem]),
  ]);
  const result = await stream(new OpenCodeGoProvider('test-key'));
  assert.equal(result.assistantMessage.tool_calls.length, 1);
  assert.deepEqual(result.assistantMessage.tool_calls[0].function.arguments, { query: 'test' });
});

test('early EOF rejects even after complete-looking tool arguments, without retrying or returning executable tools', async t => {
  const fixture = mockFetch(t, [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial text' },
    { type: 'response.output_item.done', output_index: 1, item: functionItem },
  ]);
  const chunks = [];
  await assert.rejects(stream(new OpenCodeGoProvider('test-key'), 'gpt-6-luna', messages, chunks), /connection ended before the response completed/);
  assert.equal(chunks.map(chunk => chunk.content).join(''), 'Partial text');
  assert.equal(fixture.calls.length, 1);
});

test('incomplete responses report the reason and cancel an open stream', async t => {
  const fixture = mockFetch(t, [
    { type: 'response.output_text.delta', delta: 'Partial' },
    { type: 'response.output_item.done', output_index: 1, item: functionItem },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ], { close: false });
  await assert.rejects(stream(new OpenCodeGoProvider('test-key')), /stopped early \(max_output_tokens\)/);
  assert.equal(fixture.cancellations, 1);
  assert.equal(fixture.calls.length, 1);
});

test('provider failures and error events reject with the provider explanation', async t => {
  mockFetch(t, [{ type: 'response.failed', response: { error: { message: 'upstream failed' } } }]);
  await assert.rejects(stream(new OpenCodeGoProvider('test-key')), /upstream failed/);
});

test('error events cancel the response body without a retry', async t => {
  const fixture = mockFetch(t, [{ type: 'error', message: 'rate limited' }], { close: false });
  await assert.rejects(stream(new OpenCodeGoProvider('test-key')), /rate limited/);
  assert.equal(fixture.cancellations, 1);
  assert.equal(fixture.calls.length, 1);
});

test('completion does not wait for the server to close its connection', async t => {
  const fixture = mockFetch(t, [completed([textItem('Done')])], { close: false });
  const result = await stream(new OpenCodeGoProvider('test-key'));
  assert.equal(result.assistantMessage.content, 'Done');
  assert.equal(fixture.cancellations, 1);
});

test('cancellation remains an AbortError and keeps already emitted text', async t => {
  const fixture = mockFetch(t, [{ type: 'response.output_text.delta', delta: 'Partial' }], { close: false });
  const controller = new AbortController();
  const chunks = [];
  await assert.rejects(new OpenCodeGoProvider('test-key').streamChat('gpt-6-luna', messages, controller, chunk => {
    chunks.push(chunk);
    controller.abort();
  }, options), { name: 'AbortError' });
  assert.equal(chunks[0].content, 'Partial');
  assert.equal(fixture.cancellations, 1);
});

test('malformed streams fail instead of reporting successful empty output', async t => {
  mockFetch(t, [], { raw: 'data: {invalid}\n\n' });
  await assert.rejects(stream(new OpenCodeGoProvider('test-key')), /malformed Responses stream/);
});

test('refusal deltas are visible and final snapshots do not duplicate them', async t => {
  const refusal = { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot help.' }] };
  mockFetch(t, [
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot ' },
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'help.' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Cannot help.' },
    { type: 'response.output_item.done', output_index: 0, item: refusal }, completed([refusal]),
  ]);
  const chunks = [];
  const result = await stream(new OpenCodeGoProvider('test-key'), 'gpt-6-luna', messages, chunks);
  assert.equal(result.assistantMessage.content, 'Cannot help.');
  assert.equal(chunks.map(chunk => chunk.content).join(''), 'Cannot help.');
});

test('done-only refusal parts and multiple text parts are not lost', async t => {
  mockFetch(t, [
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'First. ' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'First. ' },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Second. ' },
    { type: 'response.refusal.done', output_index: 1, content_index: 1, refusal: 'Cannot help.' },
    completed(),
  ]);
  const result = await stream(new OpenCodeGoProvider('test-key'));
  assert.equal(result.assistantMessage.content, 'First. Second. Cannot help.');
});

test('split UTF-8 chunks and a terminal event without a final newline are parsed', async t => {
  const raw = encodeEvents([{ type: 'response.output_text.delta', delta: 'Café ☕' }])
    + `data: ${JSON.stringify(completed())}`;
  mockFetch(t, [], { raw, split: true });
  const result = await stream(new OpenCodeGoProvider('test-key'));
  assert.equal(result.assistantMessage.content, 'Café ☕');
});

test('non-streaming title/summary responses concatenate all text parts and messages only', async t => {
  const requests = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ status: 'completed', output_text: 'do not duplicate', output: [
      { type: 'reasoning', content: [{ type: 'output_text', text: 'private reasoning' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Database: ' }, { type: 'output_text', text: 'PostgreSQL. ' }] },
      { type: 'function_call', name: 'lookup', arguments: '{}' },
      textItem('EU hosting required.'),
    ] });
  });
  const provider = new OpenCodeGoProvider('test-key');
  assert.equal(await provider.sendChat('gpt-6-luna', messages, options), 'Database: PostgreSQL. EU hosting required.');
  assert.equal(requests[0].stream, false);
});

test('non-streaming refusals are visible', async t => {
  t.mock.method(global, 'fetch', async () => Response.json({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'refusal', refusal: 'Cannot help.' }] },
  ] }));
  assert.equal(await new OpenCodeGoProvider('test-key').sendChat('gpt-6-luna', messages, options), 'Cannot help.');
});

test('non-streaming incomplete summaries fail rather than replace history with partial text', async t => {
  t.mock.method(global, 'fetch', async () => Response.json({
    status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [textItem('Partial summary')],
  }));
  await assert.rejects(new OpenCodeGoProvider('test-key').sendChat('gpt-6-luna', messages, options), /max_output_tokens/);
});

test('non-streaming top-level text fallback remains supported', async t => {
  t.mock.method(global, 'fetch', async () => Response.json({ status: 'completed', output_text: 'Gateway fallback' }));
  assert.equal(await new OpenCodeGoProvider('test-key').sendChat('gpt-6-luna', messages, options), 'Gateway fallback');
});

test('malformed tool arguments cannot turn a completed stream into an executable empty call', async t => {
  mockFetch(t, [completed([{ ...functionItem, arguments: '{invalid}' }])]);
  await assert.rejects(stream(new OpenCodeGoProvider('test-key')), /invalid arguments for lookup/);
});

test('all 30 documented Go models route both request modes with stable session and client headers', async t => {
  const groups = {
    responses: ['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'],
    messages: ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus'],
    'chat/completions': ['glm-5.3-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'longcat-2.0',
      'longcat-2.5-preview-free', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
      'mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.5', 'mimo-v2.5-pro', 'hy4-preview', 'hy3', 'space-bunny-free'],
  };
  let endpoint;
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(url, `https://opencode.ai/zen/go/v1/${endpoint}`);
    assert.equal(init.headers['x-opencode-session'], options.conversationId);
    assert.equal(init.headers['User-Agent'], 'jarvis/1.0.0');
    const body = JSON.parse(init.body);
    if (!body.stream) return Response.json(endpoint === 'responses' ? { output: [textItem('ok')] }
      : endpoint === 'messages' ? { content: [{ type: 'text', text: 'ok' }] } : { choices: [{ message: { content: 'ok' } }] });
    const events = endpoint === 'responses' ? [completed([textItem('ok')])]
      : endpoint === 'messages' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  const catalog = await new OpenCodeGoProvider().fetchModels();
  const provider = new OpenCodeGoProvider('test-key');
  for (const [path, models] of Object.entries(groups)) {
    endpoint = path;
    for (const model of models) {
      assert.ok(catalog.some(item => item.id === model));
      assert.equal(await provider.sendChat(model, messages, options), 'ok');
      assert.equal((await stream(provider, model)).assistantMessage.content, 'ok');
    }
  }
});
