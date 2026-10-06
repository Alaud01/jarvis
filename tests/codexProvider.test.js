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
  CodexTurnError,
  isMissingThreadError,
  resolveBundledCodexBinary,
} = require('../dist/main/codexAppServer');
const {
  readSharedCodexCredential,
  resolveCodexSwitcherAuthPath,
  sharedCredentialIdentity,
} = require('../dist/main/codexSharedAuth');
const {
  buildCodexTurnInput,
  CodexProvider,
  isCodexUsageLimitError,
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

const FAKE_CODEX_SERVER = path.join(__dirname, 'fixtures', 'fakeCodexAppServer.js');

function fakeAccessToken(user, { workspace = 'workspace', expiresInSeconds = 3600 } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'none' }),
    encode({
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      'https://api.openai.com/auth': {
        chatgpt_account_id: workspace,
        chatgpt_user_id: user,
        chatgpt_plan_type: 'plus',
      },
    }),
    'signature',
  ].join('.');
}

function fakeAuthJson(user, options) {
  return JSON.stringify({
    tokens: {
      id_token: 'id',
      access_token: fakeAccessToken(user, options),
      refresh_token: `refresh-${user}`,
      account_id: options?.workspace ?? 'workspace',
    },
  });
}

async function withSharedAuthFixture(prefix, run) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sharedAuthPath = path.join(temporaryRoot, 'dot-codex', 'auth.json');
  const codexHome = path.join(temporaryRoot, 'codex-home');
  await fs.mkdir(path.dirname(sharedAuthPath), { recursive: true });
  const options = {
    binaryPath: FAKE_CODEX_SERVER,
    codexHome,
    workspaceRoot: path.join(temporaryRoot, 'workspace'),
    openExternal: async () => {
      throw new Error('Shared auth must never open a browser login.');
    },
    sharedAuthPath,
  };
  const writeSharedAuth = (user, authOptions) => fs.writeFile(sharedAuthPath, fakeAuthJson(user, authOptions));
  try {
    await run({ options, sharedAuthPath, codexHome, writeSharedAuth });
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function withEnvironment(variables, run) {
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const streamOptions = executions => ({
  conversationId: 'conversation-shared',
  tools: CHAT_TOOLS,
  executeTool: async () => {
    executions.count += 1;
    return { success: true, content: 'opened' };
  },
});

test('follows Codex Switcher only when it is installed and not opted out', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-switcher-home-'));
  try {
    assert.equal(resolveCodexSwitcherAuthPath(home, {}), undefined);
    await fs.mkdir(path.join(home, '.codex-switcher'));
    await fs.writeFile(path.join(home, '.codex-switcher', 'accounts.json'), '{}');
    assert.equal(resolveCodexSwitcherAuthPath(home, {}), path.join(home, '.codex', 'auth.json'));
    assert.equal(resolveCodexSwitcherAuthPath(home, { JARVIS_CODEX_PRIVATE_AUTH: '1' }), undefined);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('identifies shared accounts by workspace and user, not by token', async () => {
  await withSharedAuthFixture('jarvis-shared-identity-', async ({ sharedAuthPath, writeSharedAuth }) => {
    assert.equal(await readSharedCodexCredential(sharedAuthPath), null);
    await fs.writeFile(sharedAuthPath, '{"tokens":');
    assert.equal(await readSharedCodexCredential(sharedAuthPath), null);

    await writeSharedAuth('alice');
    const alice = await readSharedCodexCredential(sharedAuthPath);
    assert.equal(alice.accountId, 'workspace');
    assert.equal(alice.userId, 'alice');
    assert.equal(alice.planType, 'plus');
    assert.ok(alice.expiresAt > Date.now());

    await writeSharedAuth('alice', { expiresInSeconds: 7200 });
    const refreshedAlice = await readSharedCodexCredential(sharedAuthPath);
    assert.notEqual(refreshedAlice.accessToken, alice.accessToken);
    assert.equal(sharedCredentialIdentity(refreshedAlice), sharedCredentialIdentity(alice));

    await writeSharedAuth('bob');
    const bobSameWorkspace = await readSharedCodexCredential(sharedAuthPath);
    assert.notEqual(sharedCredentialIdentity(bobSameWorkspace), sharedCredentialIdentity(alice));
  });
});

test('switches accounts with Codex Switcher without writing any auth file', async () => {
  await withSharedAuthFixture('jarvis-shared-switch-', async ({ options, sharedAuthPath, codexHome, writeSharedAuth }) => {
    const privateAuth = '{"tokens":{"access_token":"private-login"}}';
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'auth.json'), privateAuth);
    const client = new CodexAppServerClient(options);
    try {
      await writeSharedAuth('first');
      assert.equal((await client.getAccountStatus()).email, 'first@example.com');
      assert.deepEqual((await client.listModels()).map(model => model.model), ['model-for-first']);

      await writeSharedAuth('second');
      const sharedBefore = await fs.readFile(sharedAuthPath, 'utf8');
      assert.equal((await client.loginChatGpt()).email, 'second@example.com');
      assert.deepEqual((await client.listModels()).map(model => model.model), ['model-for-second']);

      await assert.rejects(client.logout(), /Codex Switcher/);
      assert.equal(await fs.readFile(sharedAuthPath, 'utf8'), sharedBefore);
      assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), privateAuth);
    } finally {
      await client.stop();
    }
  });
});

