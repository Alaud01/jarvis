#!/usr/bin/env node

const readline = require('node:readline');

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;
let turnCount = 0;

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

  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: { account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' } },
    });
    return;
  }

  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }

  if (message.method === 'thread/start') {
    const namespace = message.params?.dynamicTools?.[0];
    if (namespace?.type !== 'namespace' || namespace?.name !== 'jarvis') {
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
    setImmediate(() => {
      send({
        id: activeTurn.requestId,
        method: 'item/tool/call',
        params: {
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          callId: 'call-test',
          namespace: 'jarvis',
          tool: 'browser_open',
          arguments: { url: 'https://example.com' },
        },
      });
    });
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
