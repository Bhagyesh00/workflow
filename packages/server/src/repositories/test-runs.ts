/**
 * Evaluation test runs and their cases (P5-02). Every method takes the tenant first, except
 * `listStale`, the cross-tenant read of the start-up and queue-mode sweep (like `markCrashed`).
 * Ids from URLs are checked with `isUuid` before they reach a query.
 */
import type { TestCaseCounts, TestCaseStatus, TestRunStatus } from '@workflow/workflow';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type TestCaseExecutionRow, type TestRunRow, testCaseExecutions, testRuns } from '../db/schema';
import { isUuid, now } from './util';

/** a new run: `status` 'new' and `concurrency` 1 unless given; `id` is generated unless given */
export type TestRunInsert = Pick<TestRunRow, 'workflowId'> &
  Partial<Pick<TestRunRow, 'id' | 'status' | 'concurrency' | 'workflowVersionId' | 'runningInstanceId'>>;

export type TestRunPatch = Partial<
  Pick<
    TestRunRow,
    | 'status'
    | 'runAt'
    | 'completedAt'
    | 'metrics'
    | 'errorCode'
    | 'errorDetails'
    | 'runningInstanceId'
    | 'workflowVersionId'
    | 'concurrency'
  >
>;

export type TestCasePatch = Partial<
  Pick<
    TestCaseExecutionRow,
    | 'executionId'
    | 'status'
    | 'runAt'
    | 'completedAt'
    | 'errorCode'
    | 'errorDetails'
    | 'metrics'
    | 'inputs'
    | 'outputs'
  >
>;

export interface TestRunListOptions {
  skip?: number;
  limit?: number;
  status?: TestRunStatus;
}

export interface TestCaseListOptions {
  skip?: number;
  limit?: number;
}

const ACTIVE_RUN: readonly TestRunStatus[] = ['new', 'running'];
const CASE_STATUSES: readonly TestCaseStatus[] = ['new', 'running', 'success', 'error', 'cancelled'];
/** inserts per statement when seeding cases (1000 rows at most) */
const SEED_CHUNK = 500;

export class TestRunRepository {
  constructor(readonly db: DbOrTx) {}

  async create(tenantId: string, run: TestRunInsert): Promise<TestRunRow> {
    const [row] = await this.db
      .insert(testRuns)
      .values({
        ...(run.id ? { id: run.id } : {}),
        tenantId,
        workflowId: run.workflowId,
        status: run.status ?? 'new',
        concurrency: run.concurrency ?? 1,
        workflowVersionId: run.workflowVersionId ?? null,
        runningInstanceId: run.runningInstanceId ?? null,
      })
      .returning();
    return row;
  }

