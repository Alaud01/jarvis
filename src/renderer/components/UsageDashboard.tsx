import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  UsageDashboardData,
  UsageRange,
  UsageSeriesPoint,
  UsageTokenMode,
} from '../../shared/usage';

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'hour', label: 'Past hour' },
  { id: 'day', label: 'Past day' },
  { id: 'week', label: 'Past week' },
  { id: 'month', label: 'Past month' },
];

const TOKEN_MODES: { id: UsageTokenMode; label: string }[] = [
  { id: 'total', label: 'Total' },
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
];

const MODEL_COLORS = [
  '#2dd4bf',
  '#f472b6',
  '#60a5fa',
  '#818cf8',
  '#c084fc',
  '#fb923c',
  '#a3e635',
  '#facc15',
  '#94a3b8',
];

function modelColor(model: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < model.length; i += 1) {
    hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
  }
  return MODEL_COLORS[(hash + index) % MODEL_COLORS.length];
}

function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(1);
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(1);
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

function shortModelName(model: string): string {
  if (model.length <= 28) return model;
  return `${model.slice(0, 25)}…`;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function chooseXAxisLabelIndexes(points: UsageSeriesPoint[], minRenderedPlotWidth: number): Set<number> {
  if (points.length === 0) return new Set();

  const longestLabel = points.reduce((longest, point) => Math.max(longest, point.label.length), 0);
  const estimatedLabelWidth = longestLabel * 5.5 + 12;
  const bucketSpacing = minRenderedPlotWidth / Math.max(1, points.length);
  const step = Math.max(1, Math.ceil(estimatedLabelWidth / bucketSpacing));
  const minIndexGap = Math.max(1, Math.ceil(estimatedLabelWidth / bucketSpacing));
  const indexes = new Set<number>();

  for (let index = 0; index < points.length; index += step) {
    indexes.add(index);
  }

  const lastIndex = points.length - 1;
  for (const index of [...indexes]) {
    if (index !== 0 && index !== lastIndex && lastIndex - index < minIndexGap) {
      indexes.delete(index);
    }
  }
  indexes.add(lastIndex);

  return indexes;
}

interface ChartSeriesProps {
  title: string;
  points: UsageSeriesPoint[];
  models: string[];
  colorByModel: Record<string, string>;
  unitLabel: string;
  stacked?: boolean;
  summaryLabel?: string;
  formatValue?: (value: number) => string;
}

const StackedBarChart: React.FC<ChartSeriesProps> = ({
  title,
  points,
  models,
  colorByModel,
  unitLabel,
  stacked = true,
  summaryLabel = 'Total',
  formatValue = formatCount,
}) => {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const maxTotal = Math.max(
    1,
    ...points.map((point) => (
      stacked
        ? point.total
        : Math.max(point.total, ...models.map((model) => point.byModel[model] ?? 0))
    )),
  );
  const width = 760;
  const height = 220;
  const minRenderedWidth = 520;
  const pad = { top: 18, right: 12, bottom: 36, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const barGap = 0.28;
  const barW = points.length > 0 ? (plotW / points.length) * (1 - barGap) : 0;
  const hovered = hoverIndex === null ? null : points[hoverIndex];
  const minRenderedPlotWidth = minRenderedWidth * (plotW / width);
  const labelIndexes = chooseXAxisLabelIndexes(points, minRenderedPlotWidth);
  const updateHoverPosition = (index: number, event: React.MouseEvent<SVGRectElement>) => {
    const container = event.currentTarget.ownerSVGElement?.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const tooltipWidth = tooltipRef.current?.offsetWidth ?? 210;
    const tooltipHeight = tooltipRef.current?.offsetHeight ?? 140;
    const tooltipGap = 4;
    const edgeMargin = 8;
    const cursorX = event.clientX - rect.left + container.scrollLeft;
    const cursorY = event.clientY - rect.top + container.scrollTop;
    const visibleLeft = container.scrollLeft + edgeMargin;
    const visibleRight = container.scrollLeft + container.clientWidth - edgeMargin;
    const visibleTop = container.scrollTop + edgeMargin;
    const visibleBottom = container.scrollTop + container.clientHeight - edgeMargin;
    const spaceRight = visibleRight - cursorX;
    const spaceLeft = cursorX - visibleLeft;
    const spaceBelow = visibleBottom - cursorY;
    const spaceAbove = cursorY - visibleTop;
    const placeRight = spaceRight >= tooltipWidth + tooltipGap || spaceRight >= spaceLeft;
    const placeBelow = spaceBelow >= tooltipHeight + tooltipGap || spaceBelow >= spaceAbove;
    const nextX = placeRight ? cursorX + tooltipGap : cursorX - tooltipWidth - tooltipGap;
    const nextY = placeBelow ? cursorY + tooltipGap : cursorY - tooltipHeight - tooltipGap;

    setHoverIndex(index);
    setTooltipPosition({
      x: clamp(nextX, visibleLeft, visibleRight - tooltipWidth),
      y: clamp(nextY, visibleTop, visibleBottom - tooltipHeight),
    });
  };
  const clearHover = () => setHoverIndex(null);

  return (
    <section className="rounded-lg border border-border-primary bg-bg-secondary p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-text-primary">{title}</h2>
        <span className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">{unitLabel}</span>
      </div>

      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-[220px] w-full min-w-[520px]"
          role="img"
          aria-label={title}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const y = pad.top + plotH * (1 - fraction);
            return (
              <g key={fraction}>
                <line
                  x1={pad.left}
                  x2={width - pad.right}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border-primary"
                  strokeDasharray="3 4"
                  strokeWidth="1"
                />
                <text
                  x={pad.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-text-muted font-mono text-[9px]"
                >
                  {formatValue(maxTotal * fraction)}
                </text>
              </g>
            );
          })}

          {points.map((point, index) => {
            const columnW = plotW / Math.max(1, points.length);
            const columnX = pad.left + columnW * index;
            const x = columnX + (columnW - barW) / 2;
            let yCursor = pad.top + plotH;

            if (!stacked) {
              const segments = models
                .map((model) => ({ model, value: point.byModel[model] ?? 0 }))
                .filter((segment) => segment.value > 0);
              const segmentW = segments.length > 0 ? barW / segments.length : barW;

              return (
                <g key={point.bucketStart}>
                  {segments.map((segment, segmentIndex) => {
                    const barH = (segment.value / maxTotal) * plotH;
                    return (
                      <rect
                        key={segment.model}
                        x={x + segmentIndex * segmentW}
                        y={pad.top + plotH - barH}
                        width={Math.max(1, segmentW - 1)}
                        height={Math.max(0, barH)}
                        fill={colorByModel[segment.model]}
                        opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.35}
                      />
                    );
                  })}
                  <text
                    x={x + barW / 2}
                    y={height - 12}
                    textAnchor="middle"
                    className="fill-text-muted font-mono text-[9px]"
                  >
                    {labelIndexes.has(index) ? point.label : ''}
                  </text>
                  <rect
                    x={columnX}
                    y={pad.top}
                    width={columnW}
                    height={plotH}
                    fill="transparent"
                    pointerEvents="all"
                    onMouseEnter={(event) => updateHoverPosition(index, event)}
                    onMouseMove={(event) => updateHoverPosition(index, event)}
                    onMouseLeave={clearHover}
                  />
                </g>
              );
            }

            const segments = models
              .map((model) => ({ model, value: point.byModel[model] ?? 0 }))
              .filter((segment) => segment.value > 0);

            return (
              <g key={point.bucketStart}>
                {segments.map((segment) => {
                  const barH = (segment.value / maxTotal) * plotH;
                  yCursor -= barH;
                  const rect = (
                    <rect
                      key={segment.model}
                      x={x}
                      y={yCursor}
                      width={Math.max(1, barW)}
                      height={Math.max(0, barH)}
                      fill={colorByModel[segment.model]}
                      opacity={hoverIndex === null || hoverIndex === index ? 1 : 0.35}
                    />
                  );
                  return rect;
                })}
                <text
                  x={x + barW / 2}
                  y={height - 12}
                  textAnchor="middle"
                  className="fill-text-muted font-mono text-[9px]"
                >
                  {labelIndexes.has(index) ? point.label : ''}
                </text>
                <rect
                  x={columnX}
                  y={pad.top}
                  width={columnW}
                  height={plotH}
                  fill="transparent"
                  pointerEvents="all"
                  onMouseEnter={(event) => updateHoverPosition(index, event)}
                  onMouseMove={(event) => updateHoverPosition(index, event)}
                  onMouseLeave={clearHover}
                />
              </g>
            );
          })}
        </svg>

        {hovered ? (
          <div
            ref={tooltipRef}
            className="pointer-events-none absolute z-10 min-w-[180px] rounded-md border border-border-primary bg-bg-primary/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
            style={{ left: tooltipPosition.x, top: tooltipPosition.y }}
          >
            <div className="mb-2 font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">
              {hovered.label}
            </div>
            {models
              .map((model) => ({ model, value: hovered.byModel[model] ?? 0 }))
              .filter((row) => row.value > 0)
              .sort((a, b) => b.value - a.value)
              .map((row) => (
                <div key={row.model} className="mb-1 flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 text-text-secondary">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorByModel[row.model] }} />
                    <span className="truncate">{shortModelName(row.model)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-text-primary">{formatValue(row.value)}</span>
                </div>
              ))}
            <div className="mt-2 flex items-center justify-between border-t border-border-primary pt-2 font-medium text-text-primary">
              <span>{summaryLabel}</span>
              <span className="font-mono">{formatValue(hovered.total)}</span>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {models.map((model) => (
          <div key={model} className="flex items-center gap-2 text-[0.7rem] text-text-tertiary">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorByModel[model] }} />
            <span className="max-w-[180px] truncate">{shortModelName(model)}</span>
          </div>
        ))}
        {models.length === 0 ? (
          <span className="text-[0.7rem] text-text-muted">No model activity in this range</span>
        ) : null}
      </div>
    </section>
  );
};

