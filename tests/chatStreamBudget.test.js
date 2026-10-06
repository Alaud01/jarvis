const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { MAX_MODEL_ROUNDS_PER_TURN, MAX_TOOL_CALLS_PER_TURN, MAX_TURN_DURATION_MS } = require('../dist/main/tools/turnBudget');

function harness(provider, overrides = {}) {
  const handlers = new Map();
  const events = [];
  const streams = new Map();
  const deps = {
    electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    '../providers/registry': { getProvider: () => provider, getCachedModel: () => ({ contextLength: 1_000_000 }) },
    '../contextCompaction': {
      compactMessagesIfNeeded: async messages => messages,
      estimateTotalTokens: () => 1,
      getContextThresholdTokens: () => 900_000,
    },
    '../browserControlService': { closeBrowserControl: async () => {} },
    '../systemPrompt': { buildSystemPrompt: async () => ({ role: 'system', content: 'Jarvis' }) },
    '../tools/chatTools': {
      getChatTools: () => [{ type: 'function', function: { name: 'tavily_search' } }],
      BROWSER_CONTROL_TOOL_NAMES: new Set(),
      MAX_TAVILY_SEARCH_CALLS_PER_TURN: 5,
      MAX_FETCH_URL_CALLS_PER_TURN: 5,
      MAX_NOTION_CALLS_PER_TURN: 16,
    },
    '../tools/dispatcher': {
      isAbortLikeError: error => error?.name === 'AbortError',
      requiresToolResultSynthesis: () => false,
      buildToolResultSynthesisMessages: (messages, assistant, results) => [...messages, assistant, ...results],
      parseTavilySearchToolArgs: () => ({ query: 'test' }),
      formatTavilySearchToolResult: () => 'search results',
      createSearchSourceGroup: () => null,
    },
    '../notionMcpService': { isNotionToolName: () => false },
    '../tavilySearchService': { tavilySearch: async () => ({ success: true }) },
    '../fetchService': {},
    '../app/lifecycle': { logMainProcess: () => {}, CHAT_MODEL_KEEP_ALIVE: '5m' },
    '../usageService': { recordResolvedTurnUsage: () => {} },
    ...overrides,
  };
  const modulePath = require.resolve('../dist/main/ipc/chatStreamHandler');
  delete require.cache[modulePath];
  const load = Module._load;
  try {
    Module._load = function(request, parent, isMain) {
      if (parent?.filename === modulePath && deps[request]) return deps[request];
      return load.call(this, request, parent, isMain);
    };
    require(modulePath).registerChatStreamHandler(streams);
  } finally {
    Module._load = load;
  }
  return {
    streams,
    events,
    run: () => handlers.get('send-message-stream')({
      sender: { isDestroyed: () => false, send: (channel, payload) => events.push({ channel, payload }) },
    }, { conversationId: 'chat', assistantMessageId: 'answer', model: 'model', provider: 'test', messages: [] }),
  };
}

const toolResult = (count = 1, name = 'tavily_search') => ({ assistantMessage: {
  role: 'assistant', content: '', tool_calls: Array.from({ length: count }, (_, i) => ({
    id: `tool-${i}`, type: 'function', function: { name, arguments: {} },
  })),
} });

test('repeated individually limited tools end with exactly one tools-disabled synthesis', async () => {
  let rounds = 0;
  let searches = 0;
  const optionsSeen = [];
  const provider = { streamChat: async (_model, _messages, _controller, _onChunk, options) => {
    rounds++;
    assert.ok(rounds <= MAX_MODEL_ROUNDS_PER_TURN + 1, 'unbounded model loop');
    optionsSeen.push(options);
    return options.tools === null ? { assistantMessage: { role: 'assistant', content: 'summary' } } : toolResult();
  } };
  const runner = harness(provider, { '../tavilySearchService': {
    tavilySearch: async () => { searches++; return { success: true }; },
  } });
  assert.equal((await runner.run()).success, true);
  assert.equal(rounds, MAX_MODEL_ROUNDS_PER_TURN + 1);
  assert.equal(searches, 5);
  assert.equal(optionsSeen.filter(options => options.tools === null).length, 1);
  assert.equal(runner.streams.size, 0);
});

