/**
 * P6-05 (L11): what one finished run adds to the insights.
 * - `insightRunOf` (FULL in C0): the run as the collector keeps it, built in `finish` and `afterCrash`
 *   (C0d1) with no read: tenant, workflow, mode, status, start, runtime clamped to 0..2^31-1, settings and a
 *   reference to the run data (not a copy). No project: the flush reads it with the metadata upsert.
 * - `countingFacts` (L11): n8n's counting rules (counting-rules.ts:70-145): modes cli, retry,
 *   trigger, webhook, evaluation, error count; success counts as success; error, crashed and blocked as
 *   failure; canceled and waiting nothing; a run with no workflow id nothing; time saved through
 *   `computeTimeSavedMinutes`.
 */
import type {
  ExecutionMode,
  ExecutionStatus,
  RunData,
  WorkflowDefinition,
  WorkflowSettings,
} from '@workflow/workflow';
import type { ExecutionRow } from '../../db/schema';
import { computeTimeSavedMinutes } from './time-saved';

/** the largest runtime stored (a Postgres int); also the most one run adds as time saved */
export const MAX_INSIGHT_RUNTIME_MS = 2_147_483_647;

/** the most one buffered bucket holds: a sum past this loses digits in a double, and past 2^63 the bigint column refuses it */
export const MAX_INSIGHT_BUCKET_VALUE = Number.MAX_SAFE_INTEGER;

/** the stored event types (`insights_by_period.type`) */
export const INSIGHT_TYPES = { time_saved_min: 0, runtime_ms: 1, success: 2, failure: 3 } as const;
export type InsightType = keyof typeof INSIGHT_TYPES;

/** the stored period units (`insights_by_period.period_unit`) */
export const INSIGHT_PERIOD_UNITS = { hour: 0, day: 1, week: 2 } as const;
export type InsightPeriodUnit = keyof typeof INSIGHT_PERIOD_UNITS;

export interface InsightRun {
  tenantId: string;
  /** null: an inline sub-run or a run whose workflow is gone (counts nothing) */
  workflowId: string | null;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: Date;
  /** when the run ended (n8n stamps an insight when it is recorded); the bucket hour. Absent: `startedAt`. */
  endedAt?: Date;
  /** 0..MAX_INSIGHT_RUNTIME_MS */
  runtimeMs: number;
  settings: WorkflowSettings;
  /** a reference, never a copy; null when the run kept none (a crash) */
  runData: RunData | null;
}

/** one fact a run adds (value 1 for success and failure) */
export interface InsightFact {
  type: InsightType;
  value: number;
}

/** what a run adds; empty when it does not count */
export type InsightFacts = InsightFact[];

const clampRuntime = (ms: number) =>
  Number.isFinite(ms) ? Math.min(MAX_INSIGHT_RUNTIME_MS, Math.max(0, Math.round(ms))) : 0;

export function insightRunOf(
  row: ExecutionRow,
  definition: Pick<WorkflowDefinition, 'name' | 'settings'>,
  outcome: { status: ExecutionStatus; runData?: RunData | null },
  durationMs: number,
  endedAt: Date = new Date(),
): InsightRun {
  return {
    tenantId: row.tenantId,
    workflowId: row.workflowId ?? null,
    workflowName: row.workflowName || definition.name || '',
    mode: row.mode as ExecutionMode,
    status: outcome.status,
    startedAt: row.startedAt ?? row.createdAt,
    endedAt,
    runtimeMs: clampRuntime(durationMs),
    settings: definition.settings ?? {},
    runData: outcome.runData ?? null,
  };
}

/** the modes that count (n8n's counting rules): production runs, error workflows included */
const COUNTED_MODES: ReadonlySet<ExecutionMode> = new Set([
  'cli',
  'retry',
  'trigger',
  'webhook',
  'evaluation',
  'error',
]);

/**
 * What one finished run adds. A run with no workflow id, a mode that does not count (manual, chat, internal,
 * integrated) or a status that is neither a success nor a failure (canceled, waiting) adds nothing. Success is
 * a success; error, crashed and blocked (a run that failed before its first node) are failures. A counted run
 * also adds its runtime, and the minutes it saved when that is above zero (zero adds nothing to a sum).
 */
export function countingFacts(run: InsightRun): InsightFacts {
  if (!run.workflowId || !COUNTED_MODES.has(run.mode)) return [];
  const status: string = run.status;
  let outcome: 'success' | 'failure';
  if (status === 'success') outcome = 'success';
  else if (status === 'error' || status === 'crashed' || status === 'blocked') outcome = 'failure';
  else return [];
  const facts: InsightFacts = [
    { type: outcome, value: 1 },
    { type: 'runtime_ms', value: clampRuntime(run.runtimeMs) },
  ];
  const saved = computeTimeSavedMinutes(run.settings, run.runData, run.status, run.mode);
  if (saved !== undefined && saved > 0) {
    // one run adds at most a runtime's worth: an expression or a setting cannot poison the shared flush
    facts.push({ type: 'time_saved_min', value: Math.min(MAX_INSIGHT_RUNTIME_MS, Math.round(saved)) });
  }
  return facts;
}
