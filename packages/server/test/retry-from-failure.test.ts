import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { binaryDirOf } from '../src/services/executions';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
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

const runsOf = (state: any, name: string): unknown[] => state.resultData.runData[name] ?? [];

describe('retry from the failed node', () => {
  it('re-runs only the failed node and its successors, reusing every upstream run', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Before', 'x', 1),
        node('Boom', 'test.fail', {}, [400, 0]),
        setNode('After', 'y', 2),
      ],
      connections: chain('Start', 'Before', 'Boom', 'After'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);
    const original = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(original.state.executionData.failedExecuteData.node).toBe('Boom');

    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        nodes: current.nodes.map((n: { name: string }) =>
          n.name === 'Boom' ? { ...n, type: 'core.noOp', parameters: {} } : n,
        ),
      }),
    );
    const retry = await client.data(
      client.post(`/rest/executions/${executionId}/retry`, { useCurrentWorkflow: true }),
    );
    expect(Object.keys(retry)).toEqual(['executionId']);
    const row = await waitForExecution(server.ctx, tenant.id, retry.executionId);
    expect(row).toMatchObject({ status: 'success', mode: 'retry', retryOf: executionId });

    const { state } = await client.data(client.get(`/rest/executions/${retry.executionId}`));
    // upstream nodes ran once, in the original execution only
    expect(runsOf(state, 'Start')).toHaveLength(1);
    expect(runsOf(state, 'Before')).toHaveLength(1);
    // the failed node ran again and the successor ran for the first time
    expect(runsOf(state, 'Boom')).toHaveLength(2);
    expect(outputOf(state, 'Boom')).toEqual([{ x: 1 }]);
    expect(outputOf(state, 'After')).toEqual([{ x: 1, y: 2 }]);
    expect(state.resultData.pinData).toBeUndefined();
    expect(state.executionData.failedExecuteData).toBeUndefined();
  });

  it('can be retried again when the failed node fails again', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
      connections: chain('Start', 'Boom'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);

    const first = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    const firstRow = await waitForExecution(server.ctx, tenant.id, first.executionId);
    expect(firstRow).toMatchObject({ status: 'error', errorNode: 'Boom', retryOf: executionId });
    const second = await client.data(client.post(`/rest/executions/${first.executionId}/retry`, {}));
    const secondRow = await waitForExecution(server.ctx, tenant.id, second.executionId);
    expect(secondRow).toMatchObject({ status: 'error', errorNode: 'Boom', retryOf: first.executionId });
    const { state } = await client.data(client.get(`/rest/executions/${second.executionId}`));
    expect(runsOf(state, 'Start')).toHaveLength(1);
    expect(runsOf(state, 'Boom')).toHaveLength(3);
  });

  it('refuses a retry with the current workflow when the failed node was deleted', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
      connections: chain('Start', 'Boom'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);
    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        nodes: current.nodes.filter((n: { name: string }) => n.name !== 'Boom'),
        connections: {},
      }),
    );
    const res = await client.post(`/rest/executions/${executionId}/retry`, { useCurrentWorkflow: true });
    expect(res.statusCode).toBe(409);
  });

  it('falls back to pinning for an execution saved without a failed node', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Before', 'x', 1),
        node('Boom', 'test.fail', {}, [400, 0]),
      ],
      connections: chain('Start', 'Before', 'Boom'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);
    const data = await server.ctx.repos.executions.getData(tenant.id, executionId);
    const state: any = JSON.parse(JSON.stringify(data!.state));
    delete state.executionData.failedExecuteData;
    await server.ctx.repos.executions.saveState(tenant.id, executionId, state);

    const retry = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    await waitForExecution(server.ctx, tenant.id, retry.executionId);
    const retried = await client.data(client.get(`/rest/executions/${retry.executionId}`));
    expect(Object.keys(retried.state.resultData.pinData).sort()).toEqual(['Before', 'Start']);
  });
});

describe('retry of a timed-out execution (R46)', () => {
  it('does not re-run the last node that already succeeded', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        setNode('Charge', 'charged', 1),
        node('Slow', 'test.sleep', { ms: 5000 }, [400, 0]),
      ],
      connections: chain('Start', 'Charge', 'Slow'),
      settings: { executionTimeout: 1 },
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const timedOut = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(timedOut).toMatchObject({ status: 'error', errorNode: null });

    const retry = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    await waitForExecution(server.ctx, tenant.id, retry.executionId);
    const { state } = await client.data(client.get(`/rest/executions/${retry.executionId}`));
    expect(Object.keys(state.resultData.pinData).sort()).toEqual(['Charge', 'Start']);
  });
});

