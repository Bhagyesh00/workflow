/**
 * Demo test runs (P5-11, lane L9): the 7 evaluation routes of the server (routes/evaluations.ts) on the
 * in-memory MockBackend. Viewers read; editors start, cancel and delete. DTOs are `TestRunDto` and
 * `TestCaseDto` of @workflow/workflow. The demo dataset is `demoEvaluationRows` (fixtures.ts); every case runs
 * through `backend.startExecution(wf, wf, { mode: 'evaluation', startNode, triggerItems: [row] })`, so the
 * simulator's Evaluation Trigger and Evaluation nodes produce its inputs, outputs and metrics.
 *
 * The rules follow the server's service (services/evaluations.ts): a workflow without an Evaluation Trigger
 * is a 409, a disabled trigger or a missing Set Metrics node ends the run with that error code, the run's
 * `concurrency` is clamped to 1..DEMO_EVALUATION_CONCURRENCY_LIMIT, a run that is new or running cannot be deleted,
 * only a case that has not started can be cancelled, and a completed run holds the mean of each metric over
 * the cases that have it and a `finalResult` of the worst case.
 * State lives in `backend.ext.testRuns`.
 */
import {
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type Item,
  MAX_EVALUATION_CONCURRENCY,
  MAX_EVALUATION_ROWS,
  type RunData,
  type TestCaseCounts,
  type TestCaseDto,
  type TestCaseStatus,
  type TestRunDto,
} from '@workflow/workflow';
import { newId } from '../lib/ids';
import { demoEvaluationRows } from './fixtures';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { HttpError, now } from './mock-http';

/** what /settings tells the demo editor, like the server's CONCURRENCY_EVALUATION_LIMIT default */
export const DEMO_EVALUATION_CONCURRENCY_LIMIT = 5;

interface StoredRun extends TestRunDto {
  tenantId: string;
}

interface StoredCase extends TestCaseDto {
  tenantId: string;
}

interface RunStore {
  runs: StoredRun[];
  cases: StoredCase[];
}

/** how long a demo case takes besides the simulated run, so a page can show a run in progress */
const CASE_DELAY_MS = 250;

const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details);
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function store(backend: MockBackend): RunStore {
  backend.ext.testRuns ??= { runs: [], cases: [] } satisfies RunStore;
  return backend.ext.testRuns as RunStore;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function countCases(cases: StoredCase[]): TestCaseCounts {
  const counts: TestCaseCounts = { new: 0, running: 0, success: 0, error: 0, cancelled: 0, total: 0 };
  for (const c of cases) {
    counts[c.status] += 1;
    counts.total += 1;
  }
  return counts;
}

function toRunDto(state: RunStore, run: StoredRun): TestRunDto {
  const { tenantId, ...dto } = run;
  void tenantId;
  const cases = state.cases.filter((c) => c.testRunId === run.id);
  return JSON.parse(JSON.stringify({ ...dto, caseCounts: countCases(cases) })) as TestRunDto;
}

function toCaseDto(testCase: StoredCase): TestCaseDto {
  const { tenantId, ...dto } = testCase;
  void tenantId;
  return JSON.parse(JSON.stringify(dto)) as TestCaseDto;
}

/** the run a request names, in the signed-in workspace and workflow */
function findRun(backend: MockBackend, workflowId: string, runId: string): StoredRun {
  const wf = backend.workflow(workflowId);
  const run = store(backend).runs.find(
    (r) => r.id === runId && r.workflowId === wf.id && r.tenantId === wf.tenantId,
  );
  if (!run) throw notFound('Test run');
  return run;
}

const numericOnly = (json: DataObject): Record<string, number> | null => {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(json)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    out[key] = value;
  }
  return out;
};

/** the first output item of the last run of the first node of `type` that passes `pick`, or null */
function outputOf(wf: StoredWorkflow, runData: RunData, pick: (operation: string) => boolean): Item | null {
  for (const node of wf.nodes) {
    if (node.type !== EVALUATION_NODE_TYPE || node.disabled) continue;
    if (!pick(String(node.parameters.operation ?? 'setOutputs'))) continue;
    const runs = runData[node.name];
    const last = runs?.[runs.length - 1];
    const item = last?.data?.main?.[0]?.[0];
    if (item) return item;
  }
  return null;
}

