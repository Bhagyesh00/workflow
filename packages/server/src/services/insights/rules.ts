/**
 * P6-05 (L11): what one finished run adds to the insights.
 * - `insightRunOf` (FULL in C0): the run as the collector keeps it, built in `finish` and `afterCrash`
 *   (C0d1) with no read: tenant, workflow, mode, status, start, runtime clamped to 0..2^31-1, settings and a
 *   reference to the run data (not a copy). No project: the flush reads it with the metadata upsert.
 * - `countingFacts` (stub, L11): n8n's counting rules (counting-rules.ts:70-145): modes cli, retry,
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

/** the largest runtime stored (a Postgres int) */
export const MAX_INSIGHT_RUNTIME_MS = 2_147_483_647;

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
): InsightRun {
  return {
    tenantId: row.tenantId,
    workflowId: row.workflowId ?? null,
    workflowName: row.workflowName || definition.name || '',
    mode: row.mode as ExecutionMode,
    status: outcome.status,
    startedAt: row.startedAt ?? row.createdAt,
    runtimeMs: clampRuntime(durationMs),
    settings: definition.settings ?? {},
    runData: outcome.runData ?? null,
  };
}

export function countingFacts(_run: InsightRun): InsightFacts {
  // stub (L11)
  throw new Error('not implemented (L11)');
}
