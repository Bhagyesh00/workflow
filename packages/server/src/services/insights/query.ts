/**
 * P6-05 (L11): the insights reads behind GET /insights/* and public GET /insights/summary. Summary with
 * `deviation` against the period of the same length before (null when it had no runs); by workflow with
 * paging (take at most 100) and the sort keys, `hasReadAccess` from the caller's list filter, deleted
 * workflows keep their name; by time with hour, day or week by range; the time zone through `AT TIME ZONE`
 * (a bad zone 400); "endDate must be the same as or after startDate". An unknown project id 404.
 * Every query filters tenant_id with a bound value and reads only the insights tables, the workflow's name
 * and project, and the project's name.
 */
import { sql } from 'drizzle-orm';
import type { ServiceDeps } from '../../context';
import { ApiError } from '../../http/errors';
import type { AccessFilter } from '../access';

export type InsightsSummaryType = 'total' | 'failed' | 'failureRate' | 'timeSaved' | 'averageRunTime';

export interface InsightsMetric {
  value: number;
  unit: 'count' | 'ratio' | 'minute' | 'millisecond';
  /** current minus the previous period of the same length; null when that period had no runs */
  deviation: number | null;
}

export type InsightsSummary = Record<InsightsSummaryType, InsightsMetric>;

/** no `startDate` = the last 7 days, no `endDate` = now */
export interface InsightsRange {
  startDate?: Date;
  endDate?: Date;
  projectId?: string;
  /** IANA zone for the bucket and day boundaries */
  timeZone?: string;
}

export type InsightsByWorkflowSortField =
  | 'total'
  | 'succeeded'
  | 'failed'
  | 'failureRate'
  | 'timeSaved'
  | 'runTime'
  | 'averageRunTime'
  | 'workflowName';

export interface InsightsByWorkflowQuery extends InsightsRange {
  skip?: number;
  /** 1..100, default 10 */
  take?: number;
  sortBy?: `${InsightsByWorkflowSortField}:${'asc' | 'desc'}`;
}

export interface InsightsByWorkflowRow {
  workflowId: string | null;
  workflowName: string;
  hasReadAccess: boolean;
  projectId: string | null;
  projectName: string | null;
  total: number;
  succeeded: number;
  failed: number;
  failureRate: number;
  runTime: number;
  averageRunTime: number;
  timeSaved: number;
}

export interface InsightsByWorkflowPage {
  count: number;
  data: InsightsByWorkflowRow[];
}

export interface InsightsByTimeRow {
  /** ISO start of the bucket */
  date: string;
  values: Partial<Record<InsightsSummaryType | 'succeeded', number>>;
}

export type InsightsDateRangeKey = 'day' | 'week' | '2weeks' | 'month' | 'quarter' | '6months' | 'year';
export type InsightsGranularity = 'hour' | 'day' | 'week';

