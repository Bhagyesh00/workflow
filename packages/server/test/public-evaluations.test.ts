/** Public API evaluation test runs (P5-12): scopes, roles, tenant isolation and cursor paging. */
import { randomUUID } from 'node:crypto';
import { type DataObject, EVALUATION_NODE_TYPE, EVALUATION_TRIGGER_TYPE } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
  waitFor,
} from './helpers';

let server: TestServer;
beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const locator = (value: string) => ({ __rl: true, mode: 'id', value });
const assignment = (name: string, value: unknown, type = 'string') => ({
  id: randomUUID(),
  name,
  value,
  type,
});

type Owner = Awaited<ReturnType<typeof signup>>;
const newOwner = () =>
  signup(server.app, {
    remoteAddress: `10.62.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  });

async function keyFor(owner: Owner, scopes: string[]) {
  const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k', scopes }));
  return key.key as string;
}

async function viewerKey(owner: Owner, scopes: string[]) {
  const { client: viewer } = await memberAs(owner, 'viewer', { name: 'V' });
  const key = await viewer.data(viewer.post('/rest/api-keys', { name: 'v', scopes }));
  return key.key as string;
}

const api = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

const ALL = ['testRun:list', 'testRun:create', 'testRun:read', 'testRun:cancel'];
const runs = (workflowId: string) => `/workflows/${workflowId}/test-runs`;

/** a Data table dataset and Dataset -> Check -> Inputs -> Metrics */
async function evalWorkflow(owner: Owner, rowCount = 3) {
  const table = await owner.client.data<{ id: string }>(
    owner.client.post('/rest/data-tables', {
      name: `Dataset ${randomUUID().slice(0, 6)}`,
      columns: [
        { name: 'question', type: 'string' },
        { name: 'points', type: 'number' },
      ],
    }),
  );
  const rows: DataObject[] = Array.from({ length: rowCount }, (_, i) => ({
    question: `q${i}`,
    points: i + 1,
  }));
  await owner.client.data(owner.client.post(`/rest/data-tables/${table.id}/insert`, { data: rows }));
  const evaluation = (name: string, parameters: DataObject) =>
    node(name, EVALUATION_NODE_TYPE, parameters, [400, 0]);
  return createWorkflow(owner.client, {
    nodes: [
      node(
        'Dataset',
        EVALUATION_TRIGGER_TYPE,
        { source: 'dataTable', dataTableId: locator(table.id) },
        [0, 0],
      ),
      evaluation('Check', { operation: 'checkIfEvaluating' }),
      evaluation('Inputs', {
        operation: 'setInputs',
        inputs: { assignments: [assignment('question', '={{ $json.question }}')] },
      }),
      evaluation('Metrics', {
        operation: 'setMetrics',
        metric: 'customMetrics',
        metrics: { assignments: [assignment('score', '={{ $json.points }}', 'number')] },
      }),
    ],
    connections: {
      Dataset: { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
      Check: { main: [[{ node: 'Inputs', type: 'main', index: 0 }], []] },
      Inputs: { main: [[{ node: 'Metrics', type: 'main', index: 0 }]] },
    },
  });
}

async function finished(key: string, workflowId: string, runId: string) {
  return waitFor(
    async () => {
      const res = await api(key, 'GET', `${runs(workflowId)}/${runId}`);
      const data = res.json().data as { status: string };
      return data.status === 'new' || data.status === 'running' ? undefined : data;
    },
    { timeout: 30_000, interval: 50, message: 'the test run to finish' },
  );
}

describe('public API test runs', () => {
  it('starts a run with a scoped key and reads its result and cases', async () => {
    const owner = await newOwner();
    const key = await keyFor(owner, ALL);
    const wf = await evalWorkflow(owner);
    const created = await api(key, 'POST', runs(wf.id), {});
    expect(created.statusCode, created.body).toBe(201);
    const run = created.json().data as { id: string; workflowId: string };
    expect(run.workflowId).toBe(wf.id);
    const done = await finished(key, wf.id, run.id);
    expect(done.status).toBe('completed');
    const cases = (await api(key, 'GET', `${runs(wf.id)}/${run.id}/test-cases`)).json();
    expect(cases.data.map((c: { runIndex: number; status: string }) => [c.runIndex, c.status])).toEqual([
      [0, 'success'],
      [1, 'success'],
      [2, 'success'],
    ]);
    expect(cases.nextCursor).toBeNull();
    const listed = (await api(key, 'GET', runs(wf.id))).json();
    expect(listed.data.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect((await api(key, 'GET', `${runs(wf.id)}?status=error`)).json().data).toEqual([]);
  });

  it('answers 409 for a workflow without an evaluation trigger', async () => {
    const owner = await newOwner();
    const key = await keyFor(owner, ALL);
    const wf = await createWorkflow(owner.client, {
      nodes: [node('Set', 'core.set', { mode: 'manual', assignments: { assignments: [] } })],
    });
    const res = await api(key, 'POST', runs(wf.id), {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('Workflow has no evaluation trigger');
  });

  it('refuses a key without the scope with 403', async () => {
    const owner = await newOwner();
    const wf = await evalWorkflow(owner, 1);
    const none = await keyFor(owner, ['workflow:list']);
    expect((await api(none, 'GET', runs(wf.id))).statusCode).toBe(403);
    expect((await api(none, 'POST', runs(wf.id), {})).statusCode).toBe(403);
    const listOnly = await keyFor(owner, ['testRun:list']);
    expect((await api(listOnly, 'GET', runs(wf.id))).statusCode).toBe(200);
    expect((await api(listOnly, 'POST', runs(wf.id), {})).statusCode).toBe(403);
    expect((await api(listOnly, 'GET', `${runs(wf.id)}/${randomUUID()}`)).statusCode).toBe(403);
  });

  it('keeps a viewer key from starting or cancelling a run', async () => {
    const owner = await newOwner();
    const wf = await evalWorkflow(owner, 1);
    const key = await viewerKey(owner, ALL);
    expect((await api(key, 'POST', runs(wf.id), {})).statusCode).toBe(403);
    expect((await api(key, 'POST', `${runs(wf.id)}/${randomUUID()}/cancel`)).statusCode).toBe(403);
    expect((await api(key, 'GET', runs(wf.id))).statusCode).toBe(200);
  });

  it('refuses a member key on a workflow of a project the user is not in, with the key scopes held (P6-34)', async () => {
    const owner = await newOwner();
    const wf = await evalWorkflow(owner, 1);
    const member = await realMember(owner, { name: 'M' });
    const made = await member.client.data(member.client.post('/rest/api-keys', { name: 'm', scopes: ALL }));
    const key = made.key as string;
    expect((await api(key, 'POST', runs(wf.id), {})).statusCode).toBe(403);
    expect((await api(key, 'GET', runs(wf.id))).statusCode).toBe(403);
    expect((await api(key, 'POST', `${runs(wf.id)}/${randomUUID()}/cancel`)).statusCode).toBe(403);
  });

  it('answers 404 for another tenant workflow and run', async () => {
    const a = await newOwner();
    const wf = await evalWorkflow(a, 1);
    const keyA = await keyFor(a, ALL);
    const runId = (await api(keyA, 'POST', runs(wf.id), {})).json().data.id as string;
    const b = await newOwner();
    const keyB = await keyFor(b, ALL);
    expect((await api(keyB, 'GET', runs(wf.id))).statusCode).toBe(404);
    expect((await api(keyB, 'POST', runs(wf.id), {})).statusCode).toBe(404);
    expect((await api(keyB, 'GET', `${runs(wf.id)}/${runId}`)).statusCode).toBe(404);
    expect((await api(keyB, 'GET', `${runs(wf.id)}/${runId}/test-cases`)).statusCode).toBe(404);
    expect((await api(keyB, 'POST', `${runs(wf.id)}/${runId}/cancel`)).statusCode).toBe(404);
  });

  it('pages runs and cases by cursor and refuses a bad cursor', async () => {
    const owner = await newOwner();
    const key = await keyFor(owner, ALL);
    const wf = await evalWorkflow(owner, 3);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = (await api(key, 'POST', runs(wf.id), {})).json().data.id as string;
      ids.push(id);
      await finished(key, wf.id, id);
    }
    const first = (await api(key, 'GET', `${runs(wf.id)}?limit=2`)).json();
    expect(first.data).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');
    const second = (await api(key, 'GET', `${runs(wf.id)}?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect([...first.data, ...second.data].map((r: { id: string }) => r.id).sort()).toEqual([...ids].sort());
    const c1 = (await api(key, 'GET', `${runs(wf.id)}/${ids[0]}/test-cases?limit=2`)).json();
    expect(c1.data.map((c: { runIndex: number }) => c.runIndex)).toEqual([0, 1]);
    const c2 = (
      await api(key, 'GET', `${runs(wf.id)}/${ids[0]}/test-cases?limit=2&cursor=${c1.nextCursor}`)
    ).json();
    expect(c2.data.map((c: { runIndex: number }) => c.runIndex)).toEqual([2]);
    expect(c2.nextCursor).toBeNull();
    expect((await api(key, 'GET', `${runs(wf.id)}?cursor=nope`)).statusCode).toBe(400);
  });

  it('cancels a finished run with 409 and an unknown run with 404', async () => {
    const owner = await newOwner();
    const key = await keyFor(owner, ALL);
    const wf = await evalWorkflow(owner, 1);
    const id = (await api(key, 'POST', runs(wf.id), {})).json().data.id as string;
    await finished(key, wf.id, id);
    expect((await api(key, 'POST', `${runs(wf.id)}/${id}/cancel`)).statusCode).toBe(409);
    expect((await api(key, 'POST', `${runs(wf.id)}/${randomUUID()}/cancel`)).statusCode).toBe(404);
  });
});
