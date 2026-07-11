export type UsageRange = 'hour' | 'day' | 'week' | 'month';
export type UsageTokenMode = 'total' | 'input' | 'output';

export interface StreamTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  generationMs?: number;
  estimated?: boolean;
}

export interface UsageEvent {
  id: string;
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  generationMs: number;
  estimated: boolean;
}

export interface UsageSeriesPoint {
  bucketStart: string;
  label: string;
  byModel: Record<string, number>;
  total: number;
}

export interface UsageDashboardTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgTps: number;
}

export interface UsageDashboardData {
  range: UsageRange;
  tokenMode: UsageTokenMode;
  models: string[];
  usage: UsageSeriesPoint[];
  input: UsageSeriesPoint[];
  output: UsageSeriesPoint[];
  tps: UsageSeriesPoint[];
  totals: UsageDashboardTotals;
}

export interface UsageDashboardQuery {
  range: UsageRange;
  tokenMode?: UsageTokenMode;
}
