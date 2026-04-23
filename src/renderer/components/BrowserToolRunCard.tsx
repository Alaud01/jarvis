import React, { useEffect, useMemo, useState } from 'react';
import ThinkingSection from './ThinkingSection';
import LLMTraceSection from './LLMTraceSection';
import type { BrowserScreenshotArtifact, BrowserToolRun } from '../../shared/browser';

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

const getLatestScreenshot = (
  screenshots?: BrowserScreenshotArtifact[]
): BrowserScreenshotArtifact | undefined => {
  if (!screenshots?.length) {
    return undefined;
  }

  return screenshots
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
};

const BrowserToolRunCard: React.FC<BrowserToolRunCardProps> = ({ run }) => {
  const startedAt = formatTimestamp(run.startedAt);
  const finishedAt = formatTimestamp(run.finishedAt);
  const latestScreenshot = useMemo(() => getLatestScreenshot(run.screenshots), [run.screenshots]);
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [isScreenshotVisible, setIsScreenshotVisible] = useState(run.status !== 'running');

  useEffect(() => {
    let cancelled = false;

    if (!latestScreenshot || !isScreenshotVisible) {
      setScreenshotDataUrl(null);
      return () => {
        cancelled = true;
      };
    }

    window.assistant.getBrowserArtifactDataUrl(latestScreenshot.path)
      .then((dataUrl) => {
        if (!cancelled) {
          setScreenshotDataUrl(dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setScreenshotDataUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isScreenshotVisible, latestScreenshot]);

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

      {latestScreenshot && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[0.65rem] uppercase tracking-[2px] text-text-tertiary">
              {latestScreenshot.label}
            </span>
            <button
              type="button"
              className="font-mono text-[0.65rem] uppercase tracking-[2px] text-text-secondary transition-colors hover:text-text-primary"
              onClick={() => setIsScreenshotVisible((value) => !value)}
            >
              {isScreenshotVisible ? 'Hide screenshot' : 'View screenshot'}
            </button>
          </div>

          {isScreenshotVisible && screenshotDataUrl && (
            <img
              src={screenshotDataUrl}
              alt={latestScreenshot.label}
              className="mt-2 w-full max-h-64 object-contain border border-border-secondary bg-bg-primary"
            />
          )}

          {isScreenshotVisible && !screenshotDataUrl && (
            <p className="mt-2 text-xs text-text-tertiary">
              Screenshot preview unavailable.
            </p>
          )}
        </div>
      )}

      {run.llmTrace && <LLMTraceSection trace={run.llmTrace} />}

      {(run.mode || startedAt || finishedAt) && (
        <div className="mt-3 flex flex-col gap-1 font-mono text-[0.65rem] text-text-tertiary">
          {run.mode && <span>mode: {run.mode}</span>}
          {startedAt && <span>started: {startedAt}</span>}
          {finishedAt && <span>finished: {finishedAt}</span>}
        </div>
      )}
    </div>
  );
};

export default BrowserToolRunCard;
