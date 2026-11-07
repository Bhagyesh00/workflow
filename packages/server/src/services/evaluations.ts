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
 */
import { randomUUID } from 'node:crypto';
import {
  DATASET_GET_ROWS,
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type EvaluationMetrics,
  type ExecutionState,
  type Item,
  MAX_EVALUATION_ROWS,
  type RunData,
  redactSecrets,
  type TestCaseCounts,
  type TestCaseDto,
  type TestCaseErrorCode,
  type TestRunDto,
  type TestRunErrorCode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { TenantRow, TestCaseExecutionRow, TestRunRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { TestCaseListOptions, TestRunListOptions } from '../repositories';
import type { ExecutionOutcome } from './executions';
import { runtimeDefinition } from './published-workflow';
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

/** the heartbeat of a running run; queue-mode mains sweep runs untouched for STALE_AFTER_MS */
const HEARTBEAT_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;
/** how long a cancelled case waits for its stopped execution to report before it is closed anyway */
const STOP_GRACE_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;
const GOOGLE_CREDENTIALS: Record<string, string> = {
  serviceAccount: 'googleApi',
  oAuth2: 'googleSheetsOAuth2Api',
};
const ACTIVE = ['new', 'running'] as const;

type StopReason = 'cancel' | 'shutdown';

interface LocalRun {
  tenantId: string;
  workflowId: string;
  controller: AbortController;
  reason?: StopReason;
  /** case id -> execution id of the cases in flight */
  inFlight: Map<string, string>;
  done: Promise<void>;
}

interface RunFailure {
  code: TestRunErrorCode;
  details: DataObject | null;
}

/** a counting semaphore; `acquire` resolves false when the signal aborts before a slot frees */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve(true);
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(false);
      };
      this.waiting.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

export class EvaluationService {
  /** this process's id, written on the runs it executes */
  private readonly instanceId = randomUUID();
  /** runs executing in this process, by run id */
  private readonly local = new Map<string, LocalRun>();
  /** one pool per workspace: two runs of one workspace share it */
  private readonly pools = new Map<string, Semaphore>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(protected readonly deps: ServiceDeps) {}

  /** wire the cancel broadcast (`control` / `cancelTestRun`); call once per main, after `executions.init()` */
  async init(): Promise<void> {
    const { bus } = this.deps.context();
    this.unsubscribers.push(
      await bus.subscribe('control', (message: { type?: string; testRunId?: string }) => {
        if (message?.type === 'cancelTestRun' && typeof message.testRunId === 'string') {
          this.stopLocal(message.testRunId, 'cancel');
        }
      }),
    );
  }

  /**
   * Validate the workflow (research-A order and codes), create the run, answer at once with its id; the
   * cases run in the background. 404 for a workflow of another tenant, 409 `Workflow has no evaluation trigger`.
   */
  async start(
    tenant: TenantRow,
    workflowId: string,
    input: EvaluationStartInput,
    actor: Actor,
  ): Promise<{ testRunId: string }> {
    const { repos, config } = this.deps;
    const row = await repos.workflows.get(tenant.id, workflowId);
    if (!row) throw ApiError.notFound('Workflow');
    // the saved draft, as n8n runs the saved workflow and not the canvas
    const definition = await runtimeDefinition(repos, tenant.id, row, 'manual');
    const trigger = definition.nodes.find((n) => n.type === EVALUATION_TRIGGER_TYPE);
    if (!trigger) {
      throw ApiError.conflict('Workflow has no evaluation trigger', { code: 'EVALUATION_TRIGGER_NOT_FOUND' });
    }
    const limit = Math.max(1, config.evaluationConcurrencyLimit);
    const concurrency = Math.min(Math.max(1, Math.floor(input.concurrency ?? 1)), limit);
    const run = await repos.testRuns.create(tenant.id, {
      workflowId,
      concurrency,
      workflowVersionId: row.versionId,
      runningInstanceId: this.instanceId,
    });
    const failure = validateWorkflow(definition, trigger);
    if (failure) {
      await this.fail(tenant.id, run.id, failure);
      return { testRunId: run.id };
    }
    this.launch(tenant.id, run, definition, trigger, input, actor);
    return { testRunId: run.id };
  }

  /** newest first; `options.status` filters */
  async list(
    tenantId: string,
    workflowId: string,
    options: TestRunListOptions,
  ): Promise<EvaluationPage<TestRunDto>> {
    const { repos } = this.deps;
    if (!(await repos.workflows.get(tenantId, workflowId))) throw ApiError.notFound('Workflow');
    const page = await repos.testRuns.list(tenantId, workflowId, options);
    const data = await Promise.all(
      page.rows.map(async (row) => toRunDto(row, await repos.testRuns.caseCounts(tenantId, row.id))),
    );
    return { count: page.count, data };
  }

  /** 404 for a run of another workflow or tenant */
  async get(tenantId: string, workflowId: string, id: string): Promise<TestRunDto> {
    const row = await this.runOf(tenantId, workflowId, id);
    return toRunDto(row, await this.deps.repos.testRuns.caseCounts(tenantId, row.id));
  }

  /** by `runIndex` */
  async listCases(
    tenantId: string,
    workflowId: string,
    runId: string,
    options: TestCaseListOptions,
  ): Promise<EvaluationPage<TestCaseDto>> {
    await this.runOf(tenantId, workflowId, runId);
    const page = await this.deps.repos.testRuns.listCases(tenantId, runId, options);
    return { count: page.count, data: page.rows.map(toCaseDto) };
  }

  /** refuses a running run (409); the cases go with it */
  async delete(tenantId: string, workflowId: string, id: string): Promise<void> {
    const row = await this.runOf(tenantId, workflowId, id);
    if (isActive(row.status)) {
      throw ApiError.conflict(`The test run "${id}" is running. Stop it before deleting it.`);
    }
    if (!(await this.deps.repos.testRuns.delete(tenantId, workflowId, id)))
      throw ApiError.notFound('Test run');
  }

  /** a run that is not new or running: 409 `The test run "<id>" cannot be cancelled` */
  async cancel(tenantId: string, workflowId: string, id: string): Promise<void> {
    const { repos } = this.deps;
    await this.runOf(tenantId, workflowId, id);
    const requested = await repos.testRuns.requestCancel(tenantId, id);
    if (!requested) throw ApiError.conflict(`The test run "${id}" cannot be cancelled`);
    await repos.testRuns.update(
      tenantId,
      id,
      { status: 'cancelled', completedAt: new Date() },
      { status: ACTIVE },
    );
    await repos.testRuns.cancelPendingCases(tenantId, id);
    this.stopLocal(id, 'cancel');
    await this.deps
      .context()
      .bus.publish('control', { type: 'cancelTestRun', testRunId: id })
      .catch(() => {});
  }

  /** only a pending (`new`) case, else 409 */
  async cancelCase(tenantId: string, workflowId: string, runId: string, caseId: string): Promise<void> {
    const { repos } = this.deps;
    await this.runOf(tenantId, workflowId, runId);
    const found = await repos.testRuns.getCase(tenantId, runId, caseId);
    if (!found) throw ApiError.notFound('Test case');
    const cancelled = await repos.testRuns.updateCase(
      tenantId,
      caseId,
      { status: 'cancelled', completedAt: new Date() },
      { status: ['new'] },
    );
    if (!cancelled) throw ApiError.conflict(`The test case "${caseId}" cannot be cancelled`);
  }

  /**
   * Start of a main: regular mode closes every new or running run as error INTERRUPTED (as `markCrashed`);
   * queue mode only runs untouched for 5 minutes. A swept run's unfinished cases become `cancelled`.
   * Returns how many runs it closed.
   */
  async sweepInterrupted(): Promise<number> {
    const { repos, config } = this.deps;
    const olderThan = config.executionsMode === 'queue' ? new Date(Date.now() - STALE_AFTER_MS) : null;
    let closed = 0;
    for (const run of await repos.testRuns.listStale(olderThan)) {
      // a run this process executes is alive
      if (this.local.has(run.id)) continue;
      const done = await repos.testRuns.update(
        run.tenantId,
        run.id,
        { status: 'error', errorCode: 'INTERRUPTED', errorDetails: null, completedAt: new Date() },
        { status: ACTIVE },
      );
      if (!done) continue;
      await repos.testRuns.cancelUnfinishedCases(run.tenantId, run.id);
      closed++;
    }
    return closed;
  }

  /** stop the heartbeat and the bus subscription; in-flight cases end with the executions' close */
  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const pending = [...this.local.keys()].map((id) => {
      const run = this.local.get(id);
      this.stopLocal(id, 'shutdown');
      return run?.done;
    });
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
      ]);
    }
  }

  // -------------------------------------------------------------------------------------------
  // running

  private async runOf(tenantId: string, workflowId: string, id: string): Promise<TestRunRow> {
    const row = await this.deps.repos.testRuns.get(tenantId, workflowId, id);
    if (!row) throw ApiError.notFound('Test run');
    return row;
  }

  private pool(tenantId: string): Semaphore {
    let pool = this.pools.get(tenantId);
    if (!pool) {
      pool = new Semaphore(Math.max(1, this.deps.config.evaluationConcurrencyLimit));
      this.pools.set(tenantId, pool);
    }
    return pool;
  }

  private launch(
    tenantId: string,
    run: TestRunRow,
    definition: WorkflowDefinition,
    trigger: WorkflowNode,
    input: EvaluationStartInput,
    actor: Actor,
  ): void {
    const controller = new AbortController();
    const entry: LocalRun = {
      tenantId,
      workflowId: run.workflowId,
      controller,
      inFlight: new Map(),
      done: Promise.resolve(),
    };
    this.local.set(run.id, entry);
    const heartbeat = setInterval(() => void this.beat(run.id, entry), HEARTBEAT_MS);
    heartbeat.unref();
    entry.done = this.execute(run, definition, trigger, input, actor, entry)
      .catch(async (error: unknown) => {
        this.deps.logger.warn(
          { tenantId, testRunId: run.id, error: (error as Error)?.name ?? 'Error' },
          'Test run failed',
        );
        await this.fail(tenantId, run.id, {
          code: 'UNKNOWN_ERROR',
          details: { message: redactSecrets(messageOf(error)) },
        }).catch(() => {});
        await this.deps.repos.testRuns.cancelUnfinishedCases(tenantId, run.id).catch(() => {});
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.local.delete(run.id);
        const pool = this.pools.get(tenantId);
        if (pool?.idle) this.pools.delete(tenantId);
      });
  }

  /** the heartbeat: moves `updated_at` and notices a cancel this main did not get over the bus */
  private async beat(runId: string, entry: LocalRun): Promise<void> {
    const { repos } = this.deps;
    try {
      await repos.testRuns.touch(entry.tenantId, runId);
      const row = await repos.testRuns.get(entry.tenantId, entry.workflowId, runId);
      if (!row || row.cancelRequested || !isActive(row.status)) this.stopLocal(runId, 'cancel');
    } catch {
      // the next beat tries again
    }
  }

  private stopLocal(runId: string, reason: StopReason): void {
    const entry = this.local.get(runId);
    if (!entry || entry.controller.signal.aborted) return;
    entry.reason = reason;
    entry.controller.abort();
    const { executions } = this.deps.context();
    for (const executionId of entry.inFlight.values()) {
      void executions.stop(entry.tenantId, executionId).catch(() => {});
    }
  }

  private async execute(
    run: TestRunRow,
    definition: WorkflowDefinition,
    trigger: WorkflowNode,
    input: EvaluationStartInput,
    actor: Actor,
    entry: LocalRun,
  ): Promise<void> {
    const { repos } = this.deps;
    const { tenantId } = entry;
    const { signal } = entry.controller;
    const started = await repos.testRuns.update(
      tenantId,
      run.id,
      { status: 'running', runAt: new Date(), runningInstanceId: this.instanceId },
      { status: ['new'] },
    );
    if (!started) return;

    let items: Item[];
    try {
      items = await this.deps
        .context()
        .executions.runNodeOperation(tenantId, definition, trigger.name, DATASET_GET_ROWS, signal);
    } catch (error) {
      if (signal.aborted) return this.stopped(run.id, entry);
      return this.fail(tenantId, run.id, {
        code: 'CANT_FETCH_TEST_CASES',
        details: { node: trigger.name, message: redactSecrets(messageOf(error)) },
      });
    }
    const rows = items.slice(0, MAX_EVALUATION_ROWS).map((item) => item.json ?? {});
    const indices = input.rowIndices
      ? [...new Set(input.rowIndices)].filter((i) => i < rows.length).sort((a, b) => a - b)
      : rows.map((_, i) => i);
    if (!indices.length) return this.fail(tenantId, run.id, { code: 'TEST_CASES_NOT_FOUND', details: null });
    if (signal.aborted) return this.stopped(run.id, entry);

    const cases = await repos.testRuns.seedCasesAt(tenantId, run.id, indices);
    let next = 0;
    const pool = this.pool(tenantId);
    const worker = async () => {
      while (!signal.aborted && next < cases.length) {
        const testCase = cases[next++];
        if (!(await pool.acquire(signal))) return;
        try {
          await this.runCase(run, definition, trigger, testCase, rows[testCase.runIndex], actor, entry);
        } finally {
          pool.release();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(run.concurrency, cases.length) }, worker));
    if (signal.aborted) return this.stopped(run.id, entry);

    const all = await repos.testRuns.listCases(tenantId, run.id, { limit: MAX_EVALUATION_ROWS });
    await repos.testRuns.update(
      tenantId,
      run.id,
      { status: 'completed', completedAt: new Date(), metrics: meanMetrics(all.rows) },
      { status: ['running'] },
    );
  }

  /** after an abort: a cancel already closed the run; a shutdown leaves it interrupted */
  private async stopped(runId: string, entry: LocalRun): Promise<void> {
    const { repos } = this.deps;
    if (entry.reason === 'shutdown') {
      await repos.testRuns.update(
        entry.tenantId,
        runId,
        { status: 'error', errorCode: 'INTERRUPTED', errorDetails: null, completedAt: new Date() },
        { status: ACTIVE },
      );
      await repos.testRuns.cancelUnfinishedCases(entry.tenantId, runId);
      return;
    }
    await repos.testRuns.update(
      entry.tenantId,
      runId,
      { status: 'cancelled', completedAt: new Date() },
      { status: ACTIVE },
    );
    await repos.testRuns.cancelPendingCases(entry.tenantId, runId);
  }

  private async fail(tenantId: string, runId: string, failure: RunFailure): Promise<void> {
    await this.deps.repos.testRuns.update(
      tenantId,
      runId,
      {
        status: 'error',
        errorCode: failure.code,
        errorDetails: failure.details,
        completedAt: new Date(),
      },
      { status: ACTIVE },
    );
  }

  private async runCase(
    run: TestRunRow,
    definition: WorkflowDefinition,
    trigger: WorkflowNode,
    testCase: TestCaseExecutionRow,
    row: DataObject,
    actor: Actor,
    entry: LocalRun,
  ): Promise<void> {
    const { repos } = this.deps;
    const { executions } = this.deps.context();
    const { tenantId } = entry;
    const { signal } = entry.controller;
    // a case cancelled while pending is skipped
    const claimed = await repos.testRuns.updateCase(
      tenantId,
      testCase.id,
      { status: 'running', runAt: new Date() },
      { status: ['new'] },
    );
    if (!claimed) return;
    await this.beat(run.id, entry);
    if (signal.aborted) {
      await repos.testRuns.updateCase(tenantId, testCase.id, {
        status: 'cancelled',
        completedAt: new Date(),
      });
      return;
    }

    const startedAt = Date.now();
    let executionId = '';
    let outcome: ExecutionOutcome | undefined;
    try {
      const startedRun = await executions.start({
        tenantId,
        workflow: definition,
        workflowId: run.workflowId,
        mode: 'evaluation',
        startNode: trigger.name,
        pinData: { [trigger.name]: [{ json: row }] },
        wait: true,
        userId: actor.userId,
      });
      executionId = startedRun.executionId;
      entry.inFlight.set(testCase.id, executionId);
      await repos.testRuns.updateCase(tenantId, testCase.id, { executionId });
      // a cancel that came while the execution was being created
      if (signal.aborted) void executions.stop(tenantId, executionId).catch(() => {});
      outcome = await untilFinished(startedRun.finished, signal);
    } catch (error) {
      await this.closeCase(tenantId, testCase.id, {
        status: 'error',
        errorCode: 'UNKNOWN_ERROR',
        errorDetails: { message: redactSecrets(messageOf(error)) },
        metrics: null,
      });
      return;
    } finally {
      entry.inFlight.delete(testCase.id);
    }

    if (!outcome || outcome.status === 'canceled' || (signal.aborted && outcome.status !== 'success')) {
      await this.closeCase(tenantId, testCase.id, { status: 'cancelled', metrics: null });
      return;
    }
    if (outcome.status === 'waiting') {
      // an evaluation case cannot wait for an outside event: stop it rather than leave it parked
      await executions.stop(tenantId, executionId).catch(() => {});
    }

    const data = await repos.executions.getData(tenantId, executionId);
    const runData = ((data?.state as ExecutionState | null)?.resultData?.runData ?? {}) as RunData;
    const predefined = await this.predefinedMetrics(tenantId, executionId, runData, startedAt);
    if (outcome.status !== 'success') {
      await this.closeCase(tenantId, testCase.id, {
        status: 'error',
        errorCode: 'FAILED_TO_EXECUTE_WORKFLOW',
        errorDetails: {
          ...(outcome.error?.node || outcome.lastNodeExecuted
            ? { node: outcome.error?.node ?? outcome.lastNodeExecuted ?? null }
            : {}),
          message: redactSecrets(
            outcome.status === 'waiting'
              ? 'The workflow waited for an event, which an evaluation case cannot do'
              : (outcome.error?.message ?? 'The execution did not finish'),
          ),
          executionId,
        },
        metrics: predefined,
      });
      return;
    }

    const collected = userMetrics(definition, runData);
    const { inputs, outputs } = evaluationData(runData);
    if (!collected) {
      await this.closeCase(tenantId, testCase.id, {
        status: 'error',
        errorCode: 'NO_METRICS_COLLECTED',
        errorDetails: { executionId },
        metrics: predefined,
        inputs,
        outputs,
      });
      return;
    }
    const invalid = Object.keys(collected).find(
      (name) => typeof collected[name] !== 'number' || !Number.isFinite(collected[name]),
    );
    if (invalid !== undefined) {
      await this.closeCase(tenantId, testCase.id, {
        status: 'error',
        errorCode: 'INVALID_METRICS',
        errorDetails: { metric: invalid, executionId },
        metrics: predefined,
        inputs,
        outputs,
      });
      return;
    }
    await this.closeCase(tenantId, testCase.id, {
      status: 'success',
      metrics: { ...(collected as EvaluationMetrics), ...predefined },
      inputs,
      outputs,
    });
  }

  private async closeCase(
    tenantId: string,
    caseId: string,
    result: {
      status: 'success' | 'error' | 'cancelled';
      errorCode?: TestCaseErrorCode;
      errorDetails?: DataObject;
      metrics: EvaluationMetrics | null;
      inputs?: DataObject | null;
      outputs?: DataObject | null;
    },
  ): Promise<void> {
    await this.deps.repos.testRuns.updateCase(tenantId, caseId, {
      status: result.status,
      completedAt: new Date(),
      errorCode: result.errorCode ?? null,
      errorDetails: result.errorDetails ?? null,
      metrics: result.metrics,
      inputs: result.inputs ?? null,
      outputs: result.outputs ?? null,
    });
  }

  /** token counts of the model sub-node runs (when any ran) and the execution time in ms */
  private async predefinedMetrics(
    tenantId: string,
    executionId: string,
    runData: RunData,
    startedAt: number,
  ): Promise<EvaluationMetrics> {
    const row = await this.deps.repos.executions.get(tenantId, executionId);
    const executionTime =
      row?.startedAt && row.stoppedAt
        ? Math.max(0, row.stoppedAt.getTime() - row.startedAt.getTime())
        : Date.now() - startedAt;
    return { ...tokenUsage(runData), executionTime };
  }
}