export interface InsightsSettings {
  summary: boolean;
  dashboard: boolean;
  dateRanges: Array<{ key: InsightsDateRangeKey; licensed: boolean; granularity: InsightsGranularity }>;
  /** the first day with data, null when there is none */
  earliestDataDate: string | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** the ranges the editor offers; none is licensed away */
const DATE_RANGES: InsightsSettings['dateRanges'] = [
  { key: 'day', licensed: true, granularity: 'hour' },
  { key: 'week', licensed: true, granularity: 'day' },
  { key: '2weeks', licensed: true, granularity: 'day' },
  { key: 'month', licensed: true, granularity: 'day' },
  { key: 'quarter', licensed: true, granularity: 'week' },
  { key: '6months', licensed: true, granularity: 'week' },
  { key: 'year', licensed: true, granularity: 'week' },
];

/** the sort keys of the by-workflow table and the column each one orders by (`shaped` below) */
const SORT_COLUMNS: Record<InsightsByWorkflowSortField, string> = {
  total: 'total',
  succeeded: 'succeeded',
  failed: 'failed',
  failureRate: 'failure_rate',
  timeSaved: 'saved',
  runTime: 'runtime',
  averageRunTime: 'average_runtime',
  workflowName: 'workflow_name',
};

/** a range after defaults and checks: the bounds the rows are read in, `[start, end)` */
export interface ResolvedInsightsRange {
  /** the first instant read */
  start: Date;
  /** the first instant not read */
  end: Date;
  timeZone: string;
  granularity: InsightsGranularity;
  projectId?: string;
}

function validTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone) || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** how far the zone is ahead of UTC at `at`, in ms */
function zoneOffsetMs(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** midnight of the day `at` falls in, in the zone */
function startOfZonedDay(at: Date, zone: string): Date {
  const local = new Date(at.getTime() + zoneOffsetMs(at, zone));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const first = midnight - zoneOffsetMs(new Date(midnight), zone);
  return new Date(midnight - zoneOffsetMs(new Date(first), zone));
}

/**
 * Defaults and checks (400 on a bad zone or an end before the start). No start is the last 7 days, no end is
 * now. A range of more than a day reads whole days of the zone from the start day on; a past end date reads
 * to the end of its day, an end of today reads up to now; a shorter range reads whole hours. The granularity
 * follows the range as asked: up to a day hours, up to 30 days days, above that weeks.
 */
export function resolveInsightsRange(range: InsightsRange, now: Date = new Date()): ResolvedInsightsRange {
  const timeZone = range.timeZone ?? 'UTC';
  if (!validTimeZone(timeZone)) throw ApiError.badRequest('timeZone must be a valid time zone');
  const endDate = range.endDate ?? now;
  const startDate = range.startDate ?? new Date(endDate.getTime() - 7 * DAY_MS);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw ApiError.badRequest('startDate and endDate must be dates');
  }
  if (endDate.getTime() < startDate.getTime()) {
    throw ApiError.badRequest('endDate must be the same as or after startDate');
  }
  const length = endDate.getTime() - startDate.getTime();
  const granularity: InsightsGranularity = length <= DAY_MS ? 'hour' : length <= 30 * DAY_MS ? 'day' : 'week';
  const start =
    length > DAY_MS
      ? startOfZonedDay(startDate, timeZone)
      : new Date(Math.floor(startDate.getTime() / HOUR_MS) * HOUR_MS);
  let end =
    endDate.getTime() < startOfZonedDay(now, timeZone).getTime()
      ? new Date(startOfZonedDay(endDate, timeZone).getTime() + DAY_MS)
      : new Date(endDate.getTime() + 1);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + MINUTE_MS);
  return { start, end, timeZone, granularity, projectId: range.projectId };
}

/** an unknown project id, and one of another workspace, is 404 */
async function checkProject(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | undefined,
): Promise<void> {
  if (projectId === undefined) return;
  if (!UUID.test(projectId) || !(await deps.repos.projects.get(tenantId, projectId))) {
    throw ApiError.notFound('Project');
  }
}

/** the rows of the range, joined to their workflow and project (live where the workflow still exists) */
function scoped(tenantId: string, projectId: string | undefined, bounds: { start: Date; end: Date }) {
  const project = projectId ? sql`and coalesce(w.project_id, m.project_id) = ${projectId}` : sql``;
  return sql`
    from insights_by_period p
    join insights_metadata m on m.tenant_id = p.tenant_id and m.id = p.meta_id
    left join workflows w on w.tenant_id = m.tenant_id and w.id = m.workflow_id
    left join projects pr on pr.tenant_id = m.tenant_id and pr.id = coalesce(w.project_id, m.project_id)
    where p.tenant_id = ${tenantId}
      and p.period_start >= ${bounds.start.toISOString()}::timestamptz
      and p.period_start < ${bounds.end.toISOString()}::timestamptz
      ${project}`;
}

interface Totals {
  success: number;
  failure: number;
  runtime: number;
  saved: number;
}

const emptyTotals = (): Totals => ({ success: 0, failure: 0, runtime: 0, saved: 0 });

