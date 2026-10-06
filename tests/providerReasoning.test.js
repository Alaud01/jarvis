const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenCodeGoProvider } = require('../dist/main/providers/opencode-go');
const { OllamaProvider, parseOllamaThinkingSupport } = require('../dist/main/providers/ollama');
const { parseModelsDevGoCatalog } = require('../dist/main/providers/opencodeGoReasoning');

const messages = [{ role: 'user', content: 'Help' }];
const options = { conversationId: 'stable-conversation' };

function streamBody(endpoint) {
  const events = endpoint === 'responses'
    ? [{ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ] } }]
    : endpoint === 'messages'
      ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' }]
      : [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function captureGoRequests(t) {
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const endpoint = String(url).split('/v1/')[1];
    bodies.push({ endpoint, body: JSON.parse(init.body) });
    return new Response(streamBody(endpoint));
  });
  return bodies;
}

async function goRequest(t, model, reasoningEffort) {
  const bodies = captureGoRequests(t);
  await new OpenCodeGoProvider('test-key').streamChat(model, messages, new AbortController(), () => {}, {
    ...options, reasoningEffort,
  });
  return bodies[0];
}

test('Go catalog exposes reasoning levels for every model that supports a choice', async () => {
  const catalog = await new OpenCodeGoProvider().fetchModels();
  const efforts = id => catalog.find(model => model.id === id)?.reasoningEfforts?.map(option => option.value);
  const defaultEffort = id => catalog.find(model => model.id === id)?.defaultReasoningEffort;

  assert.deepEqual(efforts('gpt-6-luna'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(defaultEffort('gpt-6-luna'), 'medium');
  assert.deepEqual(efforts('grok-4.7'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(efforts('muse-spark-1.3-contributor'), ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(efforts('glm-5.3'), ['low', 'high', 'max']);
  assert.equal(defaultEffort('glm-5.3'), 'high');
  assert.deepEqual(efforts('qwen3.8-max'), ['none', 'low', 'medium', 'xhigh']);
  assert.deepEqual(efforts('qwen3.7-plus'), ['none', 'low', 'medium', 'high']);
  assert.equal(defaultEffort('qwen3.7-plus'), 'high');
  assert.deepEqual(efforts('longcat-2.0'), ['none', 'on']);
  assert.equal(defaultEffort('longcat-2.0'), 'on');
  assert.deepEqual(efforts('minimax-m3'), ['none', 'on']);
  assert.equal(defaultEffort('minimax-m3'), 'none');

  // Fixed reasoning or no reasoning: the selector stays locked.
  for (const id of ['kimi-k3', 'kimi-k2.6', 'mimo-v2.6-pro', 'minimax-m2.7']) {
    assert.equal(efforts(id), undefined, id);
  }
});

test('Go requests send the selected effort in each endpoint format', async t => {
  assert.deepEqual((await goRequest(t, 'gpt-6-luna', 'max')).body.reasoning, { effort: 'max' });
  t.mock.restoreAll();
  assert.equal((await goRequest(t, 'glm-5.3', 'low')).body.reasoning_effort, 'low');
  t.mock.restoreAll();
  assert.deepEqual((await goRequest(t, 'qwen3.8-max', 'xhigh')).body.output_config, { effort: 'xhigh' });
  t.mock.restoreAll();
  assert.deepEqual((await goRequest(t, 'qwen3.8-max', 'none')).body.thinking, { type: 'disabled' });
  t.mock.restoreAll();
  assert.deepEqual((await goRequest(t, 'qwen3.7-plus', 'low')).body.thinking, { type: 'enabled', budget_tokens: 1024 });
  t.mock.restoreAll();
  assert.deepEqual((await goRequest(t, 'minimax-m3', 'on')).body.thinking, { type: 'enabled', budget_tokens: 4096 });
  t.mock.restoreAll();
  assert.deepEqual((await goRequest(t, 'longcat-2.0', 'none')).body.thinking, { type: 'disabled' });
});

test('Go requests fall back to the model default for unsupported or missing efforts', async t => {
  assert.deepEqual((await goRequest(t, 'grok-4.7', 'max')).body.reasoning, { effort: 'medium' });
  t.mock.restoreAll();
  assert.equal((await goRequest(t, 'deepseek-v4-pro', undefined)).body.reasoning_effort, 'high');
  t.mock.restoreAll();
  const kimi = (await goRequest(t, 'kimi-k3', 'max')).body;
  assert.equal(kimi.reasoning_effort, undefined);
  assert.equal(kimi.thinking, undefined);
});

test('models.dev catalog parsing reads effort, toggle and budget options', () => {
  const catalog = parseModelsDevGoCatalog({ 'opencode-go': { models: {
    'new-model': { reasoning: true, provider: { npm: '@ai-sdk/anthropic' }, reasoning_options: [
      { type: 'toggle' }, { type: 'effort', values: ['low', 'high'] }, { type: 'budget_tokens', max: 1000 },
    ] },
    plain: { reasoning: false, reasoning_options: [{ type: 'effort', values: ['low'] }] },
  } } });
  assert.deepEqual(catalog.get('new-model'), {
    reasoning: { toggle: true, efforts: ['low', 'high'], budget: true }, npm: '@ai-sdk/anthropic',
  });
  assert.deepEqual(catalog.get('plain').reasoning, {});
});

test('Ollama thinking support comes from /api/show levels or the thinking capability', () => {
  assert.deepEqual(parseOllamaThinkingSupport({
    capabilities: ['thinking'], thinking: { values: [false, 'low', 'high', 'max'], default: 'max' },
  }), { values: ['none', 'low', 'high', 'max'], defaultValue: 'max' });
  assert.deepEqual(parseOllamaThinkingSupport({ capabilities: ['completion', 'thinking'] }),
    { values: ['none', 'on'], defaultValue: 'on' });
  assert.equal(parseOllamaThinkingSupport({ capabilities: ['completion', 'tools'] }), null);
});

test('Ollama lists thinking levels and sends the selected think value', async t => {
  const prev = process.env.OLLAMA_INCLUDE_CLOUD_MODELS;
  process.env.OLLAMA_INCLUDE_CLOUD_MODELS = 'false';
  t.after(() => {
    if (prev === undefined) delete process.env.OLLAMA_INCLUDE_CLOUD_MODELS;
    else process.env.OLLAMA_INCLUDE_CLOUD_MODELS = prev;
  });
  const chats = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'gpt-oss:20b' }, { name: 'llama3:8b' }] });
    const body = JSON.parse(init.body);
    if (url.endsWith('/api/show')) {
      return Response.json(body.model === 'gpt-oss:20b'
        ? { capabilities: ['thinking'], thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }
        : { capabilities: ['completion'] });
    }
    chats.push(body);
    return new Response(`${JSON.stringify({ message: { content: 'ok' }, done: true })}\n`);
  });
  const provider = new OllamaProvider('http://ollama.test');
  const models = await provider.fetchModels();
  assert.deepEqual(models.find(model => model.id === 'gpt-oss:20b').reasoningEfforts.map(option => option.value),
    ['low', 'medium', 'high']);
  assert.equal(models.find(model => model.id === 'llama3:8b').reasoningEfforts, undefined);

  await provider.streamChat('gpt-oss:20b', messages, new AbortController(), () => {}, { reasoningEffort: 'high' });
  await provider.streamChat('llama3:8b', messages, new AbortController(), () => {}, { reasoningEffort: 'high' });
  assert.equal(chats[0].think, 'high');
  assert.equal('think' in chats[1], false);
});
