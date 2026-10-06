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
  linkSharedCodexAuth,
  resolveBundledCodexBinary,
  resolveCodexSwitcherAuthPath,
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

test('serializes only HTTP image URLs in Codex dynamic tool results', () => {
  assert.deepEqual(buildCodexDynamicToolContentItems({
    success: true,
    content: 'Screenshot captured.',
    imageUrls: [
      '/Users/example/browser-screenshot.png',
      'data:image/png;base64,aGVsbG8=',
      'https://example.com/screenshot.png',
      'http://example.com/screenshot.jpg',
      'file:///Users/example/browser-screenshot.png',
    ],
  }), [
    { type: 'inputText', text: 'Screenshot captured.' },
    { type: 'inputImage', imageUrl: 'https://example.com/screenshot.png' },
    { type: 'inputImage', imageUrl: 'http://example.com/screenshot.jpg' },
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

    // Same user payloads and positions, but a different assistant branch.
    await provider.streamChat(
      'codex:gpt-test',
      [...editedMessages, { role: 'assistant', content: 'Different answer' }, { role: 'user', content: 'Continue' }],
      abortController,
      () => undefined,
      { ...options, contextKey: 'alternate-answer' },
    );
    assert.equal(replayPreparations, 3);

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
          imageUrls: ['https://example.com/browser-screenshot.png'],
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

async function writeAuth(authPath, accountId) {
  await fs.mkdir(path.dirname(authPath), { recursive: true });
  await fs.writeFile(authPath, JSON.stringify({ tokens: { account_id: accountId } }));
}

test('follows Codex Switcher only when it is installed and not opted out', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-switcher-home-'));
  try {
    assert.equal(resolveCodexSwitcherAuthPath(home, {}), undefined);
    await writeAuth(path.join(home, '.codex-switcher', 'accounts.json'), 'unused');
    assert.equal(resolveCodexSwitcherAuthPath(home, {}), path.join(home, '.codex', 'auth.json'));
    assert.equal(resolveCodexSwitcherAuthPath(home, { JARVIS_CODEX_PRIVATE_AUTH: '1' }), undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('links the private runtime auth to the shared file and keeps the old login', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-link-'));
  const codexHome = path.join(temporaryRoot, 'codex-home');
  const sharedAuthPath = path.join(temporaryRoot, 'shared', 'auth.json');
  try {
    await writeAuth(path.join(codexHome, 'auth.json'), 'private-account');
    await writeAuth(sharedAuthPath, 'shared-account');

    await linkSharedCodexAuth(codexHome, sharedAuthPath);
    await linkSharedCodexAuth(codexHome, sharedAuthPath);

    assert.equal(await fs.readlink(path.join(codexHome, 'auth.json')), sharedAuthPath);
    const backup = JSON.parse(await fs.readFile(path.join(codexHome, 'auth.json.jarvis-private'), 'utf8'));
    assert.equal(backup.tokens.account_id, 'private-account');
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('restarts the app-server when Codex Switcher changes the active account', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-switch-'));
  const sharedAuthPath = path.join(temporaryRoot, 'shared', 'auth.json');
  const client = new CodexAppServerClient({
    binaryPath: path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js'),
    codexHome: path.join(temporaryRoot, 'codex-home'),
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => undefined,
    sharedAuthPath,
  });

  try {
    await writeAuth(sharedAuthPath, 'first-account');
    assert.equal((await client.getAccountStatus()).email, 'first-account@example.com');

    await writeAuth(sharedAuthPath, 'second-account');
    assert.equal((await client.getAccountStatus()).email, 'second-account@example.com');

    await assert.rejects(client.logout(), /Codex Switcher/);
  } finally {
    await client.stop();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('retries a usage-limited turn on the account Codex Switcher moved to', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-codex-limit-'));
  const sharedAuthPath = path.join(temporaryRoot, 'shared', 'auth.json');
  const provider = new CodexProvider({
    binaryPath: path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js'),
    codexHome: path.join(temporaryRoot, 'codex-home'),
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => undefined,
    sharedAuthPath,
  });
  const options = {
    conversationId: 'conversation-limit',
    tools: CHAT_TOOLS,
    executeTool: async () => ({ success: true, content: 'opened' }),
  };
  const messages = [{ role: 'user', content: 'Question' }];
  const streamOnce = () => provider.streamChat(
    'codex:gpt-test',
    messages,
    new AbortController(),
    () => undefined,
    options,
  );

  try {
    await writeAuth(sharedAuthPath, 'exhausted-account');
    await assert.rejects(streamOnce(), /usage limit[\s\S]*Switch to another account in Codex Switcher/);

    await provider.shutdown();
    process.env.FAKE_CODEX_SWITCH_ACCOUNT_ON_LIMIT = 'fresh-account';
    const result = await streamOnce();
    assert.equal(result.assistantMessage.content, 'Tool completed.');
    assert.equal((await provider.getAccountStatus()).email, 'fresh-account@example.com');
  } finally {
    delete process.env.FAKE_CODEX_SWITCH_ACCOUNT_ON_LIMIT;
    await provider.shutdown();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
