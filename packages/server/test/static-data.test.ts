/**
 * P2-12: $getWorkflowStaticData in the Code node is saved after runs from active triggers, and a
 * trigger run or poll starts from the static data in the database, not from a stale copy in memory.
 */
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { Item, NodePackage, NodeType } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createContext } from '../src/context';
import {
  chain,
  createWorkflow,
  executionsOf,
  node,
  outputOf,
  resetDatabase,
  signup,
  type TestServer,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
} from './helpers';

/** emitters of the running "p2.emitTrigger" nodes, by node name */
const emitters = new Map<string, (items: Item[]) => void>();
/** what each poll saw in its node scope before it changed it */
const polled: number[] = [];

const description = (
  name: string,
  extra: Partial<NodeType['description']> = {},
): NodeType['description'] => ({
  name,
  displayName: name,
  description: '',
  group: ['trigger'],
  version: 1,
  defaults: { name },
  inputs: [],
  outputs: ['main'],
  properties: [],
  ...extra,
});

const p2Package: NodePackage = {
  name: 'p2-static-data-tests',
  nodes: [
    {
      description: description('p2.emitTrigger'),
      async trigger(ctx) {
        if (ctx.getMode() === 'manual') return {};
        const name = ctx.getNode().name;
        emitters.set(name, (items) => ctx.emit([items]));
        return { closeFunction: async () => void emitters.delete(name) };
      },
    },
    {
      description: description('p2.cursorPoll', { polling: true }),
      async poll(ctx) {
        const scope = ctx.getWorkflowStaticData('node') as { cursor?: number };
        polled.push(scope.cursor ?? 0);
        scope.cursor = (scope.cursor ?? 0) + 1;
        return null;
      },
    },
    {
      // takes longer than the 1 s poll interval of another poll node of the same workflow
      description: description('p2.slowPoll', { polling: true }),
      async poll(ctx) {
        const scope = ctx.getWorkflowStaticData('node') as { cursor?: number };
        await new Promise((resolve) => setTimeout(resolve, 1500));
        scope.cursor = (scope.cursor ?? 0) + 1;
        return null;
      },
    },
  ],
  credentials: [],
};

let server: TestServer;

beforeAll(async () => {
  const ctx = await createContext({
    config: testConfig(),
    nodePackages: [nodesBasePackage, testPackage, p2Package],
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
    },
  };
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  emitters.clear();
  polled.length = 0;
});

const code = (name: string, jsCode: string, x = 200) =>
  node(name, 'core.code', { mode: 'runOnceForAllItems', jsCode }, [x, 0]);

const COUNT_GLOBAL = `const g = $getWorkflowStaticData('global'); g.count = (g.count ?? 0) + 1; return [{ json: { count: g.count } }];`;

async function activate(client: Awaited<ReturnType<typeof signup>>['client'], id: string) {
  return client.data(client.post(`/rest/workflows/${id}/activate`));
}

async function staticDataOf(tenantId: string, workflowId: string) {
  return (await server.ctx.repos.workflows.get(tenantId, workflowId))!.staticData;
}

async function emitAndFinish(tenantId: string, workflowId: string, trigger: string, expected: number) {
  await waitFor(async () => emitters.has(trigger), { message: 'the trigger to start' });
  emitters.get(trigger)!([{ json: { go: true } }]);
  const rows = await waitFor(
    async () => {
      const list = await executionsOf(server.ctx, tenantId, workflowId);
      return list.length >= expected ? list : undefined;
    },
    { message: `execution ${expected}` },
  );
  for (const row of rows) await waitForExecution(server.ctx, tenantId, row.id, ['success', 'error']);
  return rows;
}

