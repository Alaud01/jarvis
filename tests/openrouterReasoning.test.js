const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getOpenRouterReasoningSettings,
} = require('../dist/main/providers/openrouter');

const effortValues = (settings) => (
  settings.reasoningEfforts?.map(option => option.value)
);

test('uses OpenRouter per-model effort values and default', () => {
  const settings = getOpenRouterReasoningSettings({
    id: 'example/reasoning-model',
    reasoning: {
      supported_efforts: ['high', 'medium', 'low', 'minimal'],
      default_effort: 'medium',
      default_enabled: true,
      mandatory: false,
    },
  });

  assert.deepEqual(effortValues(settings), ['none', 'high', 'medium', 'low', 'minimal']);
  assert.equal(settings.defaultReasoningEffort, 'medium');
});

test('defaults optional OpenRouter reasoning to off when the catalog does', () => {
  const settings = getOpenRouterReasoningSettings({
    id: 'example/optional-reasoning',
    reasoning: {
      supported_efforts: ['high', 'low'],
      default_effort: 'high',
      default_enabled: false,
      mandatory: false,
    },
  });

  assert.deepEqual(effortValues(settings), ['none', 'high', 'low']);
  assert.equal(settings.defaultReasoningEffort, 'none');
});

test('does not offer off for mandatory reasoning models', () => {
  const settings = getOpenRouterReasoningSettings({
    id: 'example/mandatory-reasoning',
    reasoning: {
      supported_efforts: ['none', 'high', 'medium'],
      default_effort: 'medium',
      mandatory: true,
    },
  });

  assert.deepEqual(effortValues(settings), ['high', 'medium']);
  assert.equal(settings.defaultReasoningEffort, 'medium');
});

test('expands null supported efforts to the complete gateway scale', () => {
  const settings = getOpenRouterReasoningSettings({
    id: 'example/all-efforts',
    reasoning: {
      supported_efforts: null,
      default_effort: 'xhigh',
      mandatory: false,
    },
  });

  assert.deepEqual(
    effortValues(settings),
    ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  );
  assert.equal(settings.defaultReasoningEffort, 'xhigh');
});

test('hides the selector when structured reasoning metadata has no efforts', () => {
  assert.deepEqual(getOpenRouterReasoningSettings({
    id: 'example/token-budget-only',
    reasoning: { supports_max_tokens: true },
  }), {});
});

test('keeps the legacy xAI fallback only when metadata is absent', () => {
  const settings = getOpenRouterReasoningSettings({ id: 'x-ai/grok-legacy' });

  assert.deepEqual(effortValues(settings), ['low', 'medium', 'high']);
  assert.equal(settings.defaultReasoningEffort, 'high');
  assert.deepEqual(getOpenRouterReasoningSettings({ id: 'example/no-reasoning' }), {});
});