describe('retry of a retry that timed out', () => {
  it('pins the node that failed once and then succeeded, and starts at the original trigger', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Alpha', 'core.manualTrigger'),
        node('Beta', 'core.manualTrigger', {}, [0, 200]),
        node('Charge', 'test.fail', {}, [200, 200]),
        node('Slow', 'test.sleep', { ms: 5000 }, [400, 200]),
      ],
      connections: chain('Beta', 'Charge', 'Slow'),
      settings: { executionTimeout: 1 },
    });
    const { executionId } = await client.data(
      client.post(`/rest/workflows/${wf.id}/run`, { startNode: 'Beta' }),
    );
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorNode: 'Charge' });

    const current = await client.data(client.get(`/rest/workflows/${wf.id}`));
    await client.data(
      client.patch(`/rest/workflows/${wf.id}`, {
        versionId: current.versionId,
        nodes: current.nodes.map((n: { name: string }) =>
          n.name === 'Charge' ? { ...n, type: 'core.noOp', parameters: {} } : n,
        ),
      }),
    );
    // the charge succeeds on the first retry, then the run times out in the slow node
    const first = await client.data(
      client.post(`/rest/executions/${executionId}/retry`, { useCurrentWorkflow: true }),
    );
    const firstRow = await waitForExecution(server.ctx, tenant.id, first.executionId);
    expect(firstRow).toMatchObject({ status: 'error', errorNode: null });
    const firstData: any = await server.ctx.repos.executions.getData(tenant.id, first.executionId);
    expect(firstData!.runOptions).toMatchObject({ startNode: 'Beta' });
    expect(runsOf(firstData!.state, 'Charge')).toHaveLength(2);

    const second = await client.data(client.post(`/rest/executions/${first.executionId}/retry`, {}));
    await waitForExecution(server.ctx, tenant.id, second.executionId);
    const secondData = await server.ctx.repos.executions.getData(tenant.id, second.executionId);
    expect(secondData!.runOptions).toMatchObject({ startNode: 'Beta' });
    const state: any = secondData!.state;
    expect(Object.keys(state.resultData.pinData).sort()).toEqual(['Beta', 'Charge']);
    // the charge is replayed from the pin and the other trigger never ran
    expect(state.resultData.pinData.Charge).toEqual(
      firstData!.state.resultData.runData.Charge[1].data.main[0],
    );
    expect(runsOf(state, 'Alpha')).toHaveLength(0);
  });
});

describe('binary data of a retried execution', () => {
  it('is copied into the retry so deleting the original execution does not break it', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
      connections: chain('Start', 'Boom'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);
    const fileName = '5b0e2f6e-0d63-4a37-9a58-5f1d2a3f4c11';
    const originalDir = binaryDirOf(server.ctx.config, tenant.id, executionId);
    mkdirSync(originalDir, { recursive: true });
    writeFileSync(path.join(originalDir, fileName), 'payload');
    const data = await server.ctx.repos.executions.getData(tenant.id, executionId);
    const state: any = JSON.parse(JSON.stringify(data!.state));
    const binary = {
      data: { data: '', id: `fs:${tenant.id}/${executionId}/${fileName}`, mimeType: 'text/plain' },
    };
    state.resultData.runData.Start[0].data.main[0][0].binary = binary;
    state.executionData.failedExecuteData.data.main[0][0].binary = binary;
    await server.ctx.repos.executions.saveState(tenant.id, executionId, state);

    const retry = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    const retryDir = binaryDirOf(server.ctx.config, tenant.id, retry.executionId);
    expect(readFileSync(path.join(retryDir, fileName), 'utf8')).toBe('payload');
    await waitForExecution(server.ctx, tenant.id, retry.executionId);
    await server.ctx.executions.removeBinaryData(tenant.id, executionId);
    expect(existsSync(originalDir)).toBe(false);

    const retried = await server.ctx.repos.executions.getData(tenant.id, retry.executionId);
    const ref = (retried!.state as any).resultData.runData.Start[0].data.main[0][0].binary.data.id;
    expect(ref).toBe(`fs:${tenant.id}/${retry.executionId}/${fileName}`);
    expect(existsSync(path.join(retryDir, fileName))).toBe(true);
  });
});
