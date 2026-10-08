#!/usr/bin/env node

const fs = require('node:fs');
const readline = require('node:readline');

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;
let turnCount = 0;
// Like the real app-server, external (chatgptAuthTokens) auth is memory-only.
let externalAccount = null;
let nextServerRequestId = 5000;
const pendingServerRequests = new Map();
let threadCount = 0;
let exhaustedAttempts = 0;
// Per thread: the declared dynamic tools, and the account whose model
// connection the thread keeps open (real Codex reuses it across turns).
const threads = new Map();

function accountFromAccessToken(accessToken) {
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
  return claims['https://api.openai.com/auth'].chatgpt_user_id;
}

function failTurn(threadId, turnId, message, codexErrorInfo = null) {
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'failed', error: { message, codexErrorInfo } } },
  });
}

function finishWithText(threadId, turnId, text) {
  send({
    method: 'item/started',
    params: { threadId, turnId, item: { type: 'agentMessage', id: 'message-text', phase: 'final_answer' } },
  });
  send({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId, itemId: 'message-text', delta: text },
  });
  send({
    method: 'turn/completed',
    params: { threadId, turn: { id: turnId, status: 'completed', error: null } },
  });
}

// Only threads that declared Jarvis tools receive tool calls.
function respondToTurn(thread, threadId, turnId, requestId) {
  if (thread.hasTools) startToolCall(threadId, turnId, requestId);
  else finishWithText(threadId, turnId, thread.account ? `Answer by ${thread.account}.` : 'Answer.');
}

