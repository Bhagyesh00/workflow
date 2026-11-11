/**
 * P6-57 (L13): one own SVG chart per tile type, with keyboard focus on the buckets: bars for the counts and time
 * saved, a line for the failure rate and the average run time. No chart library. The buckets are one tab stop
 * (arrow keys, Home and End move between them); the focused or hovered bucket is named under the chart.
 */
import { type KeyboardEvent, type ReactNode, useRef, useState } from 'react';
import type { InsightsByTimeRow, InsightsGranularity, InsightsSummaryType } from '../../api/types';
import { formatMetric, INSIGHTS_TILES } from './SummaryStrip';

export interface InsightsChartProps {
  type: InsightsSummaryType;
  data: InsightsByTimeRow[];
  granularity: InsightsGranularity;
}

const WIDTH = 640;
const HEIGHT = 260;
const LEFT = 64;
const RIGHT = 12;
const TOP = 12;
const BOTTOM = 32;
const PLOT_W = WIDTH - LEFT - RIGHT;
const PLOT_H = HEIGHT - TOP - BOTTOM;
const TICKS = 4;

const UNIT: Record<InsightsSummaryType, 'count' | 'ratio' | 'minute' | 'millisecond'> = {
  total: 'count',
  failed: 'count',
  failureRate: 'ratio',
  timeSaved: 'minute',
  averageRunTime: 'millisecond',
};

/** bars for what adds up, a line for what is an average or a rate */
const LINE_TYPES: ReadonlySet<InsightsSummaryType> = new Set(['failureRate', 'averageRunTime']);

/** the short label of a bucket: the hour (`14:00`) or the day (`Mar 3`; a week is named by its first day) */
export function bucketLabel(date: string, granularity: InsightsGranularity): string {
  const when = new Date(date);
  if (granularity === 'hour') {
    return when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** the label said for a bucket: a week is "Week of Mar 3" */
function bucketName(date: string, granularity: InsightsGranularity): string {
  const label = bucketLabel(date, granularity);
  if (granularity === 'week') return `Week of ${label}`;
  if (granularity === 'hour') {
    return `${new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${label}`;
  }
  return label;
}

/** a round top for the axis, so the ticks read well (1, 2, 5 times a power of ten; a rate never passes 100%) */
function niceMax(max: number, type: InsightsSummaryType): number {
  if (max <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((s) => max <= s * power) ?? 10;
  const top = step * power;
  return type === 'failureRate' ? Math.min(top, 1) : top;
}

export function InsightsChart({ type, data, granularity }: InsightsChartProps) {
  const unit = UNIT[type];
  const title = INSIGHTS_TILES.find((tile) => tile.type === type)?.label ?? type;
  const refs = useRef<Array<SVGGElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const [shown, setShown] = useState<number | null>(null);

  if (data.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface p-6 text-center text-sm text-ink-2">
        No data for this period.
      </p>
    );
  }

  const values = data.map((row) => row.values[type] ?? 0);
  const top = niceMax(Math.max(...values), type);
  const band = PLOT_W / data.length;
  const x = (i: number) => LEFT + band * i + band / 2;
  const y = (value: number) => TOP + PLOT_H - (Math.min(value, top) / top) * PLOT_H;
  const text = (value: number) => formatMetric(type, { value, unit, deviation: null });
  const labelStep = Math.max(1, Math.ceil(data.length / 8));
  const current = Math.min(focusIndex, data.length - 1);

  const move = (event: KeyboardEvent, index: number) => {
    const last = data.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? Math.min(index + 1, last)
        : event.key === 'ArrowLeft'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    setShown(next);
    refs.current[next]?.focus();
  };

  const line: ReactNode = LINE_TYPES.has(type) ? (
    <polyline
      points={values.map((value, i) => `${x(i)},${y(value)}`).join(' ')}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="text-brand"
    />
  ) : null;

  const caption =
    shown === null ? null : `${bucketName(data[shown]!.date, granularity)}: ${text(values[shown]!)}`;

  return (
    <figure
      aria-label={`${title} chart`}
      className="m-0 flex flex-col gap-2 rounded-xl border border-line bg-surface p-3"
    >
      <figcaption className="text-sm font-medium text-ink">{title}</figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        data-testid="insights-chart"
        data-kind={LINE_TYPES.has(type) ? 'line' : 'bar'}
      >
        <title>{`${title} chart`}</title>
        {Array.from({ length: TICKS + 1 }, (_, step) => (top / TICKS) * step).map((value) => {
          return (
            <g key={`tick-${value}`}>
              <line
                x1={LEFT}
                x2={WIDTH - RIGHT}
                y1={y(value)}
                y2={y(value)}
                stroke="currentColor"
                className="text-line"
              />
              <text x={LEFT - 8} y={y(value) + 4} textAnchor="end" fontSize={11} className="fill-ink-3">
                {text(value)}
              </text>
            </g>
          );
        })}
        {line}
        <g role="listbox" aria-label={`${title} by ${granularity}`}>
          {data.map((row, i) => (
            <g
              key={row.date}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="option"
              aria-selected={shown === i}
              tabIndex={i === current ? 0 : -1}
              aria-label={`${bucketName(row.date, granularity)}: ${text(values[i]!)}`}
              data-testid="insights-bucket"
              className="outline-none"
              onFocus={() => {
                setFocusIndex(i);
                setShown(i);
              }}
              onBlur={() => setShown((now) => (now === i ? null : now))}
              onMouseEnter={() => setShown(i)}
              onMouseLeave={() => setShown((now) => (now === i ? null : now))}
              onKeyDown={(event) => move(event, i)}
            >
              <rect
                className={shown === i ? 'stroke-brand' : undefined}
                x={x(i) - band / 2}
                y={TOP}
                width={band}
                height={PLOT_H}
                fill="transparent"
                strokeWidth={2}
                stroke="transparent"
              />
              {LINE_TYPES.has(type) ? (
                <circle cx={x(i)} cy={y(values[i]!)} r={3.5} className="fill-brand" />
              ) : (
                <rect
                  x={x(i) - Math.max(band * 0.35, 1)}
                  y={y(values[i]!)}
                  width={Math.max(band * 0.7, 2)}
                  height={TOP + PLOT_H - y(values[i]!)}
                  className="fill-brand"
                />
              )}
              {i % labelStep === 0 && (
                <text x={x(i)} y={HEIGHT - 10} textAnchor="middle" fontSize={11} className="fill-ink-3">
                  {bucketLabel(row.date, granularity)}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
      <p className="m-0 min-h-5 text-xs text-ink-2" aria-live="polite" data-testid="insights-chart-caption">
        {caption}
      </p>
    </figure>
  );
}
