import { randomUUID } from 'crypto';
import Store from 'electron-store';
import type { ChatMessage } from './providers/types';
import type {
  StreamTurnUsage,
  UsageDashboardData,
  UsageDashboardQuery,
  UsageEvent,
  UsageRange,
  UsageSeriesPoint,
  UsageTokenMode,
} from '../shared/usage';

const CHARS_PER_TOKEN = 4;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 50_000;
const MIN_TPS_SAMPLE_MS = 1_000;

interface UsageStoreSchema {
  events: UsageEvent[];
}

type RuntimeStore = {
  get<Key extends keyof UsageStoreSchema>(key: Key, defaultValue?: UsageStoreSchema[Key]): UsageStoreSchema[Key];
  set<Key extends keyof UsageStoreSchema>(key: Key, value: UsageStoreSchema[Key]): void;
};

const usageStore = new Store<UsageStoreSchema>({
  name: 'jarvis-usage',
  defaults: {
    events: [],
  },
}) as unknown as RuntimeStore;

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    let text = message.content ?? '';
    if (message.thinking) text += `\n${message.thinking}`;
    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        text += `\n${toolCall.function.name} ${JSON.stringify(toolCall.function.arguments ?? {})}`;
      }
    }
    return sum + estimateTokenCount(text);
  }, 0);
}

function loadEvents(): UsageEvent[] {
  const events = usageStore.get('events', []);
  return Array.isArray(events) ? events : [];
}

function saveEvents(events: UsageEvent[]): void {
  const cutoff = Date.now() - RETENTION_MS;
  const pruned = events
    .filter((event) => Date.parse(event.timestamp) >= cutoff)
    .slice(-MAX_EVENTS);
  usageStore.set('events', pruned);
}

export function recordUsageEvent(input: {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  generationMs: number;
  estimated: boolean;
  timestamp?: string;
}): UsageEvent {
  const event: UsageEvent = {
    id: randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    model: input.model || 'unknown',
    provider: input.provider || 'unknown',
    inputTokens: Math.max(0, Math.round(input.inputTokens)),
    outputTokens: Math.max(0, Math.round(input.outputTokens)),
    generationMs: Math.max(0, Math.round(input.generationMs)),
    estimated: input.estimated,
  };

  const events = loadEvents();
  events.push(event);
  saveEvents(events);
  return event;
}

export function resolveTurnUsage(params: {
  provider?: string;
  usage?: StreamTurnUsage;
  messages: ChatMessage[];
  assistantContent?: string;
  assistantThinking?: string;
  startedAtMs: number;
  endedAtMs: number;
}): { inputTokens: number; outputTokens: number; generationMs: number; estimated: boolean } {
  const estimatedInput = estimateMessagesTokens(params.messages);
  const estimatedOutput = estimateTokenCount(
    `${params.assistantContent ?? ''}${params.assistantThinking ? `\n${params.assistantThinking}` : ''}`,
  );

  const hasInput = typeof params.usage?.inputTokens === 'number' && Number.isFinite(params.usage.inputTokens);
  const hasOutput = typeof params.usage?.outputTokens === 'number' && Number.isFinite(params.usage.outputTokens);
  const hasGeneration =
    typeof params.usage?.generationMs === 'number' && Number.isFinite(params.usage.generationMs) && params.usage.generationMs > 0;
  const elapsedMs = Number.isFinite(params.startedAtMs) && Number.isFinite(params.endedAtMs)
    ? Math.max(0, params.endedAtMs - params.startedAtMs)
    : 0;

  const inputTokens = hasInput ? Math.max(0, params.usage!.inputTokens!) : estimatedInput;
  const outputTokens = hasOutput ? Math.max(0, params.usage!.outputTokens!) : estimatedOutput;
  const reportedGenerationMs = hasGeneration ? Math.max(1, params.usage!.generationMs!) : 0;
  const generationMs = reportedGenerationMs > 0
    ? params.provider === 'ollama' || elapsedMs <= 0
      ? reportedGenerationMs
      : Math.max(reportedGenerationMs, elapsedMs)
    : elapsedMs > 0
      ? Math.max(1, elapsedMs)
      : 0;
  const estimated = Boolean(params.usage?.estimated) || !hasInput || !hasOutput;

  return { inputTokens, outputTokens, generationMs, estimated };
}

export function recordResolvedTurnUsage(params: {
  model: string;
  provider: string;
  usage?: StreamTurnUsage;
  messages: ChatMessage[];
  assistantContent?: string;
  assistantThinking?: string;
  startedAtMs: number;
  endedAtMs: number;
}): void {
  const resolved = resolveTurnUsage({
    provider: params.provider,
    usage: params.usage,
    messages: params.messages,
    assistantContent: params.assistantContent,
    assistantThinking: params.assistantThinking,
    startedAtMs: params.startedAtMs,
    endedAtMs: params.endedAtMs,
  });
  if (resolved.inputTokens <= 0 && resolved.outputTokens <= 0) return;
  recordUsageEvent({
    model: params.model,
    provider: params.provider,
    ...resolved,
  });
}

function rangeDurationMs(range: UsageRange): number {
  switch (range) {
    case 'hour':
      return 60 * 60 * 1000;
    case 'day':
      return 24 * 60 * 60 * 1000;
    case 'week':
      return 7 * 24 * 60 * 60 * 1000;
    case 'month':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 24 * 60 * 60 * 1000;
  }
}

