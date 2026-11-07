/**
 * P5-02 evaluation runner: cancel a run (flag, local abort, bus), cancel one case, delete, and the sweep of
 * runs a stopped main left behind, in regular and queue mode. Real Evaluation nodes and a Data table.
 */
import { randomUUID } from 'node:crypto';
import {
  type DataObject,
  EVALUATION_NODE_TYPE,
  EVALUATION_TRIGGER_TYPE,
  type NodePackage,
  type TestCaseDto,
  type TestRunDto,
} from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/context';
import { EvaluationService } from '../src/services/evaluations';
import {
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup as signupFrom,
  type TestClient,
  type TestServer,
  waitFor,
} from './helpers';

const slowPackage: NodePackage = {
  name: 'evaluation-cancel-tests',
  credentials: [],
  nodes: [
    {
      description: {
        name: 'test.evalSlow',
        displayName: 'Slow',
        description: '',
        group: ['transform'],
        version: 1,
        defaults: { name: 'Slow' },
        inputs: ['main'],
        outputs: ['main'],
        properties: [{ displayName: 'Milliseconds', name: 'ms', type: 'number', default: 1000 }],
      },
      async execute(ctx) {
        const ms = Number(ctx.getNodeParameter('ms', 0, 1000));
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
        return [ctx.getInputData()];
      },
    },
  ],
};

