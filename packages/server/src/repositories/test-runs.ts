/**
 * Evaluation test runs and their cases (P5-02). Every method takes the tenant first, except
 * `listStale`, the cross-tenant read of the start-up and queue-mode sweep (like `markCrashed`).
 * Ids from URLs are checked with `isUuid` before they reach a query.
 *
 * C0 STUB: lane L8 writes the bodies (final signatures; L8 may add private helpers).
 */
import type { TestCaseCounts, TestCaseStatus, TestRunStatus } from '@workflow/workflow';
import type { DbOrTx } from '../db/client';
import type { TestCaseExecutionRow, TestRunRow } from '../db/schema';

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

export class TestRunRepository {
  constructor(readonly db: DbOrTx) {}

  async create(_tenantId: string, _run: TestRunInsert): Promise<TestRunRow> {
    throw new Error('not implemented (L8)');
  }

  /** the run of this workflow, or undefined (another tenant or another workflow reads as missing) */
  async get(_tenantId: string, _workflowId: string, _id: string): Promise<TestRunRow | undefined> {
    throw new Error('not implemented (L8)');
  }

  /** newest first (`created_at desc`); `count` is the total for the filter, for cursors */
  async list(
    _tenantId: string,
    _workflowId: string,
    _options: TestRunListOptions,
  ): Promise<{ count: number; rows: TestRunRow[] }> {
    throw new Error('not implemented (L8)');
  }

  /**
   * Moves `updated_at` (the heartbeat). With `onlyIf`, writes only while the run's status is one of
   * those (a guarded transition); undefined when nothing was written.
   */
  async update(
    _tenantId: string,
    _id: string,
    _patch: TestRunPatch,
    _onlyIf?: { status: readonly TestRunStatus[] },
  ): Promise<TestRunRow | undefined> {
    throw new Error('not implemented (L8)');
  }

  /** cases go with it (FK cascade); false when there was no such run */
  async delete(_tenantId: string, _workflowId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L8)');
  }

  /** sets `cancel_requested` on a run that is still 'new' or 'running'; undefined otherwise */
  async requestCancel(_tenantId: string, _id: string): Promise<TestRunRow | undefined> {
    throw new Error('not implemented (L8)');
  }

  /** one 'new' case per dataset row, `run_index` 0..count-1, ordered by `run_index` */
  async seedCases(_tenantId: string, _runId: string, _count: number): Promise<TestCaseExecutionRow[]> {
    throw new Error('not implemented (L8)');
  }

  /** ordered by `run_index`; `count` is the run's total */
  async listCases(
    _tenantId: string,
    _runId: string,
    _options: TestCaseListOptions,
  ): Promise<{ count: number; rows: TestCaseExecutionRow[] }> {
    throw new Error('not implemented (L8)');
  }

  async getCase(
    _tenantId: string,
    _runId: string,
    _caseId: string,
  ): Promise<TestCaseExecutionRow | undefined> {
    throw new Error('not implemented (L8)');
  }

  /**
   * With `onlyIf`, writes only while the case's status is one of those (case cancel: only 'new');
   * undefined when nothing was written.
   */
  async updateCase(
    _tenantId: string,
    _caseId: string,
    _patch: TestCasePatch,
    _onlyIf?: { status: readonly TestCaseStatus[] },
  ): Promise<TestCaseExecutionRow | undefined> {
    throw new Error('not implemented (L8)');
  }

  /** 'new' cases become 'cancelled' (run cancel); returns how many */
  async cancelPendingCases(_tenantId: string, _runId: string): Promise<number> {
    throw new Error('not implemented (L8)');
  }

  /** 'new' and 'running' cases become 'cancelled' (the sweep); returns how many */
  async cancelUnfinishedCases(_tenantId: string, _runId: string): Promise<number> {
    throw new Error('not implemented (L8)');
  }

  /** every status present with 0 for none, plus `total` */
  async caseCounts(_tenantId: string, _runId: string): Promise<TestCaseCounts> {
    throw new Error('not implemented (L8)');
  }

  /** the heartbeat: `updated_at = now()` only */
  async touch(_tenantId: string, _id: string): Promise<void> {
    throw new Error('not implemented (L8)');
  }

  /**
   * System-level, cross-tenant (the sweep): runs still 'new' or 'running'. `null`: all of them
   * (regular mode at start); a Date: only those with `updated_at` older than it (queue mode).
   */
  async listStale(_olderThan: Date | null): Promise<TestRunRow[]> {
    throw new Error('not implemented (L8)');
  }
}
