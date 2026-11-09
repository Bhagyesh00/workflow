/**
 * P5-02 evaluation runner on the real server and database, with the real Evaluation Trigger and Evaluation
 * nodes, a Data table dataset and a scripted model. Done when: a run stores a score per row and a total.
 */
import { randomUUID } from 'node:crypto';
import {
  type AiChatResponse,
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type NodePackage,
  type TestCaseDto,
  type TestRunDto,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  createWorkflow,
  node,
  realMember,
  resetDatabase,
  signup as signupFrom,
  type TestClient,
  type TestServer,
  teamProjectOf,
  waitFor,
} from './helpers';

/** cases in flight at once, seen by the Probe node */
const probe = { inFlight: 0, peak: 0 };

const evalTestPackage: NodePackage = {
  name: 'evaluation-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.evalProbe',
        displayName: 'Probe',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Probe' },
        inputs: ['main'],
        outputs: ['main'],
        properties: [{ displayName: 'Milliseconds', name: 'ms', type: 'number', default: 200 }],
      },
      async execute(ctx) {
        const ms = Number(ctx.getNodeParameter('ms', 0, 200));
        probe.inFlight++;
        probe.peak = Math.max(probe.peak, probe.inFlight);
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            ctx.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('Stopped'));
              },
              { once: true },
            );
          });
        } finally {
          probe.inFlight--;
        }
        return [ctx.getInputData()];
      },
    },
    {
      description: {
        name: 'test.judgeModel',
        displayName: 'Judge Model',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Model' },
        inputs: [],
        outputs: ['ai_languageModel'],
        properties: [{ displayName: 'Score', name: 'score', type: 'number', default: 4 }],
      },
      async supplyData(ctx, itemIndex) {
        const score = Number(ctx.getNodeParameter('score', itemIndex, 4));
        const chat = async (): Promise<AiChatResponse> => {
          const response: AiChatResponse = {
            message: { role: 'assistant', content: JSON.stringify({ score }) },
            usage: { inputTokens: 11, outputTokens: 7 },
            stopReason: 'end',
          };
          ctx.logSubNodeRun?.(
            { model: 'scripted' },
            {
              response: { role: 'assistant', content: String(response.message.content) },
              tokenUsage: { inputTokens: 11, outputTokens: 7 },
            },
          );
          return response;
        };
        return { response: { kind: 'chatModel', provider: 'test', model: 'scripted', chat } };
      },
    },
  ],
};

