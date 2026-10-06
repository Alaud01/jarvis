const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { OpenCodeGoProvider } = require('../dist/main/providers/opencode-go');

function harness() {
  const handlers = new Map();
  const streams = new Map();
  const events = [];
  let searches = 0;
  const provider = new OpenCodeGoProvider('test-key');
  const dependencies = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    '../providers/registry': {
      getProvider: () => provider,
      getCachedModel: () => ({ contextLength: 1_000_000 }),
      getAllModels: async () => [{ id: 'gpt-6-luna', contextLength: 1_000_000 }],
    },
    '../contextCompaction': { estimateTotalTokens: () => 1, getContextThresholdTokens: () => 900_000 },
    '../systemPrompt': { buildSystemPrompt: async () => ({ role: 'system', content: 'Jarvis' }) },
    '../tools/chatTools': {
      getChatTools: () => [{ type: 'function', function: { name: 'tavily_search', description: 'Search', parameters: { type: 'object', properties: {} } } }],
      BROWSER_CONTROL_TOOL_NAMES: new Set(), MAX_TAVILY_SEARCH_CALLS_PER_TURN: 5,
    },
    '../tools/dispatcher': {
      isAbortLikeError: error => error?.name === 'AbortError', requiresToolResultSynthesis: () => false,
      parseTavilySearchToolArgs: args => args, formatTavilySearchToolResult: () => 'found', createSearchSourceGroup: () => null,
    },
    '../notionMcpService': { isNotionToolName: () => false },
    '../tavilySearchService': { tavilySearch: async () => { searches++; return { success: true }; } },
    '../browserControlService': {}, '../fetchService': {},
    '../app/lifecycle': { logMainProcess() {}, CHAT_MODEL_KEEP_ALIVE: '5m' },
    '../usageService': { recordResolvedTurnUsage() {} },
  };
  const filename = require.resolve('../dist/main/ipc/chatStreamHandler');
  delete require.cache[filename];
  const load = Module._load;
  try {
    Module._load = function(name, parent, isMain) {
      if (parent?.filename === filename && dependencies[name]) return dependencies[name];
      return load.call(this, name, parent, isMain);
    };
    require(filename).registerChatStreamHandler(streams);
  } finally {
    Module._load = load;
  }
  return {
    events, streams, get searches() { return searches; },
    run: () => handlers.get('send-message-stream')({ sender: {
      isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }),
    } }, { conversationId: 'chat', assistantMessageId: 'answer', model: 'gpt-6-luna', provider: 'opencode-go', messages: [{ role: 'user', content: 'Search' }] }),
  };
}

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-state' };
const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'tavily_search', arguments: '{"query":"test"}', status: 'completed' };
const encode = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));

for (const terminal of ['EOF', 'incomplete']) {
  test(`${terminal} prevents tool execution and successful done notification through IPC`, async t => {
    let requests = 0;
    t.mock.method(global, 'fetch', async () => {
      requests++;
      return encode([
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial text' },
        { type: 'response.output_item.done', output_index: 1, item: tool },
        ...(terminal === 'EOF' ? [] : [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]),
      ]);
    });
    const runner = harness();
    await assert.rejects(runner.run(), terminal === 'EOF' ? /before the response completed/ : /max_output_tokens/);
    assert.equal(runner.searches, 0);
    assert.equal(requests, 1);
    assert.equal(runner.streams.size, 0);
    assert.equal(runner.events.filter(event => event.channel === 'ollama-done').length, 0);
    assert.equal(runner.events.filter(event => event.channel === 'ollama-error').length, 1);
    assert.equal(runner.events.find(event => event.channel === 'ollama-chunk').payload.chunk, 'Partial text');
  });
}

test('the real IPC tool loop replays encrypted reasoning and call IDs on its next request', async t => {
  const requests = [];
  t.mock.method(global, 'fetch', async (_url, init) => {
    requests.push({ body: JSON.parse(init.body), headers: init.headers });
    return encode([{ type: 'response.completed', response: { status: 'completed', output: requests.length === 1
      ? [reasoning, tool] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] }] } }]);
  });
  const runner = harness();
  assert.equal((await runner.run()).success, true);
  assert.equal(runner.searches, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.input, [
    { role: 'user', content: 'Search' }, reasoning, tool,
    { type: 'function_call_output', call_id: 'call_1', output: 'found' },
  ]);
  assert.ok(requests.every(request => request.headers['x-opencode-session'] === 'chat'));
  assert.equal(runner.streams.size, 0);
  assert.equal(runner.events.filter(event => event.channel === 'ollama-done').length, 1);
});