/** mean of each metric over the cases that have it (failed cases still add the predefined metrics); null when none has metrics */
function meanMetrics(cases: StoredCase[]): Record<string, number> | null {
  const sums = new Map<string, { sum: number; count: number }>();
  for (const c of cases) {
    if (!c.metrics) continue;
    for (const [name, value] of Object.entries(c.metrics)) {
      const entry = sums.get(name) ?? { sum: 0, count: 0 };
      entry.sum += value;
      entry.count += 1;
      sums.set(name, entry);
    }
  }
  if (sums.size === 0) return null;
  return Object.fromEntries([...sums].map(([name, { sum, count }]) => [name, sum / count]));
}

async function runCase(
  backend: MockBackend,
  wf: StoredWorkflow,
  run: StoredRun,
  testCase: StoredCase,
  triggerName: string,
  row: DataObject,
): Promise<void> {
  testCase.status = 'running';
  testCase.runAt = now();
  const executionId = backend.startExecution(wf, wf, {
    mode: 'evaluation',
    startNode: triggerName,
    triggerItems: [{ json: { ...row, row_number: testCase.runIndex + 1, row_id: testCase.runIndex + 1 } }],
    workflowVersionId: wf.versionId,
  });
  testCase.executionId = executionId;
  const execution = backend.executions.find((e) => e.id === executionId);
  if (!execution) return;
  await sleep(CASE_DELAY_MS);
  while (execution.status === 'running') await sleep(10);
  // a stop can land while the execution runs
  if ((testCase.status as TestCaseStatus) === 'cancelled' || (run.status as string) === 'cancelled') return;
  testCase.completedAt = now();
  const runData = execution.state.resultData.runData;
  testCase.inputs = row;
  testCase.outputs =
    (outputOf(wf, runData, (operation) => operation === 'setOutputs')?.json as DataObject | undefined) ??
    null;
  // as the server: a failed case still keeps the predefined metrics
  const predefined = { executionTime: execution.durationMs ?? 0 };
  testCase.metrics = predefined;
  if (execution.status !== 'success') {
    testCase.status = 'error';
    testCase.errorCode = 'FAILED_TO_EXECUTE_WORKFLOW';
    testCase.errorDetails = { message: execution.errorMessage ?? 'The execution failed', executionId };
    return;
  }
  const metricsItem = outputOf(wf, runData, (operation) => operation === 'setMetrics');
  if (!metricsItem) {
    testCase.status = 'error';
    testCase.errorCode = 'NO_METRICS_COLLECTED';
    return;
  }
  const metrics = numericOnly(metricsItem.json);
  if (!metrics) {
    testCase.status = 'error';
    testCase.errorCode = 'INVALID_METRICS';
    return;
  }
  testCase.status = 'success';
  testCase.metrics = { ...metrics, ...predefined };
}

/** run the cases of `run`, `run.concurrency` at once, then complete it (unless it was stopped) */
async function executeRun(
  backend: MockBackend,
  state: RunStore,
  wf: StoredWorkflow,
  run: StoredRun,
  triggerName: string,
  rows: DataObject[],
): Promise<void> {
  const queue = state.cases.filter((c) => c.testRunId === run.id);
  const worker = async () => {
    for (let testCase = queue.shift(); testCase; testCase = queue.shift()) {
      if (run.status === 'cancelled') return;
      if (testCase.status !== 'new') continue;
      await runCase(backend, wf, run, testCase, triggerName, rows[testCase.runIndex] ?? {});
    }
  };
  await Promise.all(Array.from({ length: run.concurrency }, worker));
  if (run.status === 'cancelled') return;
  const cases = state.cases.filter((c) => c.testRunId === run.id);
  run.status = 'completed';
  run.completedAt = now();
  run.updatedAt = run.completedAt;
  run.metrics = meanMetrics(cases);
  run.finalResult = cases.some((c) => c.status === 'error') ? 'error' : 'success';
}

function failRun(run: StoredRun, errorCode: NonNullable<TestRunDto['errorCode']>): void {
  run.status = 'error';
  run.errorCode = errorCode;
  run.completedAt = now();
  run.updatedAt = run.completedAt;
}

/**
 * Put a run (and its cases) into the demo store without running anything; tests and the Playwright-free
 * demo use it to show a run in any state. Ids, dates and counts are filled in.
 */