// ---------------------------------------------------------------------------------------------
// validation (research-A order and codes)

function locatorValue(value: unknown): string {
  if (value && typeof value === 'object' && 'value' in value) {
    return String((value as { value: unknown }).value ?? '').trim();
  }
  return typeof value === 'string' ? value.trim() : '';
}

function datasetConfigured(node: WorkflowNode): boolean {
  const p = node.parameters ?? {};
  const source = String(p.source ?? 'dataTable');
  if (source === 'dataTable') return locatorValue(p.dataTableId) !== '';
  if (source === 'googleSheets') {
    const credentialType =
      GOOGLE_CREDENTIALS[String(p.authentication ?? 'oAuth2')] ?? GOOGLE_CREDENTIALS.oAuth2;
    return (
      Boolean(node.credentials?.[credentialType]?.id) &&
      locatorValue(p.documentId) !== '' &&
      locatorValue(p.sheetName) !== ''
    );
  }
  return false;
}

/** an assignment list with at least one entry, each with a name */
function assignmentsNamed(value: unknown): boolean {
  const list = (value as { assignments?: Array<{ name?: unknown }> } | undefined)?.assignments;
  return Array.isArray(list) && list.length > 0 && list.every((a) => String(a?.name ?? '').trim() !== '');
}

function modelConnected(definition: WorkflowDefinition, nodeName: string): boolean {
  return Object.values(definition.connections ?? {}).some((outputs) =>
    (outputs?.ai_languageModel ?? []).some((targets) => (targets ?? []).some((t) => t.node === nodeName)),
  );
}

