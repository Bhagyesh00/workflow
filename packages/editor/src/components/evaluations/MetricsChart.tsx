/**
 * Mean of each metric over the completed runs of a workflow (P5-11): one line per metric in inline SVG (no
 * chart package), axis labels, a text summary on the image, the same numbers as a table, and colours through
 * the theme tokens so light and dark both read. The predefined metrics (tokens, time) have their own scale
 * and start hidden when the workflow has a metric of its own.
 */
import { PREDEFINED_METRICS, type TestRunDto } from '@workflow/workflow';
import { useId, useMemo, useState } from 'react';
import { formatDateTime } from '../../lib/format';

const WIDTH = 640;
const HEIGHT = 260;
const MARGIN = { left: 56, right: 20, top: 14, bottom: 44 };
const COLORS = [
  'var(--color-brand)',
  'var(--color-ok)',
  'var(--color-warn)',
  'var(--color-pin)',
  'var(--color-err)',
  'var(--color-run)',
];
const DASHES = [undefined, '6 3', '2 3', '8 3 2 3'];
const PREDEFINED = new Set<string>(PREDEFINED_METRICS);
const MAX_X_LABELS = 10;

export function formatMetric(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** metric names over the runs, the workflow's own first, then the predefined ones */
export function metricNames(rows: Array<{ metrics: Record<string, number> | null }>): string[] {
  const names = new Set<string>();
  for (const row of rows) for (const name of Object.keys(row.metrics ?? {})) names.add(name);
  const all = [...names].sort((a, b) => a.localeCompare(b));
  return [...all.filter((n) => !PREDEFINED.has(n)), ...all.filter((n) => PREDEFINED.has(n))];
}

/** a round upper bound for the y axis */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exponent = 10 ** Math.floor(Math.log10(max));
  const fraction = max / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * exponent;
}

export function MetricsChart({ runs }: { runs: TestRunDto[] }) {
  const titleId = useId();
  const points = useMemo(
    () =>
      runs
        .filter((r) => r.status === 'completed' && r.metrics && Object.keys(r.metrics).length > 0)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs],
  );
  const names = useMemo(() => metricNames(points), [points]);
  const ownNames = names.filter((n) => !PREDEFINED.has(n));
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const isShown = (name: string) =>
    name in hidden ? !hidden[name] : ownNames.length === 0 || !PREDEFINED.has(name);
  const shown = names.filter(isShown);

  if (points.length === 0) return null;

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const values = shown.flatMap((name) =>
    points.map((p) => p.metrics?.[name]).filter((v): v is number => typeof v === 'number'),
  );
  const top = niceMax(Math.max(0, ...values));
  const x = (i: number) =>
    MARGIN.left + (points.length === 1 ? plotW / 2 : (plotW * i) / (points.length - 1));
  const y = (v: number) => MARGIN.top + plotH - (plotH * v) / top;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => top * f);
  const labelStep = Math.max(1, Math.ceil(points.length / MAX_X_LABELS));

  const lineOf = (name: string): string =>
    points
      .map((p, i) => ({ i, v: p.metrics?.[name] }))
      .filter((pt): pt is { i: number; v: number } => typeof pt.v === 'number')
      .map((pt, k) => `${k === 0 ? 'M' : 'L'}${x(pt.i).toFixed(1)} ${y(pt.v).toFixed(1)}`)
      .join(' ');

  const summary = `Line chart of ${shown.length} ${shown.length === 1 ? 'metric' : 'metrics'} over ${points.length} ${
    points.length === 1 ? 'run' : 'runs'
  }. ${shown
    .map((name) => {
      const series = points.map((p) => p.metrics?.[name]).filter((v): v is number => typeof v === 'number');
      return series.length
        ? `${name}: ${formatMetric(series[0])} in the first run, ${formatMetric(series[series.length - 1])} in the last.`
        : `${name}: no values.`;
    })
    .join(' ')}`;

  return (
    <section aria-labelledby={titleId} className="rounded-xl border border-line bg-surface p-4 shadow-card">
      <h2 id={titleId} className="font-display text-md font-semibold text-ink">
        Metrics over runs
      </h2>
      <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-0 p-0">
        <legend className="sr-only">Metrics shown in the chart</legend>
        {names.map((name, index) => (
          <label key={name} className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={isShown(name)}
              onChange={(event) => setHidden((h) => ({ ...h, [name]: !event.target.checked }))}
            />
            <svg width="22" height="8" aria-hidden="true">
              <line
                x1="0"
                x2="22"
                y1="4"
                y2="4"
                stroke={COLORS[index % COLORS.length]}
                strokeWidth="2"
                strokeDasharray={DASHES[index % DASHES.length]}
              />
            </svg>
            {name}
          </label>
        ))}
      </fieldset>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        className="mt-2 h-auto w-full max-w-3xl text-ink-3"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--color-line)"
              strokeWidth="1"
            />
            <text x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="currentColor">
              {formatMetric(Number(tick.toPrecision(3)))}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={WIDTH - MARGIN.right}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--color-line-strong)"
          strokeWidth="1"
        />
        {points.map((p, i) =>
          i % labelStep === 0 ? (
            <text
              key={p.id}
              x={x(i)}
              y={HEIGHT - MARGIN.bottom + 16}
              textAnchor="middle"
              fontSize="11"
              fill="currentColor"
            >
              {`#${i + 1}`}
            </text>
          ) : null,
        )}
        <text
          x={MARGIN.left + plotW / 2}
          y={HEIGHT - 6}
          textAnchor="middle"
          fontSize="12"
          fill="currentColor"
        >
          Run, oldest to newest
        </text>
        <text
          x={14}
          y={MARGIN.top + plotH / 2}
          textAnchor="middle"
          fontSize="12"
          fill="currentColor"
          transform={`rotate(-90 14 ${MARGIN.top + plotH / 2})`}
        >
          Mean value
        </text>
        {shown.map((name) => {
          const index = names.indexOf(name);
          const color = COLORS[index % COLORS.length];
          return (
            <g key={name} data-metric={name}>
              <path
                d={lineOf(name)}
                fill="none"
                stroke={color}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={DASHES[index % DASHES.length]}
              />
              {points.map((p, i) =>
                typeof p.metrics?.[name] === 'number' ? (
                  <circle key={p.id} cx={x(i)} cy={y(p.metrics[name] as number)} r="3.5" fill={color}>
                    <title>{`${name}, run #${i + 1}: ${formatMetric(p.metrics[name])}`}</title>
                  </circle>
                ) : null,
              )}
            </g>
          );
        })}
      </svg>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-ink-2">Show the numbers as a table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs" aria-label="Metrics over runs, as a table">
            <thead>
              <tr className="text-ink-3">
                <th className="py-1 pr-3 font-semibold">Run</th>
                <th className="py-1 pr-3 font-semibold">Started</th>
                {names.map((name) => (
                  <th key={name} className="py-1 pr-3 font-semibold">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((p, i) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-1 pr-3">{`#${i + 1}`}</td>
                  <td className="py-1 pr-3">{formatDateTime(p.runAt ?? p.createdAt)}</td>
                  {names.map((name) => (
                    <td key={name} className="py-1 pr-3 tabular-nums">
                      {formatMetric(p.metrics?.[name])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
