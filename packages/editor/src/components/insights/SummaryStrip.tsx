/**
 * P6-57 (L13): the five tiles (total, failed, failure rate, time saved, average run time). A value shows in the
 * unit that reads best (minutes turn to hours at 60, milliseconds to seconds at 1000); the change against the
 * period before is a percent for counts, time and run time, and points (pp) for the failure rate. It is green
 * when it is good (more runs, more time saved; fewer failures, a lower rate, a faster run) and red when it is not.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { InsightsMetric, InsightsSummary, InsightsSummaryType } from '../../api/types';
import { cx } from '../ui/cx';
import { Spinner } from '../ui/misc';

export interface SummaryStripProps {
  summary: InsightsSummary | undefined;
  loading: boolean;
  /** the tile drawn as selected (the page's chart) */
  active?: InsightsSummaryType;
  /** a tile links to its chart when given */
  linkTo?(type: InsightsSummaryType): string;
}

export const INSIGHTS_TILES: ReadonlyArray<{ type: InsightsSummaryType; label: string }> = [
  { type: 'total', label: 'Production executions' },
  { type: 'failed', label: 'Failed production executions' },
  { type: 'failureRate', label: 'Failure rate' },
  { type: 'timeSaved', label: 'Time saved' },
  { type: 'averageRunTime', label: 'Run time (avg.)' },
];

/** shown when no workflow has a time estimate, in place of a bare zero */
export const NO_ESTIMATE_HINT =
  "No time estimate yet. Add the time a run saves in a workflow's settings and it shows up here.";
export const MANUAL_RUNS_HINT = "Manual executions aren't counted.";

const trim = (n: number, places: number): string => {
  const f = 10 ** places;
  return String(Math.round(n * f) / f);
};

const number = (n: number): string => Math.round(n).toLocaleString('en-US');

/** the value of a tile as text: `1,204`, `8.3%`, `45 min`, `2.5 h`, `340 ms`, `1.2 s` */
export function formatMetric(type: InsightsSummaryType, metric: InsightsMetric): string {
  const { value } = metric;
  if (type === 'failureRate') return `${trim(value * 100, 1)}%`;
  if (type === 'timeSaved') return value >= 60 ? `${trim(value / 60, 1)} h` : `${number(value)} min`;
  if (type === 'averageRunTime') return value >= 1000 ? `${trim(value / 1000, 2)} s` : `${trim(value, 0)} ms`;
  return number(value);
}

/** the change against the period before as text (`+12%`, `-1.5 pp`), or null when there is nothing to compare */
export function formatChange(type: InsightsSummaryType, metric: InsightsMetric): string | null {
  const { deviation, value } = metric;
  if (deviation === null) return null;
  const sign = deviation > 0 ? '+' : deviation < 0 ? '-' : '';
  if (type === 'failureRate') return `${sign}${trim(Math.abs(deviation) * 100, 1)} pp`;
  const previous = value - deviation;
  if (previous <= 0) return null;
  return `${sign}${trim((Math.abs(deviation) / previous) * 100, 1)}%`;
}

/** is the change good news: more runs and time saved, fewer failures, a lower rate and a faster run */
export function changeTone(type: InsightsSummaryType, deviation: number | null): 'good' | 'bad' | 'none' {
  if (deviation === null || deviation === 0) return 'none';
  const upIsGood = type === 'total' || type === 'timeSaved';
  return deviation > 0 === upIsGood ? 'good' : 'bad';
}

export function SummaryStrip({ summary, loading, active, linkTo }: SummaryStripProps) {
  return (
    <ul className="grid list-none grid-cols-2 gap-3 p-0 md:grid-cols-3 lg:grid-cols-5" aria-label="Summary">
      {INSIGHTS_TILES.map(({ type, label }) => {
        const metric = summary?.[type];
        const change = metric ? formatChange(type, metric) : null;
        const tone = metric ? changeTone(type, metric.deviation) : 'none';
        const noEstimate = type === 'timeSaved' && metric !== undefined && metric.value === 0;
        const body: ReactNode = (
          <>
            <span className="text-xs font-medium text-ink-2">{label}</span>
            <span className="flex items-baseline gap-2">
              {metric ? (
                <span
                  className="font-display text-xl font-semibold text-ink"
                  data-testid={`insights-tile-${type}-value`}
                  title={noEstimate ? NO_ESTIMATE_HINT : undefined}
                >
                  {formatMetric(type, metric)}
                </span>
              ) : loading ? (
                <Spinner />
              ) : (
                <span className="text-ink-3">-</span>
              )}
              {change && (
                <span
                  className={cx(
                    'text-xs font-medium',
                    tone === 'good' && 'text-ok',
                    tone === 'bad' && 'text-err',
                    tone === 'none' && 'text-ink-3',
                  )}
                  data-testid={`insights-tile-${type}-change`}
                >
                  {change}
                </span>
              )}
            </span>
            {noEstimate && <span className="text-xs text-ink-3">{NO_ESTIMATE_HINT}</span>}
          </>
        );
        const classes = cx(
          'flex min-h-20 flex-col gap-1 rounded-xl border bg-surface p-3 text-left',
          active === type ? 'border-brand' : 'border-line',
        );
        return (
          <li key={type} data-testid={`insights-tile-${type}`}>
            {linkTo ? (
              <Link
                to={linkTo(type)}
                className={cx(classes, 'hover:bg-surface-2')}
                aria-current={active === type ? 'true' : undefined}
              >
                {body}
              </Link>
            ) : (
              <div className={classes}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
