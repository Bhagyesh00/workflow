import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

/** runs a workflow that saves the pairs as highlighted data; returns the execution id */
async function runSaving(
  who: { client: TestClient; tenant: { id: string } },
  pairs: Record<string, string>,
): Promise<string> {
  const { client } = who;
  const wf = await createWorkflow(client, {
    nodes: [
      node('Start', 'core.manualTrigger'),
      node('Save', 'core.executionData', {
        operation: 'save',
        dataToSave: { values: Object.entries(pairs).map(([key, value]) => ({ key, value })) },
      }),
    ],
    connections: chain('Start', 'Save'),
  });
  const { executionId } = await client.data<{ executionId: string }>(
    client.post(`/rest/workflows/${wf.id}/run`, {}),
  );
  await waitForExecution(server.ctx, who.tenant.id, executionId);
  return executionId;
}

async function ids(client: TestClient, query: string): Promise<string[]> {
  const res = await client.request('GET', `/rest/executions?${query}`);
  expect(res.statusCode).toBe(200);
  return (res.json().data as Array<{ id: string }>).map((e) => e.id).sort();
}

describe('executions filter by highlighted data (P5-61)', () => {
  it('shows the saved keys on the execution and filters exact and partial', async () => {
    const a = await signup(server.app);
    const one = await runSaving(a, { orderId: '1042', channel: 'web' });
    const two = await runSaving(a, { orderId: '1042-b' });
    const three = await runSaving(a, { other: 'x' });

    const detail = await a.client.data<{ customData: Record<string, string> }>(
      a.client.get(`/rest/executions/${one}`),
    );
    expect(detail.customData).toEqual({ orderId: '1042', channel: 'web' });

    expect(await ids(a.client, 'customDataKey=orderId')).toEqual([one, two].sort());
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=1042')).toEqual([one, two].sort());
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=1042&customDataExact=true')).toEqual([
      one,
    ]);
    expect(await ids(a.client, 'customDataKey=orderId&customDataValue=WEB')).toEqual([]);
    expect(await ids(a.client, 'customDataKey=other')).toEqual([three]);
    expect(await ids(a.client, 'customDataKey=missing')).toEqual([]);
  });

  it('matches % and _ and backslash in a value literally', async () => {
    const a = await signup(server.app);
    const pct = await runSaving(a, { note: '50% off' });
    await runSaving(a, { note: '500 off' });
    const under = await runSaving(a, { note: 'a_b' });
    await runSaving(a, { note: 'axb' });
    const back = await runSaving(a, { note: 'c\\d' });

    expect(await ids(a.client, `customDataKey=note&customDataValue=${encodeURIComponent('%')}`)).toEqual([
      pct,
    ]);
    expect(await ids(a.client, `customDataKey=note&customDataValue=${encodeURIComponent('_')}`)).toEqual([
      under,
    ]);
    expect(await ids(a.client, `customDataKey=note&customDataValue=${encodeURIComponent('\\')}`)).toEqual([
      back,
    ]);
  });

  it('never lists another tenant run and treats a hostile key as data', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    await runSaving(b, { orderId: '1042' });
    const mine = await runSaving(a, { orderId: '1042' });
    expect(await ids(a.client, 'customDataKey=orderId')).toEqual([mine]);
    const hostile = encodeURIComponent(`orderId' OR '1'='1`);
    expect(await ids(a.client, `customDataKey=${hostile}`)).toEqual([]);
    expect(
      await ids(a.client, `customDataKey=orderId&customDataValue=${encodeURIComponent(`' OR 1=1 --`)}`),
    ).toEqual([]);
  });

  it('works with the other filters and rejects a bad flag', async () => {
    const a = await signup(server.app);
    const one = await runSaving(a, { orderId: '1' });
    expect(await ids(a.client, 'customDataKey=orderId&status=success')).toEqual([one]);
    expect(await ids(a.client, 'customDataKey=orderId&status=error')).toEqual([]);
    const bad = await a.client.request('GET', '/rest/executions?customDataKey=orderId&customDataExact=maybe');
    expect(bad.statusCode).toBe(400);
  });
});
