/**
 * Evaluation test runs (P5-02): runs the saved draft once per dataset row of its Evaluation Trigger, as
 * executions of mode `evaluation`, with a per-workspace pool of `config.evaluationConcurrencyLimit`
 * (CONCURRENCY_EVALUATION_LIMIT, at most 10). The dataset comes from
 * `executions.runNodeOperation(..., DATASET_GET_ROWS)`; each case from `executions.start({ mode: 'evaluation',
 * startNode: trigger, pinData: { [trigger]: [row] }, wait: true, userId })`. Cancel sets the run's flag, aborts
 * locally and broadcasts `bus.publish('control', { type: 'cancelTestRun', testRunId })` to the other mains.
 * `errorDetails` holds a node name, a message through `redactSecrets` and an execution id, never a stack or
 * run data: it goes out through REST and the public API to viewer keys.
 *
 * Built in context.ts and passed to the routes; `startMain` calls `init()` after `executions.init()` and
 * `sweepInterrupted()` after the regular-mode crash sweep (outside it: queue mode sweeps stale runs too);
 * `close()` runs before the executions close.
 *
 * C0 STUB: lane L8 writes the bodies (final signatures; L8 may add private helpers and constructor state).
 * `init`, `sweepInterrupted` and `close` do nothing here, so the suites that start a main keep passing.
 */
import type { TestCaseDto, TestRunDto } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';
import type { TestCaseListOptions, TestRunListOptions } from '../repositories';
import type { Actor } from './workflows';

/** the body of `POST /rest/workflows/:workflowId/test-runs/new` and of the public create */
export interface EvaluationStartInput {
  /** cases run at once, 1 to 10, clamped to `config.evaluationConcurrencyLimit`; default 1 */
  concurrency?: number;
  /** dataset row indices to run (0-based); absent = every row up to MAX_EVALUATION_ROWS */
  rowIndices?: number[];
}

/** one page of a list, as the repositories answer it (`count` is the total, `data` the page) */
export interface EvaluationPage<T> {
  count: number;
  data: T[];
}

const notImplemented = () => new Error('not implemented (L8)');

export class EvaluationService {
  constructor(protected readonly deps: ServiceDeps) {}

  /** wire the cancel broadcast (`control` / `cancelTestRun`); call once per main, after `executions.init()` */
  async init(): Promise<void> {}

  /**
   * Validate the workflow (research-A order and codes), create the run, answer at once with its id; the
   * cases run in the background. 404 for a workflow of another tenant, 409 `Workflow has no evaluation trigger`.
   */
  async start(
    _tenant: TenantRow,
    _workflowId: string,
    _input: EvaluationStartInput,
    _actor: Actor,
  ): Promise<{ testRunId: string }> {
    throw notImplemented();
  }

  /** newest first; `options.status` filters */
  async list(
    _tenantId: string,
    _workflowId: string,
    _options: TestRunListOptions,
  ): Promise<EvaluationPage<TestRunDto>> {
    throw notImplemented();
  }

  /** 404 for a run of another workflow or tenant */
  async get(_tenantId: string, _workflowId: string, _id: string): Promise<TestRunDto> {
    throw notImplemented();
  }

  /** by `runIndex` */
  async listCases(
    _tenantId: string,
    _workflowId: string,
    _runId: string,
    _options: TestCaseListOptions,
  ): Promise<EvaluationPage<TestCaseDto>> {
    throw notImplemented();
  }

  /** refuses a running run (409); the cases go with it */
  async delete(_tenantId: string, _workflowId: string, _id: string): Promise<void> {
    throw notImplemented();
  }

  /** a run that is not new or running: 409 `The test run "<id>" cannot be cancelled` */
  async cancel(_tenantId: string, _workflowId: string, _id: string): Promise<void> {
    throw notImplemented();
  }

  /** only a pending (`new`) case, else 409 */
  async cancelCase(_tenantId: string, _workflowId: string, _runId: string, _caseId: string): Promise<void> {
    throw notImplemented();
  }

  /**
   * Start of a main: regular mode closes every new or running run as error INTERRUPTED (as `markCrashed`);
   * queue mode only runs untouched for 5 minutes. A swept run's unfinished cases become `cancelled`.
   * Returns how many runs it closed.
   */
  async sweepInterrupted(): Promise<number> {
    return 0;
  }

  /** stop the heartbeat and the bus subscription; in-flight cases end with the executions' close */
  async close(): Promise<void> {}
}