let server: TestServer;
const signup = () =>
  signupFrom(server.app, {
    remoteAddress: `10.53.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });
type Owner = Awaited<ReturnType<typeof signup>>;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000', CONCURRENCY_EVALUATION_LIMIT: '5' },
    { nodePackages: [slowPackage] },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const locator = (value: string) => ({ __rl: true, mode: 'id', value });

async function slowWorkflow(owner: Owner, rows: number, ms: number) {
  const table = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/data-tables', {
      name: `Dataset ${randomUUID().slice(0, 6)}`,
      columns: [{ name: 'points', type: 'number' }],
    }),
  );
  await owner.client.data(
    owner.client.post(`/rest/data-tables/${table.id}/insert`, {
      data: Array.from({ length: rows }, (_, i) => ({ points: i + 1 })),
    }),
  );
  return createWorkflow(owner.client, {
    nodes: [
      node('Dataset', EVALUATION_TRIGGER_TYPE, { source: 'dataTable', dataTableId: locator(table.id) }),
      node('Slow', 'test.evalSlow', { ms }, [200, 0]),
      node(
        'Metrics',
        EVALUATION_NODE_TYPE,
        {
          operation: 'setMetrics',
          metric: 'customMetrics',
          metrics: {
            assignments: [{ id: randomUUID(), name: 'score', value: '={{ $json.points }}', type: 'number' }],
          },
        },
        [400, 0],
      ),
    ],
    connections: {
      Dataset: { main: [[{ node: 'Slow', type: 'main', index: 0 }]] },
      Slow: { main: [[{ node: 'Metrics', type: 'main', index: 0 }]] },
    },
  });
}

const runs = (workflowId: string) => `/rest/workflows/${workflowId}/test-runs`;

async function startRun(client: TestClient, workflowId: string, body: DataObject = {}) {
  const res = await client.post(`${runs(workflowId)}/new`, body);
  expect(res.statusCode, res.body).toBe(202);
  return (res.json().data as { testRunId: string }).testRunId;
}

const getRun = (client: TestClient, workflowId: string, runId: string) =>
  client.data<TestRunDto>(client.get(`${runs(workflowId)}/${runId}`));
const casesOf = (client: TestClient, workflowId: string, runId: string) =>
  client.data<TestCaseDto[]>(client.get(`${runs(workflowId)}/${runId}/test-cases`));

async function until(check: () => Promise<boolean>, message: string, timeout = 20_000) {
  await waitFor(async () => (await check()) || undefined, { timeout, interval: 30, message });
}

async function runningCases(client: TestClient, workflowId: string, runId: string, n: number) {
  await until(async () => {
    const cases = await casesOf(client, workflowId, runId);
    return cases.filter((c) => c.status === 'running' && c.executionId).length >= n;
  }, `${n} running cases`);
}

/** in-flight cases have closed (the runner has let go of the run) */
async function settled(client: TestClient, workflowId: string, runId: string) {
  await until(
    async () =>
      (await casesOf(client, workflowId, runId)).every((c) => c.status !== 'running' && c.status !== 'new'),
    'cases to settle',
  );
}

describe('cancel a run', () => {
  it('stops the cases in flight and cancels the pending ones', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 5, 20_000);
    const runId = await startRun(owner.client, wf.id, { concurrency: 2 });
    await runningCases(owner.client, wf.id, runId, 2);

    const res = await owner.client.post(`${runs(wf.id)}/${runId}/cancel`);
    expect(res.statusCode, res.body).toBe(202);
    expect((await getRun(owner.client, wf.id, runId)).status).toBe('cancelled');
    await settled(owner.client, wf.id, runId);

    const run = await getRun(owner.client, wf.id, runId);
    expect(run).toMatchObject({
      status: 'cancelled',
      finalResult: null,
      metrics: null,
      caseCounts: { cancelled: 5, success: 0, error: 0, total: 5 },
    });
    // the two executions in flight were stopped, not left running
    const cases = await casesOf(owner.client, wf.id, runId);
    const started = cases.filter((c) => c.executionId);
    expect(started).toHaveLength(2);
    for (const c of started) {
      const execution = await server.ctx.repos.executions.get(owner.tenant.id, c.executionId!);
      expect(execution?.status).toBe('canceled');
    }

    // a finished run cannot be cancelled again
    const again = await owner.client.post(`${runs(wf.id)}/${runId}/cancel`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe(`The test run "${runId}" cannot be cancelled`);
  });

  it('another main stops its run when the cancel arrives over the bus', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 3, 20_000);
    const runId = await startRun(owner.client, wf.id);
    await runningCases(owner.client, wf.id, runId, 1);
    // what the main that took the cancel request does: flag, status, then the broadcast (ids only)
    await server.ctx.repos.testRuns.requestCancel(owner.tenant.id, runId);
    await server.ctx.repos.testRuns.update(owner.tenant.id, runId, {
      status: 'cancelled',
      completedAt: new Date(),
    });
    await server.ctx.bus.publish('control', { type: 'cancelTestRun', testRunId: runId });
    await settled(owner.client, wf.id, runId);
    const run = await getRun(owner.client, wf.id, runId);
    expect(run).toMatchObject({ status: 'cancelled', caseCounts: { cancelled: 3, total: 3 } });
  });

  it('a cancel flag the bus did not carry is seen at the next case', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 3, 600);
    const runId = await startRun(owner.client, wf.id);
    await runningCases(owner.client, wf.id, runId, 1);
    // only the flag: no bus message reaches this main
    await server.ctx.repos.testRuns.requestCancel(owner.tenant.id, runId);
    await settled(owner.client, wf.id, runId);
    const run = await getRun(owner.client, wf.id, runId);
    expect(run.status).toBe('cancelled');
    const cases = await casesOf(owner.client, wf.id, runId);
    expect(cases.map((c) => c.status)).toEqual(['success', 'cancelled', 'cancelled']);
  });
});

describe('cancel one case, delete a run', () => {
  it('only a pending case can be cancelled; the run goes on without it', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 3, 700);
    const runId = await startRun(owner.client, wf.id);
    await runningCases(owner.client, wf.id, runId, 1);
    const cases = await casesOf(owner.client, wf.id, runId);
    const running = cases.find((c) => c.status === 'running')!;
    const pending = cases.find((c) => c.status === 'new')!;

    const refused = await owner.client.post(`${runs(wf.id)}/${runId}/test-cases/${running.id}/cancel`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toBe(`The test case "${running.id}" cannot be cancelled`);
    const ok = await owner.client.post(`${runs(wf.id)}/${runId}/test-cases/${pending.id}/cancel`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toEqual({ ok: true });
    expect(
      (await owner.client.post(`${runs(wf.id)}/${runId}/test-cases/${randomUUID()}/cancel`)).statusCode,
    ).toBe(404);

    // a running run cannot be deleted
    const del = await owner.client.delete(`${runs(wf.id)}/${runId}`);
    expect(del.statusCode).toBe(409);

    await until(
      async () => (await getRun(owner.client, wf.id, runId)).status === 'completed',
      'run to complete',
    );
    const run = await getRun(owner.client, wf.id, runId);
    expect(run).toMatchObject({ finalResult: 'success', caseCounts: { success: 2, cancelled: 1, total: 3 } });
    const after = await casesOf(owner.client, wf.id, runId);
    expect(after.find((c) => c.id === pending.id)).toMatchObject({ status: 'cancelled', executionId: null });

    // a finished run deletes with its cases
    expect((await owner.client.delete(`${runs(wf.id)}/${runId}`)).statusCode).toBe(200);
    expect((await server.ctx.repos.testRuns.listCases(owner.tenant.id, runId, {})).count).toBe(0);
  });
});

describe('the sweep of runs a stopped main left behind', () => {
  /** a run left 'running' with one case per status it can be in */
  async function leftBehind(owner: Owner, workflowId: string) {
    const { testRuns } = server.ctx.repos;
    const run = await testRuns.create(owner.tenant.id, { workflowId, status: 'running' });
    const [a, b, c] = await testRuns.seedCases(owner.tenant.id, run.id, 3);
    await testRuns.updateCase(owner.tenant.id, a.id, { status: 'success', metrics: { score: 1 } });
    await testRuns.updateCase(owner.tenant.id, b.id, { status: 'running' });
    return { run, cases: [a, b, c] };
  }

  async function caseStatuses(tenantId: string, runId: string) {
    const { rows } = await server.ctx.repos.testRuns.listCases(tenantId, runId, {});
    return rows.map((r) => r.status);
  }

  it('regular mode closes every unfinished run as INTERRUPTED and cancels its unfinished cases', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 1, 1);
    const { run } = await leftBehind(owner, wf.id);
    const fresh = await server.ctx.repos.testRuns.create(owner.tenant.id, { workflowId: wf.id });
    const done = await server.ctx.repos.testRuns.create(owner.tenant.id, {
      workflowId: wf.id,
      status: 'completed',
    });

    expect(await server.ctx.evaluations.sweepInterrupted()).toBe(2);
    const swept = await getRun(owner.client, wf.id, run.id);
    expect(swept).toMatchObject({ status: 'error', errorCode: 'INTERRUPTED', finalResult: null });
    expect(swept.completedAt).not.toBeNull();
    expect(await caseStatuses(owner.tenant.id, run.id)).toEqual(['success', 'cancelled', 'cancelled']);
    expect((await getRun(owner.client, wf.id, fresh.id)).errorCode).toBe('INTERRUPTED');
    expect((await getRun(owner.client, wf.id, done.id)).status).toBe('completed');
  });

  it('queue mode closes only runs no main touched for 5 minutes', async () => {
    const owner = await signup();
    const wf = await slowWorkflow(owner, 1, 1);
    const stale = await leftBehind(owner, wf.id);
    const alive = await leftBehind(owner, wf.id);
    await server.ctx.database.pool.query(
      `UPDATE test_runs SET updated_at = now() - interval '10 minutes' WHERE tenant_id = $1 AND id = $2`,
      [owner.tenant.id, stale.run.id],
    );
    const { ctx } = server;
    const deps: ServiceDeps = {
      config: { ...ctx.config, executionsMode: 'queue' },
      database: ctx.database,
      repos: ctx.repos,
      logger: ctx.logger,
      context: () => ctx,
    };
    expect(await new EvaluationService(deps).sweepInterrupted()).toBe(1);
    expect((await getRun(owner.client, wf.id, stale.run.id)).errorCode).toBe('INTERRUPTED');
    expect(await caseStatuses(owner.tenant.id, stale.run.id)).toEqual(['success', 'cancelled', 'cancelled']);
    expect((await getRun(owner.client, wf.id, alive.run.id)).status).toBe('running');
    expect(await caseStatuses(owner.tenant.id, alive.run.id)).toEqual(['success', 'running', 'new']);
  });
});