let server: TestServer;
const signup = () =>
  signupFrom(server.app, {
    remoteAddress: `10.52.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
type Owner = Awaited<ReturnType<typeof signup>>;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000', CONCURRENCY_EVALUATION_LIMIT: '3' },
    { nodePackages: [evalTestPackage] },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  probe.inFlight = 0;
  probe.peak = 0;
});

// ---------------------------------------------------------------------------------------------
// fixtures

const locator = (value: string) => ({ __rl: true, mode: 'id', value });
const assignment = (name: string, value: unknown, type = 'string') => ({
  id: randomUUID(),
  name,
  value,
  type,
});
const link = (from: string, to: string, output = 0, type = 'main') => ({ from, to, output, type });

function connect(links: Array<ReturnType<typeof link>>) {
  const connections: Record<
    string,
    Record<string, Array<Array<{ node: string; type: string; index: number }>>>
  > = {};
  for (const { from, to, output, type } of links) {
    const outputs = ((connections[from] ??= {})[type] ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output].push({ node: to, type, index: 0 });
  }
  return connections;
}

/** a real member of the workspace with the given role in the team project, where the test workflows live */
async function member(owner: Owner, role: 'project:editor' | 'project:viewer') {
  const m = await realMember(owner);
  await addToProject(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id), m.user.id, role);
  return m.client;
}

async function makeDataset(owner: Owner, rows: DataObject[]) {
  const table = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/data-tables', {
      name: `Dataset ${randomUUID().slice(0, 6)}`,
      columns: [
        { name: 'question', type: 'string' },
        { name: 'expected', type: 'string' },
        { name: 'points', type: 'number' },
      ],
    }),
  );
  if (rows.length)
    await owner.client.data(owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: rows }));
  return table.id;
}

const ROWS = [
  { question: 'one', expected: 'a', points: 1 },
  { question: 'two', expected: 'b', points: 2 },
  { question: 'three', expected: 'c', points: 3 },
];

const trigger = (tableId: string, extra: Partial<WorkflowNode> = {}, parameters: DataObject = {}) =>
  node(
    'Dataset',
    EVALUATION_TRIGGER_TYPE,
    { source: 'dataTable', dataTableId: locator(tableId), ...parameters },
    [0, 0],
    extra,
  );
const evaluation = (name: string, parameters: DataObject, extra: Partial<WorkflowNode> = {}) =>
  node(name, EVALUATION_NODE_TYPE, parameters, [400, 0], extra);
const customMetrics = (name = 'Metrics', value: unknown = '={{ $json.points }}', type = 'number') =>
  evaluation(name, {
    operation: 'setMetrics',
    metric: 'customMetrics',
    metrics: { assignments: [assignment('score', value, type)] },
  });

/** Dataset -> Check If Evaluating -> (evaluation) Inputs -> Outputs -> Metrics; (normal) Normal */
function fullWorkflow(tableId: string) {
  return {
    nodes: [
      trigger(tableId),
      evaluation('Check', { operation: 'checkIfEvaluating' }),
      evaluation('Inputs', {
        operation: 'setInputs',
        inputs: { assignments: [assignment('question', '={{ $json.question }}')] },
      }),
      evaluation('Outputs', {
        operation: 'setOutputs',
        source: 'dataTable',
        dataTableId: locator(tableId),
        outputs: { assignments: [assignment('answer', '={{ "A: " + $json.question }}')] },
      }),
      customMetrics(),
      node('Normal', 'core.set', {
        mode: 'manual',
        assignments: { assignments: [assignment('ran', 'yes')] },
      }),
    ],
    connections: connect([
      link('Dataset', 'Check'),
      link('Check', 'Inputs', 0),
      link('Check', 'Normal', 1),
      link('Inputs', 'Outputs'),
      link('Outputs', 'Metrics'),
    ]),
  };
}

/** Dataset -> Probe (ms) -> Metrics */
function probeWorkflow(tableId: string, ms: number) {
  return {
    nodes: [trigger(tableId), node('Probe', 'test.evalProbe', { ms }, [200, 0]), customMetrics()],
    connections: connect([link('Dataset', 'Probe'), link('Probe', 'Metrics')]),
  };
}

const runs = (workflowId: string) => `/rest/workflows/${workflowId}/test-runs`;

async function startRun(client: TestClient, workflowId: string, body: DataObject = {}) {
  const res = await client.post(`${runs(workflowId)}/new`, body);
  expect(res.statusCode, res.body).toBe(202);
  return (res.json().data as { testRunId: string }).testRunId;
}

async function finished(client: TestClient, workflowId: string, runId: string, timeout = 30_000) {
  return waitFor(
    async () => {
      const run = await client.data<TestRunDto>(client.get(`${runs(workflowId)}/${runId}`));
      return run.status === 'new' || run.status === 'running' ? undefined : run;
    },
    { timeout, interval: 50, message: `test run ${runId} to finish` },
  );
}

async function casesOf(client: TestClient, workflowId: string, runId: string) {
  return client.data<TestCaseDto[]>(client.get(`${runs(workflowId)}/${runId}/test-cases`));
}

async function stateOf(tenantId: string, executionId: string) {
  return (await server.ctx.repos.executions.getData(tenantId, executionId))?.state as any;
}

// ---------------------------------------------------------------------------------------------

describe('a test run', () => {
  it('stores one case per row with its score, and the mean per metric (done when)', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS);
    const wf = await createWorkflow(owner.client, fullWorkflow(tableId));

    const runId = await startRun(owner.client, wf.id);
    const run = await finished(owner.client, wf.id, runId);
    expect(run).toMatchObject({
      status: 'completed',
      finalResult: 'success',
      errorCode: null,
      concurrency: 1,
      caseCounts: { success: 3, error: 0, cancelled: 0, new: 0, running: 0, total: 3 },
    });
    expect(run.metrics?.score).toBe(2);
    expect(run.metrics?.executionTime).toBeGreaterThanOrEqual(0);
    expect(run.runAt).not.toBeNull();
    expect(run.completedAt).not.toBeNull();

    const cases = await casesOf(owner.client, wf.id, runId);
    expect(cases.map((c) => [c.runIndex, c.status, c.metrics?.score])).toEqual([
      [0, 'success', 1],
      [1, 'success', 2],
      [2, 'success', 3],
    ]);
    expect(cases[1].inputs).toEqual({ question: 'two' });
    expect(cases[1].outputs).toEqual({ answer: 'A: two' });
    expect(cases.every((c) => typeof c.metrics?.executionTime === 'number')).toBe(true);
    // no model ran: no token metrics
    expect(cases[0].metrics).not.toHaveProperty('promptTokens');

    // each case is a saved execution of mode evaluation; Check If Evaluating skipped the normal branch
    const execution = await server.ctx.repos.executions.get(owner.tenant.id, cases[0].executionId!);
    expect(execution?.mode).toBe('evaluation');
    const state = await stateOf(owner.tenant.id, cases[0].executionId!);
    expect(state.resultData.runData.Metrics).toBeDefined();
    expect(state.resultData.runData.Normal).toBeUndefined();

    // side effects run for real: Set Outputs wrote the answers into the dataset
    const rows = await owner.client.data<{ data: DataObject[] }>(
      owner.client.get(`/rest/data-tables/${tableId}/rows?take=250`),
    );
    expect(rows.data.map((r) => r.answer).sort()).toEqual(['A: one', 'A: three', 'A: two']);

    // the list answers the editor's shape: an array, newest first
    const list = await owner.client.data<TestRunDto[]>(owner.client.get(runs(wf.id)));
    expect(list.map((r) => r.id)).toEqual([runId]);
  });

  it('runs only the chosen rows, keeping their dataset index', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS);
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 1));
    const runId = await startRun(owner.client, wf.id, { rowIndices: [2, 0, 2, 9] });
    const run = await finished(owner.client, wf.id, runId);
    expect(run.status).toBe('completed');
    const cases = await casesOf(owner.client, wf.id, runId);
    expect(cases.map((c) => [c.runIndex, c.metrics?.score])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(run.metrics?.score).toBe(2);
  });

  it('adds the token counts of the model sub-node runs', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 2));
    const wf = await createWorkflow(owner.client, {
      nodes: [
        trigger(tableId),
        evaluation('Judge', {
          operation: 'setMetrics',
          metric: 'correctness',
          expectedAnswer: '={{ $json.expected }}',
          actualAnswer: '={{ $json.question }}',
        }),
        node('Model', 'test.judgeModel', { score: 4 }, [400, 200]),
      ],
      connections: connect([link('Dataset', 'Judge'), link('Model', 'Judge', 0, 'ai_languageModel')]),
    });
    const runId = await startRun(owner.client, wf.id);
    const run = await finished(owner.client, wf.id, runId);
    expect(run.status).toBe('completed');
    const cases = await casesOf(owner.client, wf.id, runId);
    expect(cases[0].metrics).toMatchObject({
      Correctness: 4,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    expect(run.metrics).toMatchObject({
      Correctness: 4,
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });
});

describe('case errors', () => {
  it('FAILED_TO_EXECUTE_WORKFLOW keeps the node, a redacted message and the execution, never a stack', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 2));
    const secret = `sk-${'A1b2C3d4'.repeat(4)}`;
    const wf = await createWorkflow(owner.client, {
      nodes: [
        trigger(tableId),
        node('Boom', 'test.fail', { message: `Bad key ${secret}` }, [200, 0]),
        customMetrics(),
      ],
      connections: connect([link('Dataset', 'Boom'), link('Boom', 'Metrics')]),
    });
    const runId = await startRun(owner.client, wf.id);
    const run = await finished(owner.client, wf.id, runId);
    expect(run).toMatchObject({
      status: 'completed',
      finalResult: 'error',
      caseCounts: { error: 2, total: 2 },
    });
    // error cases still add the predefined metrics
    expect(run.metrics?.executionTime).toBeGreaterThanOrEqual(0);

    const res = await owner.client.get(`${runs(wf.id)}/${runId}/test-cases`);
    expect(res.body).not.toContain(secret);
    const cases = res.json().data as TestCaseDto[];
    expect(cases[0].errorCode).toBe('FAILED_TO_EXECUTE_WORKFLOW');
    expect(cases[0].errorDetails).toEqual({
      node: 'Boom',
      message: 'Bad key [redacted]',
      executionId: cases[0].executionId,
    });
    expect(JSON.stringify(cases)).not.toMatch(/stack/i);
    const stored = await server.ctx.repos.testRuns.listCases(owner.tenant.id, runId, {});
    expect(JSON.stringify(stored.rows)).not.toContain(secret);
    expect((await owner.client.get(`${runs(wf.id)}/${runId}`)).body).not.toContain(secret);
  });

  it('NO_METRICS_COLLECTED when no Set Metrics node ran', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 1));
    const wf = await createWorkflow(owner.client, {
      nodes: [trigger(tableId), evaluation('Check', { operation: 'checkIfEvaluating' }), customMetrics()],
      // the metrics sit on the normal branch, which an evaluation never takes
      connections: connect([link('Dataset', 'Check'), link('Check', 'Metrics', 1)]),
    });
    const runId = await startRun(owner.client, wf.id);
    const run = await finished(owner.client, wf.id, runId);
    expect(run.finalResult).toBe('error');
    const [only] = await casesOf(owner.client, wf.id, runId);
    expect(only).toMatchObject({ status: 'error', errorCode: 'NO_METRICS_COLLECTED' });
    expect(only.errorDetails).toEqual({ executionId: only.executionId });
  });

  it('INVALID_METRICS names the metric that is not a number', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 1));
    // the node continues on a failed metric: its error item reaches the runner
    const metrics = {
      ...customMetrics('Metrics', 'high', 'string'),
      onError: 'continueRegularOutput' as const,
    };
    const wf = await createWorkflow(owner.client, {
      nodes: [trigger(tableId), metrics],
      connections: connect([link('Dataset', 'Metrics')]),
    });
    const runId = await startRun(owner.client, wf.id);
    await finished(owner.client, wf.id, runId);
    const [only] = await casesOf(owner.client, wf.id, runId);
    expect(only).toMatchObject({ status: 'error', errorCode: 'INVALID_METRICS' });
    expect(only.errorDetails).toEqual({ metric: 'error', executionId: only.executionId });
  });
});

describe('validation', () => {
  async function failedWith(nodes: WorkflowNode[], connections: unknown, rows = ROWS) {
    const owner = await signup();
    const tableId = await makeDataset(owner, rows);
    const wf = await createWorkflow(owner.client, {
      nodes: nodes.map((n) =>
        n.name === 'Dataset'
          ? {
              ...n,
              parameters: { ...n.parameters, dataTableId: n.parameters.dataTableId ?? locator(tableId) },
            }
          : n,
      ),
      connections,
    });
    const runId = await startRun(owner.client, wf.id);
    const run = await finished(owner.client, wf.id, runId);
    expect(run.status).toBe('error');
    expect(run.finalResult).toBeNull();
    return { run, owner, wf, tableId };
  }
  /** the trigger; `failedWith` points it at the dataset unless `parameters` names a table */
  const dataset = (extra: Partial<WorkflowNode> = {}, parameters: DataObject = {}) =>
    node('Dataset', EVALUATION_TRIGGER_TYPE, { source: 'dataTable', ...parameters }, [0, 0], extra);
  const toMetrics = connect([link('Dataset', 'Metrics')]);

  it('a workflow without an evaluation trigger is refused with 409', async () => {
    const owner = await signup();
    const wf = await createWorkflow(owner.client, {
      nodes: [node('Start', 'core.manualTrigger'), customMetrics()],
    });
    const res = await owner.client.post(`${runs(wf.id)}/new`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      message: 'Workflow has no evaluation trigger',
      details: { code: 'EVALUATION_TRIGGER_NOT_FOUND' },
    });
    expect(await server.ctx.repos.testRuns.list(owner.tenant.id, wf.id, {})).toEqual({ count: 0, rows: [] });
  });

  it('EVALUATION_TRIGGER_NOT_CONFIGURED names the trigger', async () => {
    const { run } = await failedWith([dataset({}, { dataTableId: locator('') }), customMetrics()], toMetrics);
    expect(run).toMatchObject({
      errorCode: 'EVALUATION_TRIGGER_NOT_CONFIGURED',
      errorDetails: { node: 'Dataset' },
    });
  });

  it('EVALUATION_TRIGGER_DISABLED', async () => {
    const { run } = await failedWith([dataset({ disabled: true }), customMetrics()], toMetrics);
    expect(run).toMatchObject({
      errorCode: 'EVALUATION_TRIGGER_DISABLED',
      errorDetails: { node: 'Dataset' },
    });
  });

  it('SET_OUTPUTS_NODE_NOT_CONFIGURED names the node', async () => {
    const outputs = evaluation('Outputs', { operation: 'setOutputs', outputs: { assignments: [] } });
    const { run } = await failedWith(
      [dataset(), outputs, customMetrics()],
      connect([link('Dataset', 'Outputs'), link('Outputs', 'Metrics')]),
    );
    expect(run).toMatchObject({
      errorCode: 'SET_OUTPUTS_NODE_NOT_CONFIGURED',
      errorDetails: { node: 'Outputs' },
    });
  });

  it('SET_METRICS_NODE_NOT_FOUND, also when the only one is disabled', async () => {
    const { run } = await failedWith([dataset(), { ...customMetrics(), disabled: true }], toMetrics);
    expect(run).toMatchObject({ errorCode: 'SET_METRICS_NODE_NOT_FOUND', errorDetails: null });
  });

  it('SET_METRICS_NODE_NOT_CONFIGURED: no metrics, or an AI metric with no model', async () => {
    const empty = evaluation('Metrics', {
      operation: 'setMetrics',
      metric: 'customMetrics',
      metrics: { assignments: [] },
    });
    const first = await failedWith([dataset(), empty], toMetrics);
    expect(first.run).toMatchObject({
      errorCode: 'SET_METRICS_NODE_NOT_CONFIGURED',
      errorDetails: { node: 'Metrics' },
    });
    const judge = evaluation('Metrics', { operation: 'setMetrics', metric: 'helpfulness' });
    const second = await failedWith([dataset(), judge], toMetrics);
    expect(second.run.errorCode).toBe('SET_METRICS_NODE_NOT_CONFIGURED');
  });

  it('CANT_FETCH_TEST_CASES carries the trigger and its message', async () => {
    const missing = randomUUID();
    const { run } = await failedWith(
      [dataset({}, { dataTableId: locator(missing) }), customMetrics()],
      toMetrics,
    );
    expect(run.errorCode).toBe('CANT_FETCH_TEST_CASES');
    expect(run.errorDetails?.node).toBe('Dataset');
    expect(String(run.errorDetails?.message)).toContain(missing);
    expect(run.caseCounts.total).toBe(0);
  });

  it('TEST_CASES_NOT_FOUND for an empty dataset', async () => {
    const { run } = await failedWith([dataset(), customMetrics()], toMetrics, []);
    expect(run).toMatchObject({ errorCode: 'TEST_CASES_NOT_FOUND', errorDetails: null });
  });
});

describe('concurrency', () => {
  it('runs at most the workspace limit at once, whatever the run asks', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, [...ROWS, ...ROWS]);
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 300));
    const runId = await startRun(owner.client, wf.id, { concurrency: 10 });
    const run = await finished(owner.client, wf.id, runId);
    expect(run).toMatchObject({ status: 'completed', concurrency: 3, caseCounts: { success: 6 } });
    expect(probe.peak).toBe(3);
  });

  it('two runs of one workspace share the pool', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, [...ROWS, ...ROWS]);
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 300));
    const [a, b] = await Promise.all([
      startRun(owner.client, wf.id, { concurrency: 3 }),
      startRun(owner.client, wf.id, { concurrency: 3 }),
    ]);
    const done = await Promise.all([finished(owner.client, wf.id, a), finished(owner.client, wf.id, b)]);
    expect(done.map((r) => r.caseCounts.success)).toEqual([6, 6]);
    expect(probe.peak).toBe(3);
  });

  it('a run asks for fewer cases at once than the limit', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, [...ROWS, ...ROWS]);
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 150));
    const runId = await startRun(owner.client, wf.id, { concurrency: 2 });
    await finished(owner.client, wf.id, runId);
    expect(probe.peak).toBe(2);
  });

  it("the plan's concurrent execution limit does not block a run", async () => {
    const owner = await signup();
    await server.ctx.repos.tenants.updateSettings(owner.tenant.id, { limits: { concurrentExecutions: 1 } });
    const tableId = await makeDataset(owner, ROWS);
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 200));
    const runId = await startRun(owner.client, wf.id, { concurrency: 3 });
    const run = await finished(owner.client, wf.id, runId);
    expect(run).toMatchObject({ status: 'completed', caseCounts: { success: 3 } });
    expect(probe.peak).toBe(3);
  });

  it("running cases do not use up the plan's concurrent limit", async () => {
    const owner = await signup();
    await server.ctx.repos.tenants.updateSettings(owner.tenant.id, { limits: { concurrentExecutions: 1 } });
    const tableId = await makeDataset(owner, ROWS.slice(0, 1));
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 1500));
    const manual = await createWorkflow(owner.client, {
      nodes: [node('Start', 'core.manualTrigger')],
      connections: {},
    });
    const runId = await startRun(owner.client, wf.id, { concurrency: 1 });
    await waitFor(async () => probe.inFlight > 0, { message: 'a case to be running' });
    // a manual run still starts while the case holds the plan's only slot
    const res = await owner.client.post(`/rest/workflows/${manual.id}/run`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await finished(owner.client, wf.id, runId)).status).toBe('completed');
  });

  it('a worker that fails stops the other workers before the run fails', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS);
    // the first case ends at once and its result cannot be read; the second is still running
    const definition = probeWorkflow(tableId, 1);
    definition.nodes[1].parameters = { ms: '={{ $json.points === 1 ? 20 : 3000 }}' };
    const wf = await createWorkflow(owner.client, definition);
    const repo = server.ctx.repos.executions;
    const getData = repo.getData;
    let thrown = false;
    repo.getData = async (...args) => {
      // only the runner's read of a finished case fails
      if (thrown || !new Error().stack?.includes('runCase')) return getData.apply(repo, args);
      thrown = true;
      throw new Error('database down');
    };
    try {
      const runId = await startRun(owner.client, wf.id, { concurrency: 2 });
      const run = await finished(owner.client, wf.id, runId);
      // the slow case of the other worker was stopped, not left running past the end of the run
      expect(probe.inFlight).toBe(0);
      expect(run).toMatchObject({ status: 'error', errorCode: 'UNKNOWN_ERROR' });
      expect(thrown).toBe(true);
      const cases = await casesOf(owner.client, wf.id, runId);
      expect(cases.map((c) => c.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    } finally {
      repo.getData = getData;
    }
  });
});

describe('access', () => {
  it('viewers read, editors run, cancel and delete', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 1));
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 1));
    const runId = await startRun(owner.client, wf.id);
    await finished(owner.client, wf.id, runId);
    const [first] = await casesOf(owner.client, wf.id, runId);

    // a project viewer holds workflow:read only: 3 reads pass, 4 writes are refused
    const viewer = await member(owner, 'project:viewer');
    const viewerReads = await Promise.all([
      viewer.get(runs(wf.id)),
      viewer.get(`${runs(wf.id)}/${runId}`),
      viewer.get(`${runs(wf.id)}/${runId}/test-cases`),
    ]);
    expect(viewerReads.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const viewerWrites = await Promise.all([
      viewer.post(`${runs(wf.id)}/new`, {}),
      viewer.post(`${runs(wf.id)}/${runId}/cancel`),
      viewer.post(`${runs(wf.id)}/${runId}/test-cases/${first.id}/cancel`),
      viewer.delete(`${runs(wf.id)}/${runId}`),
    ]);
    expect(viewerWrites.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);

    // a project editor holds workflow:execute: the 4 writes pass the gate (409 is the run's own state)
    const editor = await member(owner, 'project:editor');
    const editorRun = await startRun(editor, wf.id);
    await finished(editor, wf.id, editorRun);
    // finished runs cannot be cancelled; a finished case cannot be cancelled
    const cancel = await editor.post(`${runs(wf.id)}/${editorRun}/cancel`);
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.message).toBe(`The test run "${editorRun}" cannot be cancelled`);
    expect((await editor.post(`${runs(wf.id)}/${runId}/test-cases/${first.id}/cancel`)).statusCode).toBe(409);
    expect((await editor.delete(`${runs(wf.id)}/${editorRun}`)).statusCode).toBe(200);
    expect((await editor.get(`${runs(wf.id)}/${editorRun}`)).statusCode).toBe(404);
  });

  it('another workspace and another workflow read as not found', async () => {
    const owner = await signup();
    const tableId = await makeDataset(owner, ROWS.slice(0, 1));
    const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 1));
    const other = await createWorkflow(owner.client, probeWorkflow(tableId, 1));
    const runId = await startRun(owner.client, wf.id);
    await finished(owner.client, wf.id, runId);
    const [first] = await casesOf(owner.client, wf.id, runId);

    // a run of another workflow of the same workspace
    expect((await owner.client.get(`${runs(other.id)}/${runId}`)).statusCode).toBe(404);
    expect((await owner.client.get(`${runs(other.id)}/${runId}/test-cases`)).statusCode).toBe(404);
    expect((await owner.client.delete(`${runs(other.id)}/${runId}`)).statusCode).toBe(404);

    const stranger = await signup();
    const c = stranger.client;
    expect((await c.get(runs(wf.id))).statusCode).toBe(404);
    expect((await c.get(`${runs(wf.id)}/${runId}`)).statusCode).toBe(404);
    expect((await c.get(`${runs(wf.id)}/${runId}/test-cases`)).statusCode).toBe(404);
    expect((await c.post(`${runs(wf.id)}/new`, {})).statusCode).toBe(404);
    expect((await c.post(`${runs(wf.id)}/${runId}/cancel`)).statusCode).toBe(404);
    expect((await c.post(`${runs(wf.id)}/${runId}/test-cases/${first.id}/cancel`)).statusCode).toBe(404);
    expect((await c.delete(`${runs(wf.id)}/${runId}`)).statusCode).toBe(404);
    expect((await owner.client.get(`${runs(wf.id)}/${runId}`)).statusCode).toBe(200);
  });

  it('row level security shows a workspace only its own runs and cases', async () => {
    const a = await signup();
    const b = await signup();
    for (const owner of [a, b]) {
      const tableId = await makeDataset(owner, ROWS.slice(0, 1));
      const wf = await createWorkflow(owner.client, probeWorkflow(tableId, 1));
      await finished(owner.client, wf.id, await startRun(owner.client, wf.id));
    }
    const pool = server.ctx.database.pool;
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool.query('GRANT SELECT ON test_runs, test_case_executions TO workflow_rls_probe');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenant.id]);
      for (const table of ['test_runs', 'test_case_executions']) {
        const { rows } = await client.query(`SELECT DISTINCT tenant_id FROM ${table}`);
        expect(rows).toEqual([{ tenant_id: a.tenant.id }]);
      }
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