export function seedTestRun(
  backend: MockBackend,
  workflowId: string,
  run: Partial<TestRunDto> = {},
  cases: Array<Partial<TestCaseDto>> = [],
): TestRunDto {
  const wf = backend.workflow(workflowId);
  const state = store(backend);
  const stamp = now();
  const stored: StoredRun = {
    id: run.id ?? newId(),
    workflowId: wf.id,
    status: 'completed',
    runAt: stamp,
    completedAt: stamp,
    metrics: null,
    errorCode: null,
    errorDetails: null,
    concurrency: 1,
    finalResult: null,
    caseCounts: { new: 0, running: 0, success: 0, error: 0, cancelled: 0, total: 0 },
    createdAt: stamp,
    updatedAt: stamp,
    ...run,
    tenantId: wf.tenantId,
  };
  state.runs.unshift(stored);
  cases.forEach((c, index) => {
    state.cases.push({
      id: newId(),
      testRunId: stored.id,
      executionId: null,
      status: 'success',
      runIndex: index,
      runAt: stamp,
      completedAt: stamp,
      errorCode: null,
      errorDetails: null,
      metrics: null,
      inputs: null,
      outputs: null,
      ...c,
      tenantId: wf.tenantId,
    });
  });
  return toRunDto(state, stored);
}

/** change a seeded or running run in place (tests use it to move a run forward while the page polls) */
export function updateTestRun(
  backend: MockBackend,
  runId: string,
  patch: Partial<TestRunDto>,
  caseStatus?: { from: TestCaseStatus; to: TestCaseStatus },
): void {
  const state = store(backend);
  const run = state.runs.find((r) => r.id === runId);
  if (!run) throw notFound('Test run');
  Object.assign(run, patch);
  if (caseStatus) {
    for (const c of state.cases) {
      if (c.testRunId === runId && c.status === caseStatus.from) c.status = caseStatus.to;
    }
  }
}