function bucketSizeMs(range: UsageRange): number {
  switch (range) {
    case 'hour':
      return 5 * 60 * 1000;
    case 'day':
      return 60 * 60 * 1000;
    case 'week':
    case 'month':
      return 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}

function floorToBucket(timestampMs: number, bucketMs: number): number {
  return Math.floor(timestampMs / bucketMs) * bucketMs;
}

function formatBucketLabel(timestampMs: number, range: UsageRange, timezone: string): string {
  const date = new Date(timestampMs);
  if (range === 'hour') {
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    });
  }
  if (range === 'day') {
    return date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      timeZone: timezone,
    });
  }
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
}

function emptySeries(bucketStarts: number[], range: UsageRange, timezone: string): UsageSeriesPoint[] {
  return bucketStarts.map((bucketStart) => ({
    bucketStart: new Date(bucketStart).toISOString(),
    label: formatBucketLabel(bucketStart, range, timezone),
    byModel: {},
    total: 0,
  }));
}

function tokenValue(event: UsageEvent, mode: UsageTokenMode): number {
  if (mode === 'input') return event.inputTokens;
  if (mode === 'output') return event.outputTokens;
  return event.inputTokens + event.outputTokens;
}

function tpsGenerationMs(event: UsageEvent): number {
  if (event.outputTokens <= 0 || event.generationMs <= 0) return 0;
  return Math.max(event.generationMs, MIN_TPS_SAMPLE_MS);
}

export function getUsageDashboard(query: UsageDashboardQuery): UsageDashboardData {
  const range = query.range ?? 'day';
  const tokenMode = query.tokenMode ?? 'total';
  const tpsTokenMode: UsageTokenMode = 'output';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const now = Date.now();
  const rangeMs = rangeDurationMs(range);
  const bucketMs = bucketSizeMs(range);
  const windowStart = now - rangeMs;
  const firstBucket = floorToBucket(windowStart, bucketMs);
  const lastBucket = floorToBucket(now, bucketMs);

  const bucketStarts: number[] = [];
  for (let t = firstBucket; t <= lastBucket; t += bucketMs) {
    bucketStarts.push(t);
  }

  const events = loadEvents().filter((event) => {
    const ts = Date.parse(event.timestamp);
    return Number.isFinite(ts) && ts >= windowStart && ts <= now;
  });

  const models = new Set<string>();
  const usage = emptySeries(bucketStarts, range, timezone);
  const input = emptySeries(bucketStarts, range, timezone);
  const output = emptySeries(bucketStarts, range, timezone);
  const tps = emptySeries(bucketStarts, range, timezone);
  const tpsSeconds = new Map<string, Map<string, number>>();
  const tpsTokens = new Map<string, Map<string, number>>();

  let totalInput = 0;
  let totalOutput = 0;
  let totalGenerationMs = 0;

  for (const event of events) {
    const ts = Date.parse(event.timestamp);
    const bucket = floorToBucket(ts, bucketMs);
    const index = bucketStarts.indexOf(bucket);
    if (index < 0) continue;

    models.add(event.model);
    totalInput += event.inputTokens;
    totalOutput += event.outputTokens;
    totalGenerationMs += tpsGenerationMs(event);

    usage[index].byModel[event.model] = (usage[index].byModel[event.model] ?? 0) + tokenValue(event, tokenMode);
    usage[index].total += tokenValue(event, tokenMode);

    input[index].byModel[event.model] = (input[index].byModel[event.model] ?? 0) + event.inputTokens;
    input[index].total += event.inputTokens;

    output[index].byModel[event.model] = (output[index].byModel[event.model] ?? 0) + event.outputTokens;
    output[index].total += event.outputTokens;

    const tpsValue = tokenValue(event, tpsTokenMode);
    const generationMs = tpsGenerationMs(event);
    if (tpsValue > 0 && generationMs > 0) {
      if (!tpsSeconds.has(usage[index].bucketStart)) {
        tpsSeconds.set(usage[index].bucketStart, new Map());
        tpsTokens.set(usage[index].bucketStart, new Map());
      }
      const secondsMap = tpsSeconds.get(usage[index].bucketStart)!;
      const tokensMap = tpsTokens.get(usage[index].bucketStart)!;
      secondsMap.set(event.model, (secondsMap.get(event.model) ?? 0) + generationMs / 1000);
      tokensMap.set(event.model, (tokensMap.get(event.model) ?? 0) + tpsValue);
    }
  }

  for (const point of tps) {
    const secondsMap = tpsSeconds.get(point.bucketStart);
    const tokensMap = tpsTokens.get(point.bucketStart);
    if (!secondsMap || !tokensMap) continue;
    let totalTpsWeight = 0;
    let totalSeconds = 0;
    for (const model of models) {
      const seconds = secondsMap.get(model) ?? 0;
      const tokens = tokensMap.get(model) ?? 0;
      if (seconds <= 0 || tokens <= 0) continue;
      const modelTps = tokens / seconds;
      point.byModel[model] = modelTps;
      totalTpsWeight += tokens;
      totalSeconds += seconds;
    }
    point.total = totalSeconds > 0 ? totalTpsWeight / totalSeconds : 0;
  }

  const modelList = [...models].sort((a, b) => a.localeCompare(b));
  const avgTps = totalGenerationMs > 0 ? totalOutput / (totalGenerationMs / 1000) : 0;

  return {
    range,
    tokenMode,
    models: modelList,
    usage,
    input,
    output,
    tps,
    totals: {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      avgTps,
    },
  };
}
