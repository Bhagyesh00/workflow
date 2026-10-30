import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SingleLeader } from '../src/services/queue';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await server.ctx.activeWorkflows.stopAll();
  await resetDatabase(server.ctx);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function intervalWorkflow() {
  const { client, tenant } = await signup(server.app);
  const wf = await createWorkflow(client, {
    nodes: [
      node('Interval', 'test.interval', { intervalMs: 50 }),
      setNode('Set', 'seen', '={{ $json.tick }}'),
    ],
    connections: chain('Interval', 'Set'),
  });
  return { client, tenant, wf };
}

/** the execution count stays flat once runs emitted before the stop have been recorded */
async function expectNoNewExecutions(tenantId: string, workflowId: string) {
  const count = async () => (await executionsOf(server.ctx, tenantId, workflowId)).length;
  // a live 50 ms interval never holds still for 300 ms; a slow machine may still be recording
  let previous = await count();
  const settled = await waitFor(
    async () => {
      await sleep(300);
      const current = await count();
      const stable = current === previous;
      previous = current;
      return stable ? { current } : undefined;
    },
    { timeout: 5_000, message: 'in-flight executions to be recorded' },
  );
  await sleep(700);
  expect(await count()).toBe(settled.current);
}

describe('trigger activation races', () => {
  it('two concurrent activations leave one trigger, and deactivation stops it', async () => {
    const { client, tenant, wf } = await intervalWorkflow();
    const [first, second] = await Promise.all([
      client.post(`/rest/workflows/${wf.id}/activate`),
      client.post(`/rest/workflows/${wf.id}/activate`),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([wf.id]);
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id)).length >= 2, {
      message: 'interval executions',
    });

    const deactivate = await client.post(`/rest/workflows/${wf.id}/deactivate`);
    expect(deactivate.statusCode).toBe(200);
    expect(server.ctx.activeWorkflows.runningWorkflowIds).toEqual([]);
    await expectNoNewExecutions(tenant.id, wf.id);
  });

  it('a stop requested while triggers are starting stops them once they are up', async () => {
    const { client, tenant, wf } = await intervalWorkflow();
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    const manager = server.ctx.activeWorkflows;
    await manager.stopTriggers(wf.id);

    await Promise.all([manager.startTriggers(tenant.id, wf.id, 'activate'), manager.stopTriggers(wf.id)]);
    expect(manager.runningWorkflowIds).toEqual([]);
    await expectNoNewExecutions(tenant.id, wf.id);
  });

  it('startAll stops starting triggers once leadership is lost', async () => {
    const { client, tenant, wf } = await intervalWorkflow();
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    const manager = server.ctx.activeWorkflows;
    const leadership = server.ctx.leadership as SingleLeader;
    await manager.stopAll();

    try {
      const starting = manager.startAll();
      // demotion: the leader flag drops and the lost-leadership callback stops everything
      leadership.isLeader = false;
      await manager.stopAll();
      await starting;
      expect(manager.runningWorkflowIds).toEqual([]);
      await expectNoNewExecutions(tenant.id, wf.id);
    } finally {
      leadership.isLeader = true;
    }
  });
});