function evaluationNodes(definition: WorkflowDefinition, operation: string): WorkflowNode[] {
  return definition.nodes.filter(
    (n) =>
      n.type === EVALUATION_NODE_TYPE &&
      !n.disabled &&
      String(n.parameters?.operation ?? 'setOutputs') === operation,
  );
}

function validateWorkflow(definition: WorkflowDefinition, trigger: WorkflowNode): RunFailure | undefined {
  if (!datasetConfigured(trigger)) {
    return { code: 'EVALUATION_TRIGGER_NOT_CONFIGURED', details: { node: trigger.name } };
  }
  if (trigger.disabled) return { code: 'EVALUATION_TRIGGER_DISABLED', details: { node: trigger.name } };
  const unsetOutputs = evaluationNodes(definition, 'setOutputs').find(
    (n) => !assignmentsNamed(n.parameters?.outputs),
  );
  if (unsetOutputs) return { code: 'SET_OUTPUTS_NODE_NOT_CONFIGURED', details: { node: unsetOutputs.name } };
  const metricNodes = evaluationNodes(definition, 'setMetrics');
  if (!metricNodes.length) return { code: 'SET_METRICS_NODE_NOT_FOUND', details: null };
  const unsetMetrics = metricNodes.find((n) => {
    const metric = String(n.parameters?.metric ?? 'correctness');
    if (metric === 'customMetrics') return !assignmentsNamed(n.parameters?.metrics);
    if (metric === 'correctness' || metric === 'helpfulness') return !modelConnected(definition, n.name);
    return false;
  });
  if (unsetMetrics) return { code: 'SET_METRICS_NODE_NOT_CONFIGURED', details: { node: unsetMetrics.name } };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// case results

/** the user's metrics: the first output item of each run of the enabled Set Metrics nodes; null for none */
function userMetrics(definition: WorkflowDefinition, runData: RunData): DataObject | null {
  let found = false;
  const metrics: DataObject = {};
  for (const node of evaluationNodes(definition, 'setMetrics')) {
    for (const task of runData[node.name] ?? []) {
      const first = task?.data?.main?.[0]?.[0];
      if (!first?.json) continue;
      found = true;
      Object.assign(metrics, first.json);
    }
  }
  return found ? metrics : null;
}

/** what Set Inputs and Set Outputs recorded on their items in this execution */
function evaluationData(runData: RunData): { inputs: DataObject | null; outputs: DataObject | null } {
  const inputs: DataObject = {};
  const outputs: DataObject = {};
  for (const tasks of Object.values(runData)) {
    for (const task of tasks ?? []) {
      for (const items of task?.data?.main ?? []) {
        for (const item of items ?? []) {
          const recorded = item?.evaluationData as { operation?: unknown; data?: unknown } | undefined;
          if (!recorded?.data || typeof recorded.data !== 'object') continue;
          if (recorded.operation === 'setInputs') Object.assign(inputs, recorded.data);
          else if (recorded.operation === 'setOutputs') Object.assign(outputs, recorded.data);
        }
      }
    }
  }
  return {
    inputs: Object.keys(inputs).length ? inputs : null,
    outputs: Object.keys(outputs).length ? outputs : null,
  };
}

/** `tokenUsage` of the model sub-node runs: inputTokens to promptTokens, outputTokens to completionTokens */
function tokenUsage(runData: RunData): EvaluationMetrics {
  let prompt = 0;
  let completion = 0;
  let found = false;
  for (const tasks of Object.values(runData)) {
    for (const task of tasks ?? []) {
      for (const items of task?.data?.ai_languageModel ?? []) {
        for (const item of items ?? []) {
          const usage = item?.json?.tokenUsage as
            | { inputTokens?: unknown; outputTokens?: unknown }
            | undefined;
          if (!usage || typeof usage !== 'object') continue;
          const input = Number(usage.inputTokens);
          const output = Number(usage.outputTokens);
          if (Number.isFinite(input)) prompt += input;
          if (Number.isFinite(output)) completion += output;
          found = true;
        }
      }
    }
  }
  return found
    ? { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion }
    : {};
}

/** mean per metric name over the cases that have it */
function meanMetrics(cases: TestCaseExecutionRow[]): EvaluationMetrics {
  const sums = new Map<string, { total: number; n: number }>();
  for (const testCase of cases) {
    for (const [name, value] of Object.entries(testCase.metrics ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const sum = sums.get(name) ?? { total: 0, n: 0 };
      sum.total += value;
      sum.n++;
      sums.set(name, sum);
    }
  }
  return Object.fromEntries([...sums].map(([name, { total, n }]) => [name, total / n]));
}

/** the execution's outcome; undefined when the run was cancelled and it did not report in time */
async function untilFinished(
  finished: Promise<ExecutionOutcome> | undefined,
  signal: AbortSignal,
): Promise<ExecutionOutcome | undefined> {
  if (!finished) return undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<undefined>((resolve) => {
    const arm = () => {
      timer = setTimeout(() => resolve(undefined), STOP_GRACE_MS);
      timer.unref();
    };
    if (signal.aborted) arm();
    else {
      onAbort = arm;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([finished, late]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function isActive(status: string): boolean {
  return status === 'new' || status === 'running';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function toRunDto(row: TestRunRow, caseCounts: TestCaseCounts): TestRunDto {
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    runAt: iso(row.runAt),
    completedAt: iso(row.completedAt),
    metrics: row.metrics ?? null,
    errorCode: row.errorCode ?? null,
    errorDetails: row.errorDetails ?? null,
    concurrency: row.concurrency,
    finalResult: row.status === 'completed' ? (caseCounts.error > 0 ? 'error' : 'success') : null,
    caseCounts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCaseDto(row: TestCaseExecutionRow): TestCaseDto {
  return {
    id: row.id,
    testRunId: row.testRunId,
    executionId: row.executionId ?? null,
    status: row.status,
    runIndex: row.runIndex,
    runAt: iso(row.runAt),
    completedAt: iso(row.completedAt),
    errorCode: row.errorCode ?? null,
    errorDetails: row.errorDetails ?? null,
    metrics: row.metrics ?? null,
    inputs: row.inputs ?? null,
    outputs: row.outputs ?? null,
  };
}