describe('P2-12 static data in the Code node', () => {
  it('a Code counter is 1 and then 2 across two triggered runs', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Trigger', 'p2.emitTrigger'), code('Count', COUNT_GLOBAL)],
      connections: chain('Trigger', 'Count'),
    });
    await activate(client, wf.id);

    await emitAndFinish(tenant.id, wf.id, 'Trigger', 1);
    // the run saves its static data just after it reports success
    await waitFor(async () => (await staticDataOf(tenant.id, wf.id)).global, { message: 'the first save' });
    await emitAndFinish(tenant.id, wf.id, 'Trigger', 2);
    await waitFor(async () => ((await staticDataOf(tenant.id, wf.id)).global as any)?.count === 2, {
      message: 'the second save',
    });

    const rows = await executionsOf(server.ctx, tenant.id, wf.id);
    const counts: number[] = [];
    for (const row of rows) {
      const state = (await server.ctx.repos.executions.getData(tenant.id, row.id))!.state as any;
      counts.push(outputOf(state, 'Count')[0]!.count as number);
    }
    expect(counts.sort()).toEqual([1, 2]);
    expect(await staticDataOf(tenant.id, wf.id)).toEqual({ global: { count: 2 } });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('a manual run does not save static data', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), code('Count', COUNT_GLOBAL)],
      connections: chain('Start', 'Count'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    expect(await staticDataOf(tenant.id, wf.id)).toEqual({});
  });

  it('a failed run saves the static data it changed', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Trigger', 'p2.emitTrigger'),
        code('Count', COUNT_GLOBAL),
        code('Fail', `throw new Error('after the counter')`, 400),
      ],
      connections: chain('Trigger', 'Count', 'Fail'),
    });
    await activate(client, wf.id);
    const [row] = await emitAndFinish(tenant.id, wf.id, 'Trigger', 1);
    expect((await server.ctx.repos.executions.get(tenant.id, row!.id))!.status).toBe('error');
    await waitFor(async () => (await staticDataOf(tenant.id, wf.id)).global, { message: 'the save' });
    expect(await staticDataOf(tenant.id, wf.id)).toEqual({ global: { count: 1 } });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('keeps node:A and node:B when two nodes change their own scope', async () => {
    const { client, tenant } = await signup(server.app);
    const own = `const n = $getWorkflowStaticData('node'); n.runs = (n.runs ?? 0) + 1; return [{ json: n }];`;
    const wf = await createWorkflow(client, {
      nodes: [node('Trigger', 'p2.emitTrigger'), code('A', own), code('B', own, 400)],
      connections: chain('Trigger', 'A', 'B'),
    });
    await activate(client, wf.id);
    await emitAndFinish(tenant.id, wf.id, 'Trigger', 1);
    await waitFor(async () => (await staticDataOf(tenant.id, wf.id))['node:B'], {
      message: 'the first save',
    });
    await emitAndFinish(tenant.id, wf.id, 'Trigger', 2);
    await waitFor(async () => ((await staticDataOf(tenant.id, wf.id))['node:B'] as any)?.runs === 2, {
      message: 'the second save',
    });
    expect(await staticDataOf(tenant.id, wf.id)).toEqual({
      'node:A': { runs: 2 },
      'node:B': { runs: 2 },
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('saves static data before the final status: whoever sees success reads the new value', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Trigger', 'p2.emitTrigger'), code('Count', COUNT_GLOBAL)],
      connections: chain('Trigger', 'Count'),
    });
    await activate(client, wf.id);
    const repo = server.ctx.repos.executions;
    const original = repo.update.bind(repo);
    const seen: unknown[] = [];
    repo.update = (async (...args: Parameters<typeof original>) => {
      const patch = args[2] as { status?: string };
      if (patch.status === 'success') seen.push(structuredClone(await staticDataOf(tenant.id, wf.id)));
      return original(...args);
    }) as typeof original;
    try {
      await emitAndFinish(tenant.id, wf.id, 'Trigger', 1);
    } finally {
      repo.update = original;
    }
    expect(seen).toEqual([{ global: { count: 1 } }]);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('a poll starts from the static data in the database', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Poller', 'p2.cursorPoll', {
          pollTimes: { item: [{ mode: 'everyX', unit: 'seconds', value: 1 }] },
        }),
      ],
    });
    await activate(client, wf.id);
    await waitFor(async () => polled.length >= 1, { timeout: 5000, message: 'a poll' });
    // another process moves the cursor: the next poll must see it
    await server.ctx.repos.workflows.setStaticData(tenant.id, wf.id, { 'node:Poller': { cursor: 100 } });
    await waitFor(async () => polled.some((c) => c >= 100), {
      timeout: 6000,
      message: 'a poll with the new cursor',
    });
    await waitFor(async () => ((await staticDataOf(tenant.id, wf.id))['node:Poller'] as any)?.cursor > 100, {
      timeout: 6000,
      message: 'the cursor to be saved',
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
  });
});

describe('overlapping polls', () => {
  it('a slow poll keeps the cursor it writes while another poll of the workflow runs', async () => {
    const { client, tenant } = await signup(server.app);
    const everySecond = { pollTimes: { item: [{ mode: 'everyX', unit: 'seconds', value: 1 }] } };
    const wf = await createWorkflow(client, {
      nodes: [
        node('Slow', 'p2.slowPoll', everySecond, [0, 0]),
        node('Fast', 'p2.cursorPoll', everySecond, [0, 200]),
      ],
    });
    await activate(client, wf.id);
    await waitFor(async () => polled.length >= 2, { timeout: 6000, message: 'the fast poll to overlap' });
    await waitFor(async () => ((await staticDataOf(tenant.id, wf.id))['node:Slow'] as any)?.cursor >= 1, {
      timeout: 8000,
      message: 'the slow poll cursor to be saved',
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    const saved = await staticDataOf(tenant.id, wf.id);
    expect((saved['node:Fast'] as any).cursor).toBeGreaterThanOrEqual(2);
  });
});

describe('StaticDataRepository.merge', () => {
  it('writes changed top-level keys only, deletes removed keys, in a way that keeps other keys', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Trigger', 'p2.emitTrigger')] });
    const repo = server.ctx.repos.staticData;
    await server.ctx.repos.workflows.setStaticData(tenant.id, wf.id, {
      keep: { a: 1 },
      drop: 1,
      'node:A': {},
    });

    // run 1 changes node:A, run 2 (which started from the same data) changes node:B and removes drop
    await repo.merge(
      tenant.id,
      wf.id,
      { keep: { a: 1 }, drop: 1, 'node:A': {} },
      { keep: { a: 1 }, drop: 1, 'node:A': { x: 1 } },
    );
    await repo.merge(
      tenant.id,
      wf.id,
      { keep: { a: 1 }, drop: 1, 'node:A': {} },
      { keep: { a: 1 }, 'node:A': {}, 'node:B': { y: 2 } },
    );
    expect(await staticDataOf(tenant.id, wf.id)).toEqual({
      keep: { a: 1 },
      'node:A': { x: 1 },
      'node:B': { y: 2 },
    });
  });
});