  /** the run of this workflow, or undefined (another tenant or another workflow reads as missing) */
  async get(tenantId: string, workflowId: string, id: string): Promise<TestRunRow | undefined> {
    if (!isUuid(workflowId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(testRuns)
      .where(and(eq(testRuns.tenantId, tenantId), eq(testRuns.workflowId, workflowId), eq(testRuns.id, id)));
    return row;
  }

  /** newest first (`created_at desc`); `count` is the total for the filter, for cursors */
  async list(
    tenantId: string,
    workflowId: string,
    options: TestRunListOptions,
  ): Promise<{ count: number; rows: TestRunRow[] }> {
    if (!isUuid(workflowId)) return { count: 0, rows: [] };
    const conditions = [eq(testRuns.tenantId, tenantId), eq(testRuns.workflowId, workflowId)];
    if (options.status) conditions.push(eq(testRuns.status, options.status));
    const where = and(...conditions);
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(testRuns)
      .where(where);
    const rows = await this.db
      .select()
      .from(testRuns)
      .where(where)
      .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
      .limit(options.limit ?? 50)
      .offset(options.skip ?? 0);
    return { count, rows };
  }

  /**
   * Moves `updated_at` (the heartbeat). With `onlyIf`, writes only while the run's status is one of
   * those (a guarded transition); undefined when nothing was written.
   */
  async update(
    tenantId: string,
    id: string,
    patch: TestRunPatch,
    onlyIf?: { status: readonly TestRunStatus[] },
  ): Promise<TestRunRow | undefined> {
    if (!isUuid(id)) return undefined;
    const conditions = [eq(testRuns.tenantId, tenantId), eq(testRuns.id, id)];
    if (onlyIf) conditions.push(inArray(testRuns.status, [...onlyIf.status]));
    const [row] = await this.db
      .update(testRuns)
      .set({ ...patch, updatedAt: now() })
      .where(and(...conditions))
      .returning();
    return row;
  }

  /** cases go with it (FK cascade); false when there was no such run */
  async delete(tenantId: string, workflowId: string, id: string): Promise<boolean> {
    if (!isUuid(workflowId) || !isUuid(id)) return false;
    const rows = await this.db
      .delete(testRuns)
      .where(and(eq(testRuns.tenantId, tenantId), eq(testRuns.workflowId, workflowId), eq(testRuns.id, id)))
      .returning({ id: testRuns.id });
    return rows.length > 0;
  }

  /** sets `cancel_requested` on a run that is still 'new' or 'running'; undefined otherwise */
  async requestCancel(tenantId: string, id: string): Promise<TestRunRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(testRuns)
      .set({ cancelRequested: true, updatedAt: now() })
      .where(
        and(eq(testRuns.tenantId, tenantId), eq(testRuns.id, id), inArray(testRuns.status, [...ACTIVE_RUN])),
      )
      .returning();
    return row;
  }

  /** one 'new' case per dataset row, `run_index` 0..count-1, ordered by `run_index` */
  async seedCases(tenantId: string, runId: string, count: number): Promise<TestCaseExecutionRow[]> {
    return this.seedCasesAt(
      tenantId,
      runId,
      Array.from({ length: Math.max(0, count) }, (_, i) => i),
    );
  }

  /** one 'new' case per given dataset index (a run of chosen rows), ordered by `run_index` */
  async seedCasesAt(
    tenantId: string,
    runId: string,
    runIndices: readonly number[],
  ): Promise<TestCaseExecutionRow[]> {
    if (!isUuid(runId) || !runIndices.length) return [];
    const rows: TestCaseExecutionRow[] = [];
    for (let start = 0; start < runIndices.length; start += SEED_CHUNK) {
      const chunk = runIndices.slice(start, start + SEED_CHUNK);
      rows.push(
        ...(await this.db
          .insert(testCaseExecutions)
          .values(chunk.map((runIndex) => ({ tenantId, testRunId: runId, runIndex, status: 'new' as const })))
          .returning()),
      );
    }
    return rows.sort((a, b) => a.runIndex - b.runIndex);
  }

  /** ordered by `run_index`; `count` is the run's total */
  async listCases(
    tenantId: string,
    runId: string,
    options: TestCaseListOptions,
  ): Promise<{ count: number; rows: TestCaseExecutionRow[] }> {
    if (!isUuid(runId)) return { count: 0, rows: [] };
    const where = and(eq(testCaseExecutions.tenantId, tenantId), eq(testCaseExecutions.testRunId, runId));
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(testCaseExecutions)
      .where(where);
    const rows = await this.db
      .select()
      .from(testCaseExecutions)
      .where(where)
      .orderBy(asc(testCaseExecutions.runIndex), asc(testCaseExecutions.id))
      .limit(options.limit ?? 100)
      .offset(options.skip ?? 0);
    return { count, rows };
  }

  async getCase(tenantId: string, runId: string, caseId: string): Promise<TestCaseExecutionRow | undefined> {
    if (!isUuid(runId) || !isUuid(caseId)) return undefined;
    const [row] = await this.db
      .select()
      .from(testCaseExecutions)
      .where(
        and(
          eq(testCaseExecutions.tenantId, tenantId),
          eq(testCaseExecutions.testRunId, runId),
          eq(testCaseExecutions.id, caseId),
        ),
      );
    return row;
  }

  /**
   * With `onlyIf`, writes only while the case's status is one of those (case cancel: only 'new');
   * undefined when nothing was written.
   */
  async updateCase(
    tenantId: string,
    caseId: string,
    patch: TestCasePatch,
    onlyIf?: { status: readonly TestCaseStatus[] },
  ): Promise<TestCaseExecutionRow | undefined> {
    if (!isUuid(caseId)) return undefined;
    const conditions = [eq(testCaseExecutions.tenantId, tenantId), eq(testCaseExecutions.id, caseId)];
    if (onlyIf) conditions.push(inArray(testCaseExecutions.status, [...onlyIf.status]));
    const [row] = await this.db
      .update(testCaseExecutions)
      .set(patch)
      .where(and(...conditions))
      .returning();
    return row;
  }

  /** 'new' cases become 'cancelled' (run cancel); returns how many */
  async cancelPendingCases(tenantId: string, runId: string): Promise<number> {
    return this.cancelCases(tenantId, runId, ['new']);
  }

  /** 'new' and 'running' cases become 'cancelled' (the sweep); returns how many */
  async cancelUnfinishedCases(tenantId: string, runId: string): Promise<number> {
    return this.cancelCases(tenantId, runId, ['new', 'running']);
  }

  private async cancelCases(
    tenantId: string,
    runId: string,
    from: readonly TestCaseStatus[],
  ): Promise<number> {
    if (!isUuid(runId)) return 0;
    const rows = await this.db
      .update(testCaseExecutions)
      .set({ status: 'cancelled', completedAt: now() })
      .where(
        and(
          eq(testCaseExecutions.tenantId, tenantId),
          eq(testCaseExecutions.testRunId, runId),
          inArray(testCaseExecutions.status, [...from]),
        ),
      )
      .returning({ id: testCaseExecutions.id });
    return rows.length;
  }

  /** every status present with 0 for none, plus `total` */
  async caseCounts(tenantId: string, runId: string): Promise<TestCaseCounts> {
    const counts = Object.fromEntries(CASE_STATUSES.map((s) => [s, 0])) as TestCaseCounts;
    counts.total = 0;
    if (!isUuid(runId)) return counts;
    const rows = await this.db
      .select({ status: testCaseExecutions.status, n: sql<number>`count(*)::int` })
      .from(testCaseExecutions)
      .where(and(eq(testCaseExecutions.tenantId, tenantId), eq(testCaseExecutions.testRunId, runId)))
      .groupBy(testCaseExecutions.status);
    for (const { status, n } of rows) {
      if (status in counts) counts[status] = n;
      counts.total += n;
    }
    return counts;
  }

  /** the heartbeat: `updated_at = now()` only */
  async touch(tenantId: string, id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.db
      .update(testRuns)
      .set({ updatedAt: now() })
      .where(and(eq(testRuns.tenantId, tenantId), eq(testRuns.id, id)));
  }

  /**
   * System-level, cross-tenant (the sweep): runs still 'new' or 'running'. `null`: all of them
   * (regular mode at start); a Date: only those with `updated_at` older than it (queue mode).
   */
  async listStale(olderThan: Date | null): Promise<TestRunRow[]> {
    const active = inArray(testRuns.status, [...ACTIVE_RUN]);
    return this.db
      .select()
      .from(testRuns)
      .where(olderThan ? and(active, lt(testRuns.updatedAt, olderThan)) : active);
  }
}
