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

function startToolCall(threadId, turnId, requestId) {
  send({
    id: requestId,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      callId: 'call-test',
      namespace: 'jarvis',
      tool: 'browser_open',
      arguments: { url: 'https://example.com' },
    },
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
    send({ id: message.id, result: { thread: { id: 'thread-test' } } });
    return;
  }

  if (message.method === 'turn/start') {
    turnCount += 1;
    activeTurn = { threadId: message.params.threadId, turnId: `turn-test-${turnCount}`, requestId: 9000 + turnCount };
    send({ id: message.id, result: { turn: { id: activeTurn.turnId } } });
    const { threadId, turnId, requestId } = activeTurn;

    if (externalAccount === 'exhausted') {
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
        failTurn(threadId, turnId, 'Workspace credits are depleted.', 'usageLimitExceeded');
      });
      return;
    }

    if (externalAccount === 'expiring') {
      // The backend rejected the token; ask the client for a fresh one.
      const refreshId = nextServerRequestId++;
      pendingServerRequests.set(refreshId, response => {
        if (response.error) {
          failTurn(threadId, turnId, response.error.message, 'unauthorized');
          return;
        }
        externalAccount = accountFromAccessToken(response.result.accessToken);
        startToolCall(threadId, turnId, requestId);
      });
      send({
        id: refreshId,
        method: 'account/chatgptAuthTokens/refresh',
        params: { reason: 'unauthorized', previousAccountId: 'workspace' },
      });
      return;
    }

    setImmediate(() => startToolCall(threadId, turnId, requestId));
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
        delta: 'Tool completed.',
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
