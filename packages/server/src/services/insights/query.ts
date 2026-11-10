/**
 * P6-05 (L11): the insights reads behind GET /insights/* and public GET /insights/summary. Summary with
 * `deviation` against the period of the same length before (null when it had no runs); by workflow with
 * paging (take at most 100) and the sort keys, `hasReadAccess` from the caller's list filter, deleted
 * workflows keep their name; by time with hour, day or week by range; the time zone through `AT TIME ZONE`
 * (a bad zone 400); "endDate must be the same as or after startDate". An unknown project id 404.
 * Stub from C0; L11 fills it.
 */
import type { ServiceDeps } from '../../context';
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

export async function insightsSummary(
  _deps: ServiceDeps,
  _tenantId: string,
  _range: InsightsRange,
): Promise<InsightsSummary> {
  // stub (L11)
  throw new Error('not implemented (L11)');
}

export async function insightsByWorkflow(
  _deps: ServiceDeps,
  _tenantId: string,
  _query: InsightsByWorkflowQuery,
  /** the caller's `workflow:read` filter (`hasReadAccess`) */
  _readFilter: AccessFilter,
): Promise<InsightsByWorkflowPage> {
  // stub (L11)
  throw new Error('not implemented (L11)');
}

export async function insightsByTime(
  _deps: ServiceDeps,
  _tenantId: string,
  _range: InsightsRange,
  /** `timeSaved` only for `/by-time/time-saved` */
  _only?: 'timeSaved',
): Promise<InsightsByTimeRow[]> {
  // stub (L11)
  throw new Error('not implemented (L11)');
}

export async function insightsSettings(_deps: ServiceDeps, _tenantId: string): Promise<InsightsSettings> {
  // stub (L11)
  throw new Error('not implemented (L11)');
}