export function registerEvaluationRoutes(backend: MockBackend): void {
  const state = () => store(backend);

  // list, newest first: ?skip, ?limit, ?status (viewer)
  backend.on('GET', '/workflows/:id/test-runs', ({ params, query }) => {
    const wf = backend.workflow(params[0]);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 250);
    const s = state();
    return s.runs
      .filter(
        (r) =>
          r.workflowId === wf.id &&
          r.tenantId === wf.tenantId &&
          (!query.status || r.status === query.status),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(skip, skip + limit)
      .map((r) => toRunDto(s, r));
  });

  // one run with its case counts (viewer)
  backend.on('GET', '/workflows/:id/test-runs/:runId', ({ params }) =>
    toRunDto(state(), findRun(backend, params[0], params[1])),
  );

  // the cases of a run, by dataset row (viewer)
  backend.on('GET', '/workflows/:id/test-runs/:runId/test-cases', ({ params, query }) => {
    const run = findRun(backend, params[0], params[1]);
    const skip = Math.max(Number(query.skip) || 0, 0);
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 250);
    return state()
      .cases.filter((c) => c.testRunId === run.id)
      .sort((a, b) => a.runIndex - b.runIndex)
      .slice(skip, skip + limit)
      .map(toCaseDto);
  });

  // start: body { concurrency?, rowIndices? }, answers { testRunId } (editor)
  backend.on('POST', '/workflows/:id/test-runs/new', ({ params, body }) => {
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(wf) });
    const trigger = wf.nodes.find((n) => n.type === EVALUATION_TRIGGER_TYPE);
    if (!trigger) {
      throw conflict('Workflow has no evaluation trigger', { code: 'EVALUATION_TRIGGER_NOT_FOUND' });
    }
    const requested = body.concurrency;
    if (requested !== undefined && (!Number.isInteger(requested) || (requested as number) < 1)) {
      throw badRequest('concurrency must be a whole number from 1');
    }
    if (body.rowIndices !== undefined && !Array.isArray(body.rowIndices)) {
      throw badRequest('rowIndices must be a list of row numbers');
    }
    const concurrency = Math.min(
      (requested as number | undefined) ?? 1,
      MAX_EVALUATION_CONCURRENCY,
      DEMO_EVALUATION_CONCURRENCY_LIMIT,
    );
    const s = state();
    const stamp = now();
    const run: StoredRun = {
      id: newId(),
      tenantId: wf.tenantId,
      workflowId: wf.id,
      status: 'new',
      runAt: null,
      completedAt: null,
      metrics: null,
      errorCode: null,
      errorDetails: null,
      concurrency,
      finalResult: null,
      caseCounts: { new: 0, running: 0, success: 0, error: 0, cancelled: 0, total: 0 },
      createdAt: stamp,
      updatedAt: stamp,
    };
    s.runs.unshift(run);

    const hasMetrics = wf.nodes.some(
      (n) => n.type === EVALUATION_NODE_TYPE && !n.disabled && n.parameters.operation === 'setMetrics',
    );
    const rows = demoEvaluationRows.slice(0, MAX_EVALUATION_ROWS);
    const wanted = Array.isArray(body.rowIndices)
      ? [
          ...new Set(
            (body.rowIndices as number[]).filter((i) => Number.isInteger(i) && i >= 0 && i < rows.length),
          ),
        ].sort((a, b) => a - b)
      : rows.map((_, i) => i);
    // the server checks these after it made the run, and ends it with the code
    if (trigger.disabled) failRun(run, 'EVALUATION_TRIGGER_DISABLED');
    else if (!hasMetrics) failRun(run, 'SET_METRICS_NODE_NOT_FOUND');
    else if (wanted.length === 0) failRun(run, 'TEST_CASES_NOT_FOUND');
    if (run.status === 'error') return { testRunId: run.id };

    for (const index of wanted) {
      s.cases.push({
        id: newId(),
        tenantId: wf.tenantId,
        testRunId: run.id,
        executionId: null,
        status: 'new',
        runIndex: index,
        runAt: null,
        completedAt: null,
        errorCode: null,
        errorDetails: null,
        metrics: null,
        inputs: null,
        outputs: null,
      });
    }
    setTimeout(() => {
      if (run.status !== 'new') return;
      run.status = 'running';
      run.runAt = now();
      run.updatedAt = run.runAt;
      void executeRun(backend, s, wf, run, trigger.name, rows);
    }, 0);
    return { testRunId: run.id };
  });

  // stop a new or running run (editor)
  backend.on('POST', '/workflows/:id/test-runs/:runId/cancel', ({ params }) => {
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(backend.workflow(params[0])) });
    const run = findRun(backend, params[0], params[1]);
    if (run.status !== 'new' && run.status !== 'running') {
      throw conflict(`The test run "${run.id}" cannot be cancelled`);
    }
    run.status = 'cancelled';
    run.completedAt = now();
    run.updatedAt = run.completedAt;
    for (const c of state().cases) {
      if (c.testRunId !== run.id) continue;
      if (c.status === 'new' || c.status === 'running') {
        c.status = 'cancelled';
        const execution = c.executionId ? backend.executions.find((e) => e.id === c.executionId) : undefined;
        if (execution?.cancel) execution.cancel.canceled = true;
      }
    }
    return { ok: true };
  });

  // cancel one case that has not started (editor)
  backend.on('POST', '/workflows/:id/test-runs/:runId/test-cases/:caseId/cancel', ({ params }) => {
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(backend.workflow(params[0])) });
    const run = findRun(backend, params[0], params[1]);
    const testCase = state().cases.find((c) => c.id === params[2] && c.testRunId === run.id);
    if (!testCase) throw notFound('Test case');
    if (testCase.status !== 'new') throw conflict(`The test case "${testCase.id}" cannot be cancelled`);
    testCase.status = 'cancelled';
    return { ok: true };
  });

  // delete a run that is not running (editor)
  backend.on('DELETE', '/workflows/:id/test-runs/:runId', ({ params }) => {
    backend.requireScope('workflow:execute', { scopes: backend.rowScopes(backend.workflow(params[0])) });
    const run = findRun(backend, params[0], params[1]);
    if (run.status === 'new' || run.status === 'running') {
      throw conflict(`The test run "${run.id}" is running. Stop it before deleting it.`);
    }
    const s = state();
    s.runs = s.runs.filter((r) => r.id !== run.id);
    s.cases = s.cases.filter((c) => c.testRunId !== run.id);
    return { ok: true };
  });
}
