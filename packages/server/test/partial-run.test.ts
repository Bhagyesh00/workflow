/**
 * P3-06: POST /workflows/:id/run with the run data of an earlier execution, a destination and the dirty nodes
 * reruns only the dirty node and the nodes after it. The trigger and the nodes before keep their earlier output,
 * so the trigger is not called again.
 */
import { rm } from 'node:fs/promises';
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { NodePackage } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import {
  chain,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  testConfig,
  testPackage,
  waitForExecution,
} from './helpers';

/** manual calls of the "p3.countTrigger" trigger */
let triggerCalls = 0;

const p3Package: NodePackage = {
  name: 'p3-partial-run-tests',
  nodes: [
    {
      description: {
        name: 'p3.countTrigger',
        displayName: 'Counting trigger',
        description: '',
        group: ['trigger'],
        version: 1,
        defaults: { name: 'Counting trigger' },
        inputs: [],
        outputs: ['main'],
        properties: [],
      },
      async trigger(ctx) {
        return {
          manualTriggerFunction: async () => {
            triggerCalls++;
            ctx.emit([[{ json: { call: triggerCalls } }]]);
          },
        };
      },
    },
  ],
  credentials: [],
};

let server: TestServer;
const config = testConfig();

beforeAll(async () => {
  const ctx = await createContext({
    config,
    nodePackages: [nodesBasePackage, testPackage, p3Package],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } }),
  });
  await resetDatabase(ctx);
  const app = await buildApp(ctx);
  await app.ready();
  await ctx.startMain();
  server = {
    ctx,
    app,
    async close() {
      await app.close();
      await ctx.close();
      await rm(config.binaryData.dir, { recursive: true, force: true });
    },
  };
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  triggerCalls = 0;
});

type Task = { startTime: number; data?: { main: Array<Array<{ json: Record<string, unknown> }>> } };
type State = { resultData: { runData: Record<string, Task[]>; error?: { message: string } } };

describe('partial run (P3-06)', () => {
  const nodes = () => [
    node('Trigger', 'p3.countTrigger'),
    setNode('A', 'a', 'A', [200, 0]),
    setNode('B', 'b', 'old', [400, 0]),
    setNode('C', 'c', 'C', [600, 0]),
  ];

  async function firstRun() {
    const { client, tenant } = await signup(server.app);
    const definition = { nodes: nodes(), connections: chain('Trigger', 'A', 'B', 'C') };
    const wf = await createWorkflow(client, definition);
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    await waitForExecution(server.ctx, tenant.id, executionId);
    const earlier = await client.data<{ state: State }>(client.get(`/rest/executions/${executionId}`));
    expect(triggerCalls).toBe(1);
    return { client, tenant, wf, definition, earlier: earlier.state.resultData.runData };
  }

  it('reuses the trigger and A, reruns B and C, and does not call the trigger again', async () => {
    const { client, tenant, wf, definition, earlier } = await firstRun();
    const edited = structuredClone(definition);
    const b = edited.nodes.find((n) => n.name === 'B')!;
    (b.parameters.assignments as { assignments: Array<{ value: unknown }> }).assignments[0].value = 'new';

    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {
        workflowData: { name: 'Test workflow', ...edited, settings: {} },
        destinationNode: 'C',
        runData: earlier,
        dirtyNodeNames: ['B'],
      }),
    );
    const row = await waitForExecution(server.ctx, tenant.id, executionId);
    const execution = await client.data<{ state: State }>(client.get(`/rest/executions/${executionId}`));
    expect(execution.state.resultData.error?.message).toBeUndefined();
    expect(row.status).toBe('success');
    expect(triggerCalls).toBe(1);
    const runData = execution.state.resultData.runData;
    expect(runData.Trigger).toHaveLength(1);
    expect(runData.Trigger[0].startTime).toBe(earlier.Trigger[0].startTime);
    expect(runData.A[0].startTime).toBe(earlier.A[0].startTime);
    expect(runData.B).toHaveLength(1);
    expect(runData.C).toHaveLength(1);
    expect(outputOf(execution.state, 'C')).toEqual([{ call: 1, a: 'A', b: 'new', c: 'C' }]);
  });

  it('a full run (no destination) ignores nothing and calls the trigger', async () => {
    const { client, tenant, wf } = await firstRun();
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {}),
    );
    await waitForExecution(server.ctx, tenant.id, executionId);
    expect(triggerCalls).toBe(2);
  });

  it('a disabled destination fails with the n8n message', async () => {
    const { client, tenant, wf, definition, earlier } = await firstRun();
    const edited = structuredClone(definition);
    edited.nodes.find((n) => n.name === 'C')!.disabled = true;
    const { executionId } = await client.data<{ executionId: string }>(
      client.post(`/rest/workflows/${wf.id}/run`, {
        workflowData: { name: 'Test workflow', ...edited, settings: {} },
        destinationNode: 'C',
        runData: earlier,
        dirtyNodeNames: ['C'],
      }),
    );
    const row = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(row.status).toBe('error');
    const execution = await client.data<{ state: State }>(client.get(`/rest/executions/${executionId}`));
    expect(execution.state.resultData.error?.message).toBe('Cannot execute a disabled node');
  });

  it('rejects dirty node names that are not strings', async () => {
    const { client, wf, earlier } = await firstRun();
    const res = await client.request('POST', `/rest/workflows/${wf.id}/run`, {
      destinationNode: 'C',
      runData: earlier,
      dirtyNodeNames: [42],
    });
    expect(res.statusCode).toBe(400);
  });
});
