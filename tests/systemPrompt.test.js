const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSystemPrompt } = require('../dist/main/systemPrompt');
const { CHAT_TOOLS } = require('../dist/main/tools/chatTools');

test('discourages unnecessary Tavily searches in the prompt and tool description', async () => {
  const prompt = await buildSystemPrompt('test-conversation');
  const tavilyTool = CHAT_TOOLS.find(tool => tool.function.name === 'tavily_search');

  assert.match(prompt.content, /Use tavily_search only when/);
  assert.match(prompt.content, /Do not use tavily_search for stable facts or topics you already know well enough/);
  assert.match(tavilyTool.function.description, /Use only when/);
  assert.match(tavilyTool.function.description, /Do not search for stable facts or topics you already know well enough/);
});