test('reports a missing or expired Codex Switcher login instead of signing in', async () => {
  await withSharedAuthFixture('jarvis-shared-missing-', async ({ options, writeSharedAuth }) => {
    const provider = new CodexProvider(options);
    const messages = [{ role: 'user', content: 'Question' }];
    try {
      assert.deepEqual(await provider.getAccountStatus(), { connected: false, type: null });
      await assert.rejects(
        provider.streamChat('codex:gpt-test', messages, new AbortController(), () => undefined),
        /no ChatGPT account is active/,
      );

      await writeSharedAuth('stale', { expiresInSeconds: -60 });
      await assert.rejects(provider.connectAccount(), /has expired/);
    } finally {
      await provider.shutdown();
    }
  });
});

test('answers app-server token refreshes from the Codex Switcher file', async () => {
  await withSharedAuthFixture('jarvis-shared-refresh-', async ({ options, writeSharedAuth }) => {
    const client = new CodexAppServerClient(options);
    const runRefreshingTurn = async () => {
      await writeSharedAuth('expiring');
      await client.syncSharedAuth();
      const threadId = await client.startThread({
        model: 'gpt-test',
        developerInstructions: 'test',
        ephemeral: true,
        dynamicTools: toCodexDynamicTools(CHAT_TOOLS),
      });
      return () => client.runTurn({
        threadId,
        model: 'gpt-test',
        input: [{ type: 'text', text: 'Open the page.', text_elements: [] }],
        onDelta: () => undefined,
        onToolCall: async () => ({ success: true, content: 'opened' }),
      });
    };
    try {
      // Nobody refreshed the file, so Jarvis cannot supply a newer token.
      const unrefreshedTurn = await runRefreshingTurn();
      await assert.rejects(unrefreshedTurn(), /has expired/);

      const refreshedTurn = await runRefreshingTurn();
      await writeSharedAuth('refreshed');
      assert.equal(await refreshedTurn(), 'Tool completed.');
      assert.equal((await client.getAccountStatus()).email, 'refreshed@example.com');
    } finally {
      await client.stop();
    }
  });
});

test('retries a usage-limited turn once Codex Switcher selects another account', async () => {
  await withSharedAuthFixture('jarvis-shared-limit-', async ({ options, sharedAuthPath, writeSharedAuth }) => {
    const provider = new CodexProvider(options);
    const executions = { count: 0 };
    const messages = [{ role: 'user', content: 'Question' }];
    try {
      await writeSharedAuth('exhausted');
      const result = await withEnvironment({
        FAKE_CODEX_SWITCH_ON_LIMIT: JSON.stringify({ authPath: sharedAuthPath, auth: fakeAuthJson('fresh') }),
      }, () => provider.streamChat(
        'codex:gpt-test',
        messages,
        new AbortController(),
        () => undefined,
        streamOptions(executions),
      ));
      assert.equal(result.assistantMessage.content, 'Tool completed.');
      assert.equal(executions.count, 1);
      assert.equal((await provider.getAccountStatus()).email, 'fresh@example.com');
    } finally {
      await provider.shutdown();
    }
  });
});

test('does not retry a usage-limited turn that already produced output', async () => {
  await withSharedAuthFixture('jarvis-shared-partial-', async ({ options, sharedAuthPath, writeSharedAuth }) => {
    const provider = new CodexProvider(options);
    const executions = { count: 0 };
    const chunks = [];
    try {
      await writeSharedAuth('exhausted');
      await withEnvironment({
        FAKE_CODEX_DELTA_BEFORE_LIMIT: '1',
        FAKE_CODEX_SWITCH_ON_LIMIT: JSON.stringify({ authPath: sharedAuthPath, auth: fakeAuthJson('fresh') }),
      }, () => assert.rejects(
        provider.streamChat(
          'codex:gpt-test',
          [{ role: 'user', content: 'Question' }],
          new AbortController(),
          chunk => chunks.push(chunk.content),
          streamOptions(executions),
        ),
        /Workspace credits are depleted[\s\S]*Switch to another account in Codex Switcher/,
      ));
      assert.deepEqual(chunks, ['Partial answer']);
      assert.equal(executions.count, 0);
    } finally {
      await provider.shutdown();
    }
  });
});

test('explains how to switch when the selected account is out of usage', async () => {
  await withSharedAuthFixture('jarvis-shared-exhausted-', async ({ options, writeSharedAuth }) => {
    const provider = new CodexProvider(options);
    try {
      await writeSharedAuth('exhausted');
      await assert.rejects(
        provider.sendChat('codex:gpt-test', [{ role: 'user', content: 'Title this' }]),
        /Workspace credits are depleted[\s\S]*Switch to another account in Codex Switcher/,
      );
    } finally {
      await provider.shutdown();
    }
  });
});

test('classifies usage limits from the structured Codex error first', () => {
  assert.equal(isCodexUsageLimitError(new CodexTurnError('Workspace credits are depleted.', 'usageLimitExceeded')), true);
  assert.equal(isCodexUsageLimitError(new CodexTurnError('You hit a rate limit.', 'serverOverloaded')), false);
  assert.equal(isCodexUsageLimitError(new Error("You've hit your usage limit.")), true);
  assert.equal(isCodexUsageLimitError(new Error('Rate limit exceeded, retrying.')), false);
});
