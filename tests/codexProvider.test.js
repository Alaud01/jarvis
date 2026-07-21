const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  buildChatGptLoginParams,
  buildCodexDynamicToolContentItems,
  buildIsolatedCodexEnvironment,
  CodexAppServerClient,
  isMissingThreadError,
  resolveBundledCodexBinary,
} = require('../dist/main/codexAppServer');
const {
  buildCodexTurnInput,
  CodexProvider,
  fingerprintCodexDynamicTools,
  fingerprintCodexMessagePrefix,
  fromCodexModelId,
  isCodexThreadRecordSynchronized,
  toCodexDynamicTools,
  toCodexModelId,
} = require('../dist/main/providers/codex');
const { CHAT_TOOLS } = require('../dist/main/tools/chatTools');

test('keeps Codex model ids distinct from other Jarvis providers', () => {
  assert.equal(toCodexModelId('gpt-5.4'), 'codex:gpt-5.4');
  assert.equal(fromCodexModelId('codex:gpt-5.4'), 'gpt-5.4');
  assert.equal(fromCodexModelId('custom-model'), 'custom-model');
});

test('isolates Codex state and ignores parent-shell OpenAI credentials', () => {
  const original = {
    PATH: '/usr/bin',
    CODEX_HOME: '/Users/example/.codex',
    CODEX_SQLITE_HOME: '/Users/example/.codex',
    OPENAI_API_KEY: 'must-not-leak',
  };
  const environment = buildIsolatedCodexEnvironment(original, '/tmp/jarvis/codex-runtime');

  assert.equal(environment.CODEX_HOME, '/tmp/jarvis/codex-runtime');
  assert.equal(environment.CODEX_SQLITE_HOME, '/tmp/jarvis/codex-runtime');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(original.OPENAI_API_KEY, 'must-not-leak');
});

test('uses the local Codex login completion page instead of a hosted app handoff', () => {
  assert.deepEqual(buildChatGptLoginParams(), {
    type: 'chatgpt',
    useHostedLoginSuccessPage: false,
  });
});

test('recognizes missing Codex rollouts so stale threads can be recreated', () => {
  assert.equal(
    isMissingThreadError(new Error(
      'CodexAppServerError: no rollout found for thread id 019f5d0b-0d7b-74d0-8645-99b8141cc310',
    )),
    true,
  );
  assert.equal(isMissingThreadError(new Error('permission denied')), false);
});

test('sends only the unsynchronized Jarvis messages on a follow-up Codex turn', () => {
  const messages = [
    { role: 'system', content: 'Jarvis system prompt' },
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Follow-up question' },
  ];

  const initial = buildCodexTurnInput(messages, 0);
  assert.match(initial.input[0].text, /First question/);
  assert.match(initial.input[0].text, /First answer/);
  assert.match(initial.input[0].text, /Follow-up question/);
  assert.equal(initial.conversationMessageCount, 3);

  const followUp = buildCodexTurnInput(messages, 2);
  assert.equal(followUp.input[0].text, 'Follow-up question');
  assert.equal(followUp.conversationMessageCount, 3);
});

test('passes user images to app-server without exposing system messages', () => {
  const built = buildCodexTurnInput([
    { role: 'system', content: 'private instructions' },
    {
      role: 'user',
      content: 'Describe this',
      images: ['abc123'],
      imageMimeTypes: ['image/jpeg'],
    },
  ], 0);

  assert.equal(built.input[0].text.includes('private instructions'), false);
  assert.deepEqual(built.input[1], {
    type: 'image',
    url: 'data:image/jpeg;base64,abc123',
  });
});

