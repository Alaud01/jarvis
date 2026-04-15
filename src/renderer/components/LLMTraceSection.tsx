import React, { useState } from 'react';
import type { BrowserLLMTrace, BrowserLLMTraceStep } from '../../shared/browser';

interface LLMTraceSectionProps {
  trace: BrowserLLMTrace;
}

const StepCard: React.FC<{ step: BrowserLLMTraceStep }> = ({ step }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const toolSummary = step.toolCalls?.length
    ? step.toolCalls.map((tc) => `${tc.toolName}(${Object.keys(tc.input).length > 0 ? '...' : ''})`).join(', ')
    : undefined;

  return (
    <div className="border border-border-secondary bg-bg-primary rounded">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-bg-hover transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[0.6rem] text-text-muted shrink-0">#{step.stepIndex}</span>
          {toolSummary ? (
            <span className="text-xs text-text-secondary truncate">{toolSummary}</span>
          ) : step.reasoning ? (
            <span className="text-xs text-text-tertiary truncate">{step.reasoning.slice(0, 80)}</span>
          ) : (
            <span className="text-xs text-text-muted italic">no output</span>
          )}
        </div>
        <svg
          className={`shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border-secondary space-y-2">
          {step.reasoning && (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">Reasoning</span>
              <p className="mt-0.5 text-xs text-text-primary whitespace-pre-wrap">{step.reasoning}</p>
            </div>
          )}

          {step.toolCalls?.map((tc, i) => (
            <div key={i}>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">
                Tool call: {tc.toolName}
              </span>
              <pre className="mt-0.5 text-[0.7rem] text-text-secondary bg-bg-secondary p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(tc.input, null, 2)}
              </pre>
            </div>
          ))}

          {step.finishReason && (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">Finish reason</span>
              <p className="mt-0.5 text-xs text-text-tertiary">{step.finishReason}</p>
            </div>
          )}

          {step.rawLogLines?.length ? (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">Stagehand logs</span>
              <pre className="mt-0.5 text-[0.65rem] text-text-tertiary bg-bg-secondary p-2 rounded overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
                {step.rawLogLines.join('\n')}
              </pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

const LLMTraceSection: React.FC<LLMTraceSectionProps> = ({ trace }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mt-2 border border-border-secondary rounded bg-bg-secondary">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-bg-hover transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg
            className={`transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span className="font-mono text-[0.7rem] uppercase tracking-widest text-text-tertiary">
            LLM trace
          </span>
        </div>
        <span className="font-mono text-[0.65rem] text-text-muted">
          {trace.steps.length} step{trace.steps.length === 1 ? '' : 's'}
        </span>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 pt-2 border-t border-border-secondary space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[0.65rem] text-text-tertiary">
            <span>model: {trace.model}</span>
            <span>mode: {trace.mode}</span>
          </div>

          {trace.systemPrompt && (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">System prompt</span>
              <pre className="mt-0.5 text-[0.7rem] text-text-secondary bg-bg-primary p-2 rounded overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {trace.systemPrompt}
              </pre>
            </div>
          )}

          {trace.instruction && (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">Instruction</span>
              <pre className="mt-0.5 text-[0.7rem] text-text-secondary bg-bg-primary p-2 rounded overflow-x-auto whitespace-pre-wrap max-h-32 overflow-y-auto">
                {trace.instruction}
              </pre>
            </div>
          )}

          <div className="space-y-1.5">
            {trace.steps.map((step) => (
              <StepCard key={step.stepIndex} step={step} />
            ))}
          </div>

          {trace.error && (
            <div>
              <span className="font-mono text-[0.6rem] uppercase tracking-wider text-text-muted">Trace error</span>
              <p className="mt-0.5 text-xs text-text-primary">{trace.error}</p>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              className="font-mono text-[0.6rem] uppercase tracking-wider text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => {
                const blob = new Blob([JSON.stringify(trace, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `llm-trace-${trace.model.replace(/[^a-z0-9]/gi, '_')}-${new Date(trace.startedAt).getTime()}.json`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default LLMTraceSection;