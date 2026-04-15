export type BrowserToolMode = 'dom' | 'hybrid' | 'cua';

export type BrowserScreenshotKind = 'final' | 'error';

export interface BrowserScreenshotArtifact {
  id: string;
  kind: BrowserScreenshotKind;
  path: string;
  mimeType: 'image/jpeg' | 'image/png';
  createdAt: string;
  label: string;
}

export interface BrowserLLMTraceStep {
  stepIndex: number;
  timestamp: string;
  url?: string;
  pageTitle?: string;
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
  mode: BrowserToolMode;
  systemPrompt: string;
  instruction: string;
  startedAt: string;
  finishedAt?: string;
  steps: BrowserLLMTraceStep[];
  error?: string;
}

export interface BrowserToolRun {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
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
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
}