function startToolCall(threadId, turnId, requestId) {
  // FAKE_TOOL_CALL_SHAPE exercises alternate item/tool/call wire shapes the
  // protocol permits: 'string-args' sends arguments as a JSON string and
  // 'no-namespace' omits the optional namespace field.
  const shape = process.env.FAKE_TOOL_CALL_SHAPE || 'default';
  const toolParams = {
    threadId,
    turnId,
    callId: 'call-test',
    tool: 'browser_open',
    arguments: { url: 'https://example.com' },
  };
  if (shape !== 'no-namespace') {
    toolParams.namespace = 'jarvis';
  }
  if (shape === 'string-args') {
    toolParams.arguments = JSON.stringify(toolParams.arguments);
  }
  send({
    id: requestId,
    method: 'item/tool/call',
    params: toolParams,
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(id, message) {
  send({ id, error: { code: -32000, message } });
}

lines.on('line', line => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    if (message.params?.capabilities?.experimentalApi !== true) {
      fail(message.id, 'experimentalApi was not enabled');
      return;
    }
    send({ id: message.id, result: { userAgent: 'jarvis-test' } });
    return;
  }

  if (message.method === 'initialized') return;

  if (message.method === 'thread/delete' || message.method === 'account/logout') {
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === 'account/login/start' && message.params?.type === 'chatgptAuthTokens') {
    externalAccount = accountFromAccessToken(message.params.accessToken);
    send({ id: message.id, result: { type: 'chatgptAuthTokens' } });
    send({ method: 'account/login/completed', params: { loginId: null, success: true, error: null } });
    return;
  }

  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: {
        account: {
          type: 'chatgpt',
          email: externalAccount ? `${externalAccount}@example.com` : 'test@example.com',
          planType: 'test',
        },
      },
    });
    return;
  }

  if (message.method === 'model/list') {
    send({ id: message.id, result: { data: [{ model: `model-for-${externalAccount ?? 'private'}` }] } });
    return;
  }

  if (!message.method && pendingServerRequests.has(message.id)) {
    const onResponse = pendingServerRequests.get(message.id);
    pendingServerRequests.delete(message.id);
    onResponse(message);
    return;
  }

  if (message.method === 'thread/resume') {
    // Resuming an unloaded thread opens a new connection; a loaded one keeps its own.
    if (!threads.has(message.params.threadId)) {
      threads.set(message.params.threadId, { hasTools: true, account: externalAccount });
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }

  if (message.method === 'thread/start') {
    const dynamicTools = message.params?.dynamicTools ?? [];
    const namespace = dynamicTools[0];
    if (dynamicTools.length > 0 && (namespace?.type !== 'namespace' || namespace?.name !== 'jarvis')) {
      fail(message.id, 'Jarvis dynamic tools were not provided');
      return;
    }
    threadCount += 1;
    const threadId = `thread-test-${threadCount}`;
    threads.set(threadId, { hasTools: dynamicTools.length > 0, account: externalAccount });
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }

  if (message.method === 'turn/start') {
    turnCount += 1;
    activeTurn = { threadId: message.params.threadId, turnId: `turn-test-${turnCount}`, requestId: 9000 + turnCount };
    send({ id: message.id, result: { turn: { id: activeTurn.turnId } } });
    const { threadId, turnId, requestId } = activeTurn;
    const thread = threads.get(threadId);
    activeTurn.account = thread.account;

    if (thread.account === 'exhausted') {
      setImmediate(() => {
        if (process.env.FAKE_CODEX_DELTA_BEFORE_LIMIT === '1') {
          send({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: 'partial', delta: 'Partial answer' },
          });
        }
        // Simulates Codex Switcher selecting another account mid-turn.
        if (process.env.FAKE_CODEX_SWITCH_ON_LIMIT) {
          const { authPath, auth } = JSON.parse(process.env.FAKE_CODEX_SWITCH_ON_LIMIT);
          fs.writeFileSync(authPath, auth);
        }
        // A real usage-limit message that does not say "usage limit".
        exhaustedAttempts += 1;
        failTurn(threadId, turnId, `Workspace credits are depleted (attempt ${exhaustedAttempts}).`, 'usageLimitExceeded');
      });
      return;
    }

    if (thread.account === 'expiring') {
      // The backend rejected the token; ask the client for a fresh one.
      const refreshId = nextServerRequestId++;
      pendingServerRequests.set(refreshId, response => {
        if (response.error) {
          failTurn(threadId, turnId, response.error.message, 'unauthorized');
          return;
        }
        const refreshedAccount = accountFromAccessToken(response.result.accessToken);
        const refreshedClaims = JSON.parse(Buffer.from(response.result.accessToken.split('.')[1], 'base64url').toString('utf8'));
        if (refreshedAccount === 'expiring' && !refreshedClaims.test_refreshed) {
          failTurn(threadId, turnId, 'Your access token could not be refreshed.', 'unauthorized');
          return;
        }
        externalAccount = refreshedAccount;
        thread.account = refreshedAccount;
        activeTurn.account = refreshedAccount;
        respondToTurn(thread, threadId, turnId, requestId);
      });
      send({
        id: refreshId,
        method: 'account/chatgptAuthTokens/refresh',
        params: { reason: 'unauthorized', previousAccountId: 'workspace' },
      });
      return;
    }

    setImmediate(() => respondToTurn(thread, threadId, turnId, requestId));
    return;
  }

  if (activeTurn && message.id === activeTurn.requestId && !message.method) {
    const result = message.result;
    const text = result?.contentItems?.[0]?.text;
    const expectedImage = text === 'opened-with-image'
      ? 'https://example.com/browser-screenshot.png'
      : null;
    const imageMatches = expectedImage === null
      ? result?.contentItems?.length === 1
      : result?.contentItems?.length === 2
        && result.contentItems[1]?.type === 'inputImage'
        && result.contentItems[1]?.imageUrl === expectedImage;
    if (result?.success !== true || !['opened', 'opened-with-image'].includes(text) || !imageMatches) {
      send({
        method: 'turn/completed',
        params: {
          threadId: activeTurn.threadId,
          turn: {
            id: activeTurn.turnId,
            status: 'failed',
            error: { message: 'Unexpected dynamic tool result' },
          },
        },
      });
      return;
    }
    if (process.env.FAKE_CODEX_LIMIT_AFTER_TOOL === '1') {
      failTurn(activeTurn.threadId, activeTurn.turnId, 'Workspace credits are depleted.', 'usageLimitExceeded');
      return;
    }
    send({
      method: 'item/started',
      params: {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
        item: { type: 'agentMessage', id: 'message-test', phase: 'final_answer' },
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
        itemId: 'message-test',
        delta: activeTurn.account ? `Tool completed by ${activeTurn.account}.` : 'Tool completed.',
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
        tokenUsage: {
          total: {
            totalTokens: 160 * turnCount,
            inputTokens: 120 * turnCount,
            cachedInputTokens: 80 * turnCount,
            outputTokens: 40 * turnCount,
            reasoningOutputTokens: 30 * turnCount,
          },
          last: {
            totalTokens: 160,
            inputTokens: 120,
            cachedInputTokens: 80,
            outputTokens: 40,
            reasoningOutputTokens: 30,
          },
          modelContextWindow: 200000,
        },
      },
    });
    send({
      method: 'turn/completed',
      params: {
        threadId: activeTurn.threadId,
        turn: { id: activeTurn.turnId, status: 'completed', error: null },
      },
    });
  }
});