function addTo(totals: Totals, type: number, value: number): void {
  if (type === 0) totals.saved += value;
  else if (type === 1) totals.runtime += value;
  else if (type === 2) totals.success += value;
  else if (type === 3) totals.failure += value;
}

async function totalsOf(
  deps: ServiceDeps,
  tenantId: string,
  projectId: string | undefined,
  bounds: { start: Date; end: Date },
): Promise<Totals> {
  const result = await deps.database.db.execute<{ type: number; value: number }>(sql`
    select p.type, sum(p.value)::double precision as value ${scoped(tenantId, projectId, bounds)} group by p.type`);
  const totals = emptyTotals();
  for (const row of result.rows) addTo(totals, row.type, Number(row.value) || 0);
  return totals;
}

const round = (value: number, places: number) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

function metricsOf(t: Totals): Record<InsightsSummaryType, number> {
  const total = t.success + t.failure;
  return {
    total,
    failed: t.failure,
    failureRate: total > 0 ? round(t.failure / total, 3) : 0,
    timeSaved: t.saved,
    averageRunTime: total > 0 ? round(t.runtime / total, 2) : 0,
  };
}

const UNITS: Record<InsightsSummaryType, InsightsMetric['unit']> = {
  total: 'count',
  failed: 'count',
  failureRate: 'ratio',
  timeSaved: 'minute',
  averageRunTime: 'millisecond',
};

export async function insightsSummary(
  deps: ServiceDeps,
  tenantId: string,
  range: InsightsRange,
): Promise<InsightsSummary> {
  const r = resolveInsightsRange(range);
  await checkProject(deps, tenantId, r.projectId);
  const length = r.end.getTime() - r.start.getTime();
  const before = { start: new Date(r.start.getTime() - length), end: r.start };
  const [now, prior] = await Promise.all([
    totalsOf(deps, tenantId, r.projectId, r),
    totalsOf(deps, tenantId, r.projectId, before),
  ]);
  const current = metricsOf(now);
  const previous = metricsOf(prior);
  const priorRuns = prior.success + prior.failure;
  const out = {} as InsightsSummary;
  for (const type of Object.keys(UNITS) as InsightsSummaryType[]) {
    const places = type === 'failureRate' ? 3 : type === 'averageRunTime' ? 2 : 0;
    out[type] = {
      value: current[type],
      unit: UNITS[type],
      deviation: priorRuns > 0 ? round(current[type] - previous[type], places) : null,
    };
  }
  return out;
}

