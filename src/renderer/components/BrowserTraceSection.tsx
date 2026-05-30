import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserLLMTraceStep, BrowserToolRun } from '../../shared/browser';
import MarkdownRenderer from './MarkdownRenderer';

interface BrowserTraceSectionProps {
  run: BrowserToolRun;
  onAutoScrollCancel?: () => void;
  onAutoScrollReactivate?: () => void;
}

const AUTO_SCROLL_BOTTOM_THRESHOLD = 8;
const STREAMING_STICKY_BOTTOM_THRESHOLD = 50;

const isNearBottom = (
  container: HTMLElement,
  threshold = AUTO_SCROLL_BOTTOM_THRESHOLD
) => (
  container.scrollHeight - container.scrollTop - container.clientHeight < threshold
);

const formatTime = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

const formatDuration = (durationMs?: number) => {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return '';
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
};

const stringifyInput = (input: Record<string, unknown>) => {
  const text = JSON.stringify(input);
  if (!text || text === '{}') return '';
  return text.length > 220 ? `${text.slice(0, 220)}...` : text;
};

const StepBlock: React.FC<{ step: BrowserLLMTraceStep }> = ({ step }) => {
  const duration = formatDuration(step.durationMs);

  return (
    <div className="border-t border-border-secondary first:border-t-0 py-3 first:pt-0 last:pb-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 thinking-panel-toggle-label">
        <span>Step {step.stepIndex + 1}</span>
        {formatTime(step.timestamp) && <span>{formatTime(step.timestamp)}</span>}
        {duration && <span>{duration}</span>}
      </div>

      {(step.pageTitle || step.url) && (
        <div className="mb-2 min-w-0 text-text-secondary">
          {step.pageTitle && <div className="truncate font-medium text-text-primary">{step.pageTitle}</div>}
          {step.url && <div className="truncate thinking-panel-meta">{step.url}</div>}
        </div>
      )}

      {step.thinking && (
        <div className="mb-3 italic text-text-tertiary">
          <MarkdownRenderer content={step.thinking} />
        </div>
      )}

      <div className="space-y-2 text-text-secondary">
        {step.evaluationPreviousGoal && (
          <div>
            <span className="thinking-panel-section-label">Evaluation</span>
            <div className="mt-1">{step.evaluationPreviousGoal}</div>
          </div>
        )}
        {step.memory && (
          <div>
            <span className="thinking-panel-section-label">Memory</span>
            <div className="mt-1">{step.memory}</div>
          </div>
        )}
        {step.nextGoal && (
          <div>
            <span className="thinking-panel-section-label">Next</span>
            <div className="mt-1">{step.nextGoal}</div>
          </div>
        )}
        {step.actions && step.actions.length > 0 && (
          <div>
            <span className="thinking-panel-section-label">Actions</span>
            <div className="mt-1 space-y-1">
              {step.actions.map((action, index) => (
                <div key={`${action.toolName}-${index}`} className="min-w-0 rounded border border-border-secondary px-2 py-1">
                  <span className="font-mono text-text-primary">{action.toolName}</span>
                  {stringifyInput(action.input) && (
                    <span className="ml-2 break-words thinking-panel-meta">
                      {stringifyInput(action.input)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {step.results && step.results.length > 0 && (
          <div>
            <span className="thinking-panel-section-label">Results</span>
            <div className="mt-1 space-y-1">
              {step.results.map((result, index) => {
                const text = result.error
                  ?? result.extractedContent
                  ?? result.longTermMemory
                  ?? (result.isDone ? `Done: ${String(result.success)}` : 'OK');
                return (
                  <div
                    key={index}
                    className={`rounded border px-2 py-1 ${
                      result.error
                        ? 'border-red-500/40 text-red-300'
                        : 'border-border-secondary text-text-secondary'
                    }`}
                  >
                    {text}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const BrowserTraceSection: React.FC<BrowserTraceSectionProps> = ({
  run,
  onAutoScrollCancel,
  onAutoScrollReactivate,
}) => {
  const isRunning = run.status === 'running';
  const [isExpanded, setIsExpanded] = useState(isRunning);
  const contentRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);
  const steps = run.llmTrace?.steps ?? [];

  const setAutoScrollEnabled = useCallback((enabled: boolean) => {
    if (autoScrollEnabledRef.current === enabled) return;
    autoScrollEnabledRef.current = enabled;
    if (enabled) {
      onAutoScrollReactivate?.();
    } else {
      onAutoScrollCancel?.();
    }
  }, [onAutoScrollCancel, onAutoScrollReactivate]);

  useEffect(() => {
    if (isRunning) {
      setIsExpanded(true);
      return;
    }
    if (steps.length > 0 || run.summary || run.error) {
      setIsExpanded(false);
    }
  }, [isRunning, run.error, run.summary, steps.length]);

  const scrollSnapshot = (() => {
    if (!isRunning || !isExpanded || !autoScrollEnabledRef.current) {
      return { shouldMaintain: false };
    }
    const container = contentRef.current;
    return {
      shouldMaintain: container ? isNearBottom(container, STREAMING_STICKY_BOTTOM_THRESHOLD) : true,
    };
  })();

  useLayoutEffect(() => {
    if (!isRunning || !isExpanded || !scrollSnapshot.shouldMaintain) return;
    const container = contentRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'auto' });
    setAutoScrollEnabled(true);
  }, [isRunning, isExpanded, run.summary, run.error, steps.length, scrollSnapshot.shouldMaintain, setAutoScrollEnabled]);

  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container || !isExpanded) return;

    setAutoScrollEnabled(isNearBottom(container));

    const handleScroll = () => {
      setAutoScrollEnabled(isNearBottom(container));
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [isExpanded, setAutoScrollEnabled]);

  return (
    <div className="my-2 border bg-transparent border-border-secondary rounded bg-bg-secondary">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-2 py-2 flex items-center justify-between gap-3 text-left hover:bg-bg-hover transition-colors"
      >
        <div className="flex min-w-0 items-center gap-2">
          <svg
            className={`shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="shrink-0 thinking-panel-toggle-label">
            {isRunning ? 'Browser running...' : `Browser ${run.status}`}
          </span>
          <span className="truncate thinking-panel-toggle-hint">
            {run.model ?? run.llmTrace?.model ?? 'model'} · {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
        </div>
        <span className="shrink-0 thinking-panel-toggle-hint">
          {isExpanded ? 'Click to collapse' : 'Click to expand'}
        </span>
      </button>

      {isExpanded && (
        <div
          ref={contentRef}
          className={`px-4 pb-4 pt-2 border-t border-border-secondary thinking-scroll-container ${isRunning ? 'max-h-[360px] overflow-y-auto' : ''}`}
        >
          <div className="mb-3 text-text-secondary">
            <div className="font-medium text-text-primary">{run.instruction}</div>
            {(run.llmTrace?.plannerModel || typeof run.llmTrace?.useVision === 'boolean') && (
              <div className="mt-1 thinking-panel-meta">
                {run.llmTrace?.plannerModel && `planner ${run.llmTrace.plannerModel}`}
                {run.llmTrace?.plannerModel && typeof run.llmTrace?.useVision === 'boolean' && ' · '}
                {typeof run.llmTrace?.useVision === 'boolean' && `vision ${run.llmTrace.useVision ? 'on' : 'off'}`}
              </div>
            )}
          </div>

          <div className="space-y-0">
            {steps.map(step => (
              <StepBlock key={step.stepIndex} step={step} />
            ))}
          </div>

          {(run.summary || run.error) && (
            <div className="mt-3 border-t border-border-secondary pt-3 text-text-secondary">
              {run.summary && <div>{run.summary}</div>}
              {run.error && <div className="mt-2 text-red-300">{run.error}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BrowserTraceSection;
