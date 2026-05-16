export type BrowserToolMode = 'dom' | 'hybrid' | 'cua';

export type BrowserScreenshotKind = 'final' | 'error';

export type BrowserToolRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type BrowserTraceEventName =
  | 'started'
  | 'step'
  | 'step_result'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BrowserScreenshotArtifact {
  id: string;
  kind: BrowserScreenshotKind;
  path: string;
  mimeType: 'image/jpeg' | 'image/png';
  createdAt: string;
  label: string;
}

export interface BrowserTraceAction {
  toolName: string;
  input: Record<string, unknown>;
}

export interface BrowserTraceResult {
  isDone?: boolean;
  success?: boolean | null;
  error?: string;
  extractedContent?: string;
  longTermMemory?: string;
  metadata?: Record<string, unknown>;
}

export interface BrowserLLMTraceStep {
  stepIndex: number;
  timestamp: string;
  url?: string;
  pageTitle?: string;
  thinking?: string;
  evaluationPreviousGoal?: string;
  memory?: string;
  nextGoal?: string;
  actions?: BrowserTraceAction[];
  results?: BrowserTraceResult[];
  durationMs?: number;
  planUpdate?: string[];
  currentPlanItem?: number;
  reasoning?: string;
  finishReason?: string;
  toolCalls?: {
    toolName: string;
    input: Record<string, unknown>;
  }[];
  rawLogLines?: string[];
}

export interface BrowserLLMTrace {
  model: string;
  mode?: BrowserToolMode;
  provider?: string;
  plannerModel?: string;
  useVision?: boolean;
  llmScreenshotSize?: [number, number] | null;
  systemPrompt?: string;
  instruction: string;
  startedAt: string;
  finishedAt?: string;
  steps: BrowserLLMTraceStep[];
  error?: string;
}

export interface BrowserTraceEvent {
  assistantMessageId?: string;
  runId: string;
  event: BrowserTraceEventName;
  timestamp: string;
  status: BrowserToolRunStatus;
  instruction?: string;
  model?: string;
  provider?: string;
  plannerModel?: string;
  useVision?: boolean;
  llmScreenshotSize?: [number, number] | null;
  step?: BrowserLLMTraceStep;
  summary?: string;
  error?: string;
  steps?: number;
  elapsedMs?: number;
}

export interface BrowserToolRun {
  id: string;
  status: BrowserToolRunStatus;
  instruction: string;
  startUrl?: string;
  summary?: string;
  currentUrl?: string;
  pageTitle?: string;
  actionsTaken?: number;
  error?: string;
  processing?: string;
  model?: string;
  mode?: BrowserToolMode;
  screenshots?: BrowserScreenshotArtifact[];
  llmTrace?: BrowserLLMTrace;
  extractionOutput?: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
}