test('a large batch exhausts the aggregate call budget and immediately requests synthesis', async () => {
  let rounds = 0;
  const provider = { streamChat: async (_model, _messages, _controller, _onChunk, options) => {
    assert.ok(++rounds <= 2);
    return options.tools === null ? { assistantMessage: { role: 'assistant', content: 'done' } }
      : toolResult(MAX_TOOL_CALLS_PER_TURN + 8, 'unknown_tool');
  } };
  await harness(provider).run();
  assert.equal(rounds, 2);
});

for (const finalReason of ['budget', 'model policy']) {
  test(`image-rejecting ${finalReason} synthesis retries once with text tool results`, async () => {
    const dispatcher = require('../dist/main/tools/dispatcher');
    let modelRounds = 0;
    let synthesisAttempts = 0;
    const provider = { streamChat: async (_model, messages, _controller, onChunk, options) => {
      if (options.tools !== null) {
        modelRounds++;
        return toolResult(finalReason === 'budget' ? MAX_TOOL_CALLS_PER_TURN : 1, 'browser_screenshot');
      }
      synthesisAttempts++;
      if (messages.some(message => message.images?.length)) {
        throw new Error('OpenCode Go request failed (400): model does not accept image input');
      }
      assert.ok(messages.some(message => message.content.includes('Screenshot page text')));
      assert.ok(messages.some(message => message.content.includes('does not accept image input')));
      onChunk({ type: 'content', content: 'Text summary' });
      return { assistantMessage: { role: 'assistant', content: 'Text summary' } };
    } };
    const runner = harness(provider, {
      '../tools/chatTools': {
        getChatTools: () => [], BROWSER_CONTROL_TOOL_NAMES: new Set(['browser_screenshot']),
      },
      '../tools/dispatcher': {
        ...dispatcher,
        requiresToolResultSynthesis: () => finalReason === 'model policy',
        runBrowserControlTool: async () => ({ success: true, imageDataUrl: 'data:image/png;base64,AAAA' }),
        formatBrowserControlResult: () => 'Screenshot page text',
      },
    });
    assert.equal((await runner.run()).success, true);
    assert.equal(modelRounds, 1);
    assert.equal(synthesisAttempts, 2);
    assert.equal(runner.events.some(event => event.channel === 'ollama-error'), false);
    assert.ok(runner.events.some(event => event.payload.chunk === 'Text summary'));
  });
}

test('cancellation during a tool prevents later tools and model turns', async () => {
  let controller;
  let rounds = 0;
  let searches = 0;
  const provider = { streamChat: async (_model, _messages, value) => {
    controller = value;
    rounds++;
    return toolResult(3);
  } };
  const runner = harness(provider, { '../tavilySearchService': {
    tavilySearch: async (_args, signal) => {
      searches++;
      assert.equal(signal, controller.signal);
      controller.abort();
      return { success: true };
    },
  } });
  assert.equal((await runner.run()).aborted, true);
  assert.equal(searches, 1);
  assert.equal(rounds, 1);
  assert.equal(runner.streams.size, 0);
});

test('threaded tool callbacks interrupt their provider when the aggregate budget is exhausted', async () => {
  let calls = 0;
  const provider = { conversationMode: 'threaded', streamChat: async (_model, _messages, controller, _onChunk, options) => {
    for (let i = 0; i <= MAX_TOOL_CALLS_PER_TURN; i++) {
      calls++;
      await options.executeTool('unknown_tool', {});
    }
    assert.fail('provider was not interrupted');
  } };
  const runner = harness(provider);
  assert.equal((await runner.run()).aborted, true);
  assert.equal(calls, MAX_TOOL_CALLS_PER_TURN + 1);
  assert.ok(runner.events.some(event => event.payload.chunk?.includes('tool limit')));
  assert.equal(runner.streams.size, 0);
});

test('the overall deadline aborts a stalled provider and explains the stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const provider = { streamChat: async (_model, _messages, controller) => {
    started();
    return new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason)));
  } };
  const runner = harness(provider);
  const result = runner.run();
  await ready;
  t.mock.timers.tick(MAX_TURN_DURATION_MS);
  assert.equal((await result).aborted, true);
  assert.ok(runner.events.some(event => event.payload.chunk?.includes('time limit')));
  assert.equal(runner.streams.size, 0);
});
