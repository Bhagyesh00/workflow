/**
 * P6-57 (L13): the demo's Insights: the five summary tiles, the by-time and by-workflow lists and the Insights
 * settings, `insights:list` (owner and admin; a member gets 403).
 *
 * The numbers come from the workspace's own workflows. Each workflow has a fixed pattern of runs per hour
 * (a function of its id and the hour, so a reload shows the same figures); every answer adds those hours up, so
 * the tiles, the charts and the table always agree. Time saved follows the workflow's own `timeSavedMode`
 * setting. The ranges follow the server: a range of a day or less is read by the hour, up to 30 days by the day,
 * longer by the week; the earlier period is the same length right before. Day and week edges are UTC here (the
 * server uses the caller's `timeZone`).
 */
import type {
  InsightsByTimeRow,
  InsightsByWorkflowRow,
  InsightsGranularity,
  InsightsMetric,
  InsightsSettings,
  InsightsSummary,
} from '../api/types';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { HttpError } from './mock-http';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** the first day with data: this long before the demo's clock, so the longest ranges show the alert */
const HISTORY_DAYS = 40;

const DATE_RANGES: InsightsSettings['dateRanges'] = [
  { key: 'day', licensed: true, granularity: 'hour' },
  { key: 'week', licensed: true, granularity: 'day' },
  { key: '2weeks', licensed: true, granularity: 'day' },
  { key: 'month', licensed: true, granularity: 'day' },
  { key: 'quarter', licensed: true, granularity: 'week' },
  { key: '6months', licensed: true, granularity: 'week' },
  { key: 'year', licensed: true, granularity: 'week' },
];

interface Facts {
  total: number;
  failed: number;
  runTime: number;
  timeSaved: number;
}

const empty = (): Facts => ({ total: 0, failed: 0, runTime: 0, timeSaved: 0 });

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** what a workflow ran in the hour that starts at `hourStart` (ms): no data before the history begins */
function hourFacts(wf: StoredWorkflow, hourStart: number, firstHour: number): Facts {
  if (hourStart < firstHour) return empty();
  const seed = hash(`${wf.id}:${hourStart / HOUR}`);
  if (seed % 11 >= 3) return empty();
  const total = 1 + (seed % 4);
  const failed = seed % 5 === 0 ? 1 : 0;
  const succeeded = total - failed;
  const minutes = wf.settings.timeSavedMode === 'dynamic' ? 0 : (wf.settings.timeSavedPerExecution ?? 0);
  return { total, failed, runTime: total * (200 + (seed % 800)), timeSaved: succeeded * minutes };
}

function add(into: Facts, from: Facts): void {
  into.total += from.total;
  into.failed += from.failed;
  into.runTime += from.runTime;
  into.timeSaved += from.timeSaved;
}

/** every whole hour in `[start, end)` */
function sumHours(wf: StoredWorkflow, start: number, end: number, firstHour: number): Facts {
  const sum = empty();
  for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
    if (h >= start) add(sum, hourFacts(wf, h, firstHour));
  }
  return sum;
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

interface Window {
  start: number;
  end: number;
  granularity: InsightsGranularity;
}

function windowOf(query: Record<string, string>, now: number): Window {
  const end = query.endDate ? Date.parse(query.endDate) : now;
  const start = query.startDate ? Date.parse(query.startDate) : end - 7 * DAY;
  if (Number.isNaN(end) || Number.isNaN(start)) {
    throw new HttpError(400, 'bad_request', 'startDate and endDate must be dates');
  }
  if (end < start) throw new HttpError(400, 'bad_request', 'endDate must be the same as or after startDate');
  const length = end - start;
  const granularity: InsightsGranularity = length <= DAY ? 'hour' : length <= 30 * DAY ? 'day' : 'week';
  return {
    start: length > DAY ? Math.floor(start / DAY) * DAY : Math.floor(start / HOUR) * HOUR,
    end: end + 1,
    granularity,
  };
}

/** the Monday 00:00 UTC that starts the week of `time` */
function weekStart(time: number): number {
  const day = Math.floor(time / DAY) * DAY;
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY;
}

function bucketStart(time: number, granularity: InsightsGranularity): number {
  if (granularity === 'hour') return Math.floor(time / HOUR) * HOUR;
  if (granularity === 'day') return Math.floor(time / DAY) * DAY;
  return weekStart(time);
}

function bucketStep(start: number, granularity: InsightsGranularity): number {
  return granularity === 'hour' ? start + HOUR : granularity === 'day' ? start + DAY : start + 7 * DAY;
}

function metric(value: number, unit: InsightsMetric['unit'], previous: number | null, places: number) {
  return { value, unit, deviation: previous === null ? null : round(value - previous, places) };
}

function summaryOf(facts: Facts): { rate: number; average: number } {
  return {
    rate: facts.total > 0 ? round(facts.failed / facts.total, 3) : 0,
    average: facts.total > 0 ? round(facts.runTime / facts.total, 2) : 0,
  };
}

