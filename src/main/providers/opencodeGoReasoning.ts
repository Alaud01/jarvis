import type { ModelInfo, ReasoningEffortOption } from './types';

// OpenCode publishes per-model reasoning controls for Go in models.dev, the
// catalog OpenCode itself reads. Jarvis refreshes from it at runtime and falls
// back to the snapshot below when it is unreachable.
export const MODELS_DEV_URL = 'https://models.dev/api.json';

export type GoProtocol = 'responses' | 'anthropic' | 'chat';

export interface GoReasoningSpec {
  efforts?: string[];
  toggle?: boolean;
  budget?: boolean;
}

export interface GoCatalogEntry {
  reasoning: GoReasoningSpec;
  npm?: string;
}

// Snapshot of models.dev `opencode-go` reasoning_options (Oct 2026). Models
// without an entry, or with fewer than two choices, keep the selector locked.
export const GO_REASONING_SNAPSHOT: Record<string, GoReasoningSpec> = {
  'deepseek-v4-flash': { efforts: ['low', 'high', 'max'] },
  'deepseek-v4-flash-vision-exp': { toggle: true, efforts: ['low', 'high', 'max'] },
  'deepseek-v4-pro': { efforts: ['high', 'max'] },
  'deepseek-v4.1-flash': { efforts: ['low', 'high', 'max'] },
  'glm-5.2': { efforts: ['high', 'max'] },
  'glm-5.3': { efforts: ['low', 'high', 'max'] },
  'glm-5.3-flash': { efforts: ['low', 'high', 'max'] },
  'gpt-5.6-luna': { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6-luna': { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  'grok-4.6': { efforts: ['low', 'medium', 'high', 'xhigh'] },
  'grok-4.7': { efforts: ['low', 'medium', 'high', 'xhigh'] },
  'hy3': { efforts: ['none', 'low', 'high'] },
  'hy4-preview': { efforts: ['none', 'high'] },
  // Kimi K3 only offers "max" and ignores attempts to disable thinking.
  'kimi-k3': { efforts: ['max'] },
  'longcat-2.0': { toggle: true },
  'longcat-2.5-preview-free': { toggle: true },
  'minimax-m3': { toggle: true },
  'muse-spark-1.2-contributor': { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  'muse-spark-1.3-contributor': { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
  'qwen3.8-flash': { toggle: true, efforts: ['low', 'medium', 'xhigh'], budget: true },
  'qwen3.8-max': { toggle: true, efforts: ['low', 'medium', 'xhigh'], budget: true },
  'qwen3.7-plus': { toggle: true, budget: true },
  'space-bunny': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'space-bunny-free': { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  // Legacy Qwen ids kept for existing saved selections.
  'qwen3.7-max': { toggle: true, budget: true },
  'qwen3.6-plus': { toggle: true, budget: true },
  'qwen3.5-plus': { toggle: true, budget: true },
};

export const THINKING_BUDGET_BY_EFFORT: Record<string, number> = {
  low: 1024,
  medium: 2048,
  high: 4096,
};

const OFF = 'none';
const ON = 'on';

const DESCRIPTIONS: Record<string, string> = {
  [OFF]: 'Answers without reasoning.',
  [ON]: 'Thinks before answering.',
};

const BUDGET_DESCRIPTIONS: Record<string, string> = {
  low: 'Uses a smaller thinking budget.',
  medium: 'Uses a balanced thinking budget.',
  high: 'Uses the largest thinking budget.',
};

interface ModelsDevReasoningOption {
  type?: string;
  values?: unknown[];
}

interface ModelsDevModel {
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  provider?: { npm?: string };
}

export function parseModelsDevGoCatalog(data: unknown): Map<string, GoCatalogEntry> {
  const catalog = new Map<string, GoCatalogEntry>();
  const models = (data as { 'opencode-go'?: { models?: Record<string, ModelsDevModel> } })
    ?.['opencode-go']?.models;
  if (!models || typeof models !== 'object') return catalog;

  for (const [id, model] of Object.entries(models)) {
    const reasoning: GoReasoningSpec = {};
    if (model.reasoning) {
      for (const option of model.reasoning_options ?? []) {
        if (option.type === 'toggle') reasoning.toggle = true;
        if (option.type === 'budget_tokens') reasoning.budget = true;
        if (option.type === 'effort' && Array.isArray(option.values)) {
          reasoning.efforts = option.values.filter((value): value is string => typeof value === 'string' && value.length > 0);
        }
      }
    }
    catalog.set(id, { reasoning, npm: model.provider?.npm });
  }
  return catalog;
}

export function protocolFromNpm(npm: string | undefined): GoProtocol | undefined {
  if (npm === '@ai-sdk/openai') return 'responses';
  if (npm === '@ai-sdk/anthropic') return 'anthropic';
  return undefined;
}

function getEffortValues(spec: GoReasoningSpec, protocol: GoProtocol): string[] {
  if (spec.efforts?.length) {
    return spec.toggle && !spec.efforts.includes(OFF) ? [OFF, ...spec.efforts] : [...spec.efforts];
  }
  // Token budgets are only sent over the Anthropic-compatible endpoint.
  if (spec.budget && protocol === 'anthropic') {
    return [...(spec.toggle ? [OFF] : []), ...Object.keys(THINKING_BUDGET_BY_EFFORT)];
  }
  return spec.toggle ? [OFF, ON] : [];
}

function getDefaultEffort(spec: GoReasoningSpec, protocol: GoProtocol, values: string[]): string {
  if (!spec.efforts?.length) {
    if (spec.budget && values.includes('high')) return 'high';
    // Match each endpoint's behavior when no thinking field is sent.
    return protocol === 'anthropic' ? OFF : ON;
  }
  return ['medium', 'high'].find(value => values.includes(value))
    ?? values.filter(value => value !== OFF).at(-1)
    ?? values[0];
}

export function getGoReasoningSettings(
  spec: GoReasoningSpec | undefined,
  protocol: GoProtocol,
): Pick<ModelInfo, 'reasoningEfforts' | 'defaultReasoningEffort'> {
  if (!spec) return {};
  const values = getEffortValues(spec, protocol);
  if (values.length < 2) return {};

  const usesBudgets = !spec.efforts?.length && spec.budget;
  return {
    reasoningEfforts: values.map((value): ReasoningEffortOption => {
      const description = usesBudgets ? BUDGET_DESCRIPTIONS[value] ?? DESCRIPTIONS[value] : DESCRIPTIONS[value];
      return description ? { value, description } : { value };
    }),
    defaultReasoningEffort: getDefaultEffort(spec, protocol, values),
  };
}

/** Adds the reasoning field each Go endpoint expects for the selected effort. */
export function applyGoReasoning(
  body: Record<string, unknown>,
  spec: GoReasoningSpec | undefined,
  protocol: GoProtocol,
  requestedEffort: string | undefined,
): void {
  const settings = getGoReasoningSettings(spec, protocol);
  const values = settings.reasoningEfforts?.map(option => option.value);
  if (!spec || !values) return;
  const effort = requestedEffort && values.includes(requestedEffort)
    ? requestedEffort
    : settings.defaultReasoningEffort;
  if (!effort) return;

  if (spec.efforts?.includes(effort)) {
    if (protocol === 'responses') body.reasoning = { effort };
    else if (protocol === 'anthropic') body.output_config = { effort };
    else body.reasoning_effort = effort;
    return;
  }

  if (effort === OFF) {
    body.thinking = { type: 'disabled' };
    return;
  }

  if (protocol === 'anthropic') {
    body.thinking = {
      type: 'enabled',
      budget_tokens: THINKING_BUDGET_BY_EFFORT[effort] ?? THINKING_BUDGET_BY_EFFORT.high,
    };
  }
  // Chat Completions thinking is on by default, so "on" needs no field.
}