export async function insightsByWorkflow(
  deps: ServiceDeps,
  tenantId: string,
  query: InsightsByWorkflowQuery,
  /** the caller's `workflow:read` filter (`hasReadAccess`) */
  readFilter: AccessFilter,
): Promise<InsightsByWorkflowPage> {
  const r = resolveInsightsRange(query);
  await checkProject(deps, tenantId, r.projectId);
  const take = Math.min(100, Math.max(1, Math.trunc(query.take ?? 10) || 10));
  const skip = Math.max(0, Math.trunc(query.skip ?? 0) || 0);
  const [field, direction] = (query.sortBy ?? 'total:desc').split(':') as [
    InsightsByWorkflowSortField,
    'asc' | 'desc',
  ];
  const column = SORT_COLUMNS[field];
  if (!column || (direction !== 'asc' && direction !== 'desc'))
    throw ApiError.badRequest('sortBy is not valid');
  // `column` and `direction` come from the lists above, never from the request text
  const order = sql.raw(`${column} ${direction}`);

  const shaped = sql`
    with agg as (
      select m.id as meta_id, m.workflow_id,
        coalesce(w.name, m.workflow_name) as workflow_name,
        coalesce(w.project_id, m.project_id) as project_id,
        coalesce(pr.name, m.project_name) as project_name,
        coalesce(sum(p.value) filter (where p.type = 2), 0)::double precision as succeeded,
        coalesce(sum(p.value) filter (where p.type = 3), 0)::double precision as failed,
        coalesce(sum(p.value) filter (where p.type = 1), 0)::double precision as runtime,
        coalesce(sum(p.value) filter (where p.type = 0), 0)::double precision as saved
      ${scoped(tenantId, r.projectId, r)}
      group by m.id, m.workflow_id, w.name, m.workflow_name, w.project_id, m.project_id, pr.name, m.project_name
    ),
    shaped as (
      select *, succeeded + failed as total,
        case when succeeded + failed > 0 then failed / (succeeded + failed) else 0 end as failure_rate,
        case when succeeded + failed > 0 then runtime / (succeeded + failed) else 0 end as average_runtime
      from agg
    )`;

  const rows = await deps.database.db.execute<{
    workflow_id: string | null;
    workflow_name: string;
    project_id: string | null;
    project_name: string | null;
    succeeded: number;
    failed: number;
    runtime: number;
    saved: number;
  }>(
    sql`${shaped} select * from shaped order by ${order}, workflow_name asc, meta_id asc limit ${take} offset ${skip}`,
  );
  const counted = await deps.database.db.execute<{ count: string }>(
    sql`${shaped} select count(*) as count from shaped`,
  );

  const readable = (workflowId: string | null, projectId: string | null) => {
    // a deleted workflow keeps its numbers and its name, nobody reads it
    if (!workflowId) return false;
    if (readFilter.all) return true;
    return (
      readFilter.workflowIds.includes(workflowId) ||
      (!!projectId && readFilter.projectIds.includes(projectId))
    );
  };
  return {
    count: Number(counted.rows[0]?.count ?? 0),
    data: rows.rows.map((row) => {
      const succeeded = Number(row.succeeded);
      const failed = Number(row.failed);
      const total = succeeded + failed;
      const runTime = Number(row.runtime);
      return {
        workflowId: row.workflow_id,
        workflowName: row.workflow_name,
        hasReadAccess: readable(row.workflow_id, row.project_id),
        projectId: row.project_id,
        projectName: row.project_name,
        total,
        succeeded,
        failed,
        failureRate: total > 0 ? round(failed / total, 3) : 0,
        runTime,
        averageRunTime: total > 0 ? round(runTime / total, 2) : 0,
        timeSaved: Number(row.saved),
      };
    }),
  };
}

export async function insightsByTime(
  deps: ServiceDeps,
  tenantId: string,
  range: InsightsRange,
  /** `timeSaved` only for `/by-time/time-saved` */
  only?: 'timeSaved',
): Promise<InsightsByTimeRow[]> {
  const r = resolveInsightsRange(range);
  await checkProject(deps, tenantId, r.projectId);
  // the granularity is one of three fixed words
  const unit = sql.raw(`'${r.granularity}'`);
  const result = await deps.database.db.execute<{ bucket: Date | string; type: number; value: number }>(sql`
    select (date_trunc(${unit}, p.period_start at time zone ${r.timeZone}) at time zone ${r.timeZone}) as bucket,
      p.type, sum(p.value)::double precision as value
    ${scoped(tenantId, r.projectId, r)}
    group by 1, p.type
    order by 1`);
  const buckets = new Map<number, Totals>();
  for (const row of result.rows) {
    const key = new Date(row.bucket).getTime();
    const totals = buckets.get(key) ?? emptyTotals();
    addTo(totals, row.type, Number(row.value) || 0);
    buckets.set(key, totals);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, t]) => {
      const m = metricsOf(t);
      return {
        date: new Date(time).toISOString(),
        values: only
          ? { timeSaved: m.timeSaved }
          : {
              total: m.total,
              succeeded: t.success,
              failed: m.failed,
              failureRate: m.failureRate,
              averageRunTime: m.averageRunTime,
              timeSaved: m.timeSaved,
            },
      };
    });
}

export async function insightsSettings(deps: ServiceDeps, tenantId: string): Promise<InsightsSettings> {
  const earliest = await deps.repos.insights.earliestPeriod(tenantId);
  return {
    summary: true,
    dashboard: true,
    dateRanges: DATE_RANGES.map((r) => ({ ...r })),
    earliestDataDate: earliest ? earliest.toISOString() : null,
  };
}
