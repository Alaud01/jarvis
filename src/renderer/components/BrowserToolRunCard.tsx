import React from 'react';
import ThinkingSection from './ThinkingSection';

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
  mode?: 'dom' | 'hybrid' | 'cua';
  startedAt: string;
  finishedAt?: string;
  textOffset?: number;
}

interface BrowserToolRunCardProps {
  run: BrowserToolRun;
}

const statusLabel: Record<BrowserToolRun['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const formatTimestamp = (value?: string): string | null => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const BrowserToolRunCard: React.FC<BrowserToolRunCardProps> = ({ run }) => {
  const startedAt = formatTimestamp(run.startedAt);
  const finishedAt = formatTimestamp(run.finishedAt);

  return (
    <div className="mt-3 border border-border-secondary bg-bg-secondary px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span
          className={`font-mono text-[0.65rem] uppercase tracking-[2px] ${
            run.status === 'running' ? 'text-text-primary animate-pulse' : 'text-text-tertiary'
          }`}
        >
          Browser {statusLabel[run.status]}
        </span>
        {typeof run.actionsTaken === 'number' && (
          <span className="font-mono text-[0.65rem] text-text-tertiary">
            {run.actionsTaken} action{run.actionsTaken === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm text-text-primary leading-relaxed">
        {run.instruction}
      </p>

      {run.processing && (
        <ThinkingSection
          content={run.processing}
          isStreaming={run.status === 'running'}
          streamingLabel="Browser processing..."
          finishedLabel="Browser trace"
          contentClassName="text-sm text-text-secondary leading-relaxed"
        />
      )}

      {run.summary && (
        <p className="mt-2 text-sm text-text-secondary leading-relaxed">
          {run.summary}
        </p>
      )}

      {run.error && (
        <p className="mt-2 text-sm text-text-primary leading-relaxed">
          {run.error}
        </p>
      )}

      {(run.startUrl || run.currentUrl || run.pageTitle || run.model || run.mode || startedAt || finishedAt) && (
        <div className="mt-3 flex flex-col gap-1 font-mono text-[0.65rem] text-text-tertiary">
          {run.startUrl && <span className="break-all">start: {run.startUrl}</span>}
          {run.currentUrl && <span className="break-all">current: {run.currentUrl}</span>}
          {run.pageTitle && <span>title: {run.pageTitle}</span>}
          {run.model && <span>model: {run.model}</span>}
          {run.mode && <span>mode: {run.mode}</span>}
          {startedAt && <span>started: {startedAt}</span>}
          {finishedAt && <span>finished: {finishedAt}</span>}
        </div>
      )}
    </div>
  );
};

export default BrowserToolRunCard;