test('serializes only valid image URLs in Codex dynamic tool results', () => {
  assert.deepEqual(buildCodexDynamicToolContentItems({
    success: true,
    content: 'Screenshot captured.',
    imageUrls: [
      '/Users/example/browser-screenshot.png',
      'data:image/png;base64,aGVsbG8=',
      'https://example.com/screenshot.png',
    ],
  }), [
    { type: 'inputText', text: 'Screenshot captured.' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' },
    { type: 'inputImage', imageUrl: 'https://example.com/screenshot.png' },
  ]);
});

test('resolves the Codex executable from Jarvis dependencies', () => {
  const binary = resolveBundledCodexBinary();
  assert.match(binary, /@openai/);
  assert.match(binary, /codex(?:\.exe)?$/);
});

test('exposes the complete Jarvis tool catalog in a Codex namespace', () => {
  const dynamicTools = toCodexDynamicTools(CHAT_TOOLS);
  assert.equal(dynamicTools.length, 1);
  assert.equal(dynamicTools[0].type, 'namespace');
  assert.equal(dynamicTools[0].name, 'jarvis');
  assert.deepEqual(
    dynamicTools[0].tools.map(tool => tool.name),
    CHAT_TOOLS.map(tool => tool.function.name),
  );
  assert.deepEqual(
    dynamicTools[0].tools[0].inputSchema,
    CHAT_TOOLS[0].function.parameters,
  );
});

test('changes the persisted Codex tool fingerprint when a tool schema changes', () => {
  const dynamicTools = toCodexDynamicTools(CHAT_TOOLS);
  const changedTools = structuredClone(dynamicTools);
  changedTools[0].tools[0].description += ' Changed.';

  assert.notEqual(
    fingerprintCodexDynamicTools(dynamicTools),
    fingerprintCodexDynamicTools(changedTools),
  );
});

test('invalidates a persisted Codex thread when synchronized history is edited', () => {
  const tools = toCodexDynamicTools(CHAT_TOOLS);
  const toolSchemaFingerprint = fingerprintCodexDynamicTools(tools);
  const originalMessages = [
    { role: 'system', content: 'Jarvis instructions' },
    { role: 'user', content: 'Original question' },
    { role: 'assistant', content: 'Original answer' },
    { role: 'user', content: 'Follow-up' },
  ];
  const record = {
    threadId: 'thread-test',
    syncedMessageCount: 2,
    syncedPrefixFingerprint: fingerprintCodexMessagePrefix(originalMessages, 2),
    toolSchemaFingerprint,
  };

  assert.equal(
    isCodexThreadRecordSynchronized(record, originalMessages, toolSchemaFingerprint),
    true,
  );

  const rendererDecoratedMessages = structuredClone(originalMessages);
  rendererDecoratedMessages[2].content = 'Thinking...\ninternal commentary\n...done thinking.\nOriginal answer';
  assert.equal(
    isCodexThreadRecordSynchronized(record, rendererDecoratedMessages, toolSchemaFingerprint),
    true,
  );

  const editedMessages = structuredClone(originalMessages);
  editedMessages[1].content = 'Edited question with the same message count';
  assert.equal(
    isCodexThreadRecordSynchronized(record, editedMessages, toolSchemaFingerprint),
    false,
  );
  assert.equal(
    isCodexThreadRecordSynchronized(record, originalMessages, `${toolSchemaFingerprint}-changed`),
    false,
  );
});

test('clears persisted Codex thread mappings before account logout', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-logout-'));
  const binaryPath = path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js');
  const client = new CodexAppServerClient({
    binaryPath,
    codexHome: path.join(temporaryRoot, 'codex-home'),
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => undefined,
  });

  try {
    await client.saveConversationThread('conversation-secret', {
      threadId: 'thread-secret',
      syncedMessageCount: 2,
      syncedPrefixFingerprint: 'prefix-fingerprint',
      toolSchemaFingerprint: 'tool-fingerprint',
    });
    assert.ok(await client.getConversationThread('conversation-secret'));

    await client.logout();

    assert.equal(await client.getConversationThread('conversation-secret'), null);
    const state = JSON.parse(await fs.readFile(
      path.join(temporaryRoot, 'codex-home', 'jarvis-thread-map.json'),
      'utf8',
    ));
    assert.deepEqual(state.conversations, {});
    assert.deepEqual(state.pendingDeleteThreadIds, []);
  } finally {
    await client.stop();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('prepares replay history only for new or invalidated Codex threads', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-replay-'));
  const binaryPath = path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js');
  const provider = new CodexProvider({
    binaryPath,
    codexHome: path.join(temporaryRoot, 'codex-home'),
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => undefined,
  });
  let replayPreparations = 0;
  const options = {
    conversationId: 'conversation-replay',
    tools: CHAT_TOOLS,
    executeTool: async () => ({ success: true, content: 'opened' }),
    prepareReplayMessages: async messages => {
      replayPreparations += 1;
      return messages;
    },
  };
  const abortController = new AbortController();

  try {
    const first = await provider.streamChat(
      'codex:gpt-test',
      [{ role: 'user', content: 'First question' }],
      abortController,
      () => undefined,
      options,
    );
    assert.equal(first.assistantMessage.content, 'Tool completed.');
    assert.deepEqual(first.usage, {
      inputTokens: 120,
      outputTokens: 40,
      estimated: false,
    });
    assert.equal(replayPreparations, 1);

    const secondMessages = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Tool completed.' },
      { role: 'user', content: 'Follow-up' },
    ];
    const second = await provider.streamChat(
      'codex:gpt-test',
      secondMessages,
      abortController,
      () => undefined,
      options,
    );
    assert.deepEqual(second.usage, {
      inputTokens: 120,
      outputTokens: 40,
      estimated: false,
    });
    assert.equal(replayPreparations, 1);

    const editedMessages = [
      { role: 'user', content: 'Edited first question' },
      { role: 'assistant', content: 'Tool completed.' },
      { role: 'user', content: 'Follow-up' },
      { role: 'assistant', content: 'Tool completed.' },
      { role: 'user', content: 'Another follow-up' },
    ];
    await provider.streamChat(
      'codex:gpt-test',
      editedMessages,
      abortController,
      () => undefined,
      options,
    );
    assert.equal(replayPreparations, 2);
  } finally {
    await provider.shutdown();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('round-trips a Codex dynamic tool call through the Jarvis handler', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-tools-'));
  const binaryPath = path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js');
  const client = new CodexAppServerClient({
    binaryPath,
    codexHome: path.join(temporaryRoot, 'codex-home'),
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => undefined,
  });

  try {
    const dynamicTools = toCodexDynamicTools(CHAT_TOOLS);
    const threadId = await client.startThread({
      model: 'gpt-test',
      developerInstructions: 'test',
      ephemeral: true,
      dynamicTools,
    });
    const calls = [];
    const usageUpdates = [];
    const content = await client.runTurn({
      threadId,
      model: 'gpt-test',
      input: [{ type: 'text', text: 'Open the page.', text_elements: [] }],
      onDelta: () => undefined,
      onTokenUsage: usage => usageUpdates.push(usage),
      onToolCall: async (tool, argumentsValue) => {
        calls.push({ tool, argumentsValue });
        return {
          success: true,
          content: 'opened-with-image',
          imageUrls: ['data:image/png;base64,aGVsbG8='],
        };
      },
    });

    assert.equal(content, 'Tool completed.');
    assert.deepEqual(usageUpdates, [{
      totalTokens: 160,
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 40,
      reasoningOutputTokens: 30,
    }]);
    assert.deepEqual(calls, [{
      tool: 'browser_open',
      argumentsValue: { url: 'https://example.com' },
    }]);
  } finally {
    await client.stop();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