const EMPTY_DATA: UsageDashboardData = {
  range: 'day',
  tokenMode: 'total',
  models: [],
  usage: [],
  input: [],
  output: [],
  tps: [],
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    avgTps: 0,
  },
};

const UsageDashboard: React.FC<{
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}> = ({ scrollContainerRef }) => {
  const [range, setRange] = useState<UsageRange>('day');
  const [tokenMode, setTokenMode] = useState<UsageTokenMode>('total');
  const [data, setData] = useState<UsageDashboardData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const next = await window.assistant.usageDashboard({ range, tokenMode });
      setData(next);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load usage dashboard');
    } finally {
      setLoading(false);
    }
  }, [range, tokenMode]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const colorByModel = useMemo(() => {
    const map: Record<string, string> = {};
    data.models.forEach((model, index) => {
      map[model] = modelColor(model, index);
    });
    return map;
  }, [data.models]);

  const usageTitle = tokenMode === 'input'
    ? 'Usage by model · Input tokens'
    : tokenMode === 'output'
      ? 'Usage by model · Output tokens'
      : 'Usage by model · Total tokens';
  const tpsModels = data.models.filter((model) => (
    data.tps.some((point) => (point.byModel[model] ?? 0) > 0)
  ));
  const hasCodexUsage = data.models.some((model) => model.startsWith('codex:'));

  return (
    <div ref={scrollContainerRef} className="flex h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-8 py-10">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="font-mono text-[0.6rem] uppercase tracking-[2px] text-text-muted">Analytics</div>
            <h1 className="mt-2 text-2xl font-semibold text-text-primary">Usage Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-tertiary">
              Input tokens, output tokens, tokens per second, and total usage broken out by model across recent windows.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Input', value: formatCount(data.totals.inputTokens) },
              { label: 'Output', value: formatCount(data.totals.outputTokens) },
              { label: 'Total', value: formatCount(data.totals.totalTokens) },
              { label: 'Avg TPS', value: formatRate(data.totals.avgTps) },
            ].map((card) => (
              <div key={card.label} className="rounded-md border border-border-primary bg-bg-secondary px-4 py-3">
                <div className="font-mono text-[0.55rem] uppercase tracking-widest text-text-muted">{card.label}</div>
                <div className="mt-1 text-xl text-text-primary">{card.value}</div>
              </div>
            ))}
          </div>
        </header>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex border border-border-primary bg-bg-secondary p-0.5">
            {RANGES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setRange(item.id)}
                className={`px-3 py-1.5 text-[0.65rem] transition-colors ${range === item.id ? 'bg-text-primary text-bg-primary' : 'text-text-tertiary hover:text-text-primary'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex border border-border-primary bg-bg-secondary p-0.5">
            {TOKEN_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTokenMode(item.id)}
                className={`px-3 py-1.5 text-[0.65rem] transition-colors ${tokenMode === item.id ? 'bg-text-primary text-bg-primary' : 'text-text-tertiary hover:text-text-primary'}`}
              >
                Usage: {item.label}
              </button>
            ))}
          </div>
        </div>

        {error ? <div className="border border-red-400/40 bg-red-400/5 px-3 py-2 text-sm text-red-400">{error}</div> : null}

        {loading ? (
          <div className="rounded-lg border border-border-primary px-5 py-16 text-center text-sm text-text-tertiary">
            Loading usage...
          </div>
        ) : (
          <div className="grid gap-5">
            <StackedBarChart
              title={usageTitle}
              points={data.usage}
              models={data.models}
              colorByModel={colorByModel}
              unitLabel="tokens"
            />
            <StackedBarChart
              title="Generation TPS by model"
              points={data.tps}
              models={tpsModels}
              colorByModel={colorByModel}
              unitLabel="tokens / sec"
              stacked={false}
              summaryLabel="Weighted avg"
              formatValue={formatRate}
            />
            {hasCodexUsage ? (
              <p className="-mt-3 text-[0.7rem] text-text-muted">
                Codex is excluded from TPS because it reports token counts but not model-generation duration.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

export default UsageDashboard;