export function registerInsightsRoutes(backend: MockBackend): void {
  const clock = () => Date.now();

  /** the workspace's workflows, narrowed to one project when asked (an unknown project is 404) */
  const scopeOf = (query: Record<string, string>) => {
    const { tenant } = backend.requireScope('insights:list');
    if (
      query.projectId &&
      !backend.projects.some((p) => p.tenantId === tenant.id && p.id === query.projectId)
    ) {
      throw new HttpError(404, 'not_found', 'Project not found');
    }
    return backend.workflows.filter(
      (w) => w.tenantId === tenant.id && (!query.projectId || w.projectId === query.projectId),
    );
  };

  const facts = (list: StoredWorkflow[], start: number, end: number, now: number): Facts => {
    const total = empty();
    const firstHour = Math.floor((now - HISTORY_DAYS * DAY) / DAY) * DAY;
    for (const wf of list) add(total, sumHours(wf, start, end, firstHour));
    return total;
  };

  backend.on('GET', '/insights/summary', ({ query }) => {
    const list = scopeOf(query);
    const now = clock();
    const { start, end } = windowOf(query, now);
    const current = facts(list, start, end, now);
    const before = facts(list, start - (end - start), start, now);
    const has = before.total > 0;
    const a = summaryOf(current);
    const b = summaryOf(before);
    const summary: InsightsSummary = {
      total: metric(current.total, 'count', has ? before.total : null, 0),
      failed: metric(current.failed, 'count', has ? before.failed : null, 0),
      failureRate: metric(a.rate, 'ratio', has ? b.rate : null, 3),
      timeSaved: metric(current.timeSaved, 'minute', has ? before.timeSaved : null, 0),
      averageRunTime: metric(a.average, 'millisecond', has ? b.average : null, 2),
    };
    return summary;
  });

  const byTime = (query: Record<string, string>, timeSavedOnly: boolean): InsightsByTimeRow[] => {
    const list = scopeOf(query);
    const now = clock();
    const { start, end, granularity } = windowOf(query, now);
    const rows: InsightsByTimeRow[] = [];
    for (let from = bucketStart(start, granularity); from < end; from = bucketStep(from, granularity)) {
      const to = bucketStep(from, granularity);
      const f = facts(list, Math.max(from, start), Math.min(to, end), now);
      const { rate, average } = summaryOf(f);
      rows.push({
        date: new Date(from).toISOString(),
        values: timeSavedOnly
          ? { timeSaved: f.timeSaved }
          : {
              total: f.total,
              succeeded: f.total - f.failed,
              failed: f.failed,
              failureRate: rate,
              averageRunTime: average,
              timeSaved: f.timeSaved,
            },
      });
    }
    return rows;
  };
  backend.on('GET', '/insights/by-time', ({ query }) => byTime(query, false));
  backend.on('GET', '/insights/by-time/time-saved', ({ query }) => byTime(query, true));

  backend.on('GET', '/insights/by-workflow', ({ query }) => {
    const list = scopeOf(query);
    const now = clock();
    const { start, end } = windowOf(query, now);
    const [field = 'total', direction = 'desc'] = (query.sortBy ?? 'total:desc').split(':');
    const rows: InsightsByWorkflowRow[] = [];
    for (const wf of list) {
      const f = facts([wf], start, end, now);
      if (f.total === 0) continue;
      const project = backend.projects.find((p) => p.id === wf.projectId);
      rows.push({
        workflowId: wf.id,
        workflowName: wf.name,
        hasReadAccess: true,
        projectId: wf.projectId ?? null,
        projectName: project?.name ?? null,
        total: f.total,
        succeeded: f.total - f.failed,
        failed: f.failed,
        failureRate: summaryOf(f).rate,
        runTime: f.runTime,
        averageRunTime: summaryOf(f).average,
        timeSaved: f.timeSaved,
      });
    }
    const key = field as keyof InsightsByWorkflowRow;
    const sign = direction === 'asc' ? 1 : -1;
    rows.sort((x, y) => {
      const a = x[key];
      const b = y[key];
      const order =
        typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a ?? 0) - Number(b ?? 0);
      return sign * order || x.workflowName.localeCompare(y.workflowName);
    });
    const skip = Math.max(Number(query.skip) || 0, 0);
    const take = Math.min(Math.max(Number(query.take) || 10, 1), 100);
    return { count: rows.length, data: rows.slice(skip, skip + take) };
  });

  backend.on('GET', '/insights/settings', () => {
    backend.requireScope('insights:list');
    const first = Math.floor((clock() - HISTORY_DAYS * DAY) / DAY) * DAY;
    const settings: InsightsSettings = {
      summary: true,
      dashboard: true,
      dateRanges: DATE_RANGES.map((r) => ({ ...r })),
      earliestDataDate: new Date(first).toISOString(),
    };
    return settings;
  });
}
