/**
 * P4-21 test listen: "Execute step" on a trigger() node starts it in manual mode for up to 120 s; the
 * first event starts the test run and Stop closes it, on whichever main holds it.
 */
import type { NodePackage, NodeTypeDescription, TriggerContext, TriggerRunResult } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ActiveWorkflowDeps, ActiveWorkflowManager } from '../src/services/active-workflows';
import type { PushEvent } from '../src/services/bus';
import type { Leadership } from '../src/services/queue';
import { TEST_TRIGGER_TTL_MS } from '../src/services/test-webhooks';
import { WorkflowService } from '../src/services/workflows';
import {
  chain,
  createTestServer,
  createWorkflow,
  memberAs,
  node,
  resetDatabase,
  signup as signupAs,
  TestClient,
  type TestServer,
  waitFor,
} from './helpers';

const description = (name: string): NodeTypeDescription => ({
  name,
  displayName: name,
  description: '',
  group: ['trigger'],
  version: 1,
  defaults: { name },
  inputs: [],
  outputs: ['main'],
  properties: [],
});

let listening: TriggerContext | undefined;
let modes: string[] = [];
let closed = 0;
let gate: Promise<void> | undefined;
let sideEffects = 0;

const countClose = async () => {
  closed++;
};

const listenPackage: NodePackage = {
  name: 'p4-trigger-listen-tests',
  credentials: [],
  nodes: [
    {
      description: description('tl.events'),
      async trigger(ctx) {
        modes.push(ctx.getMode());
        listening = ctx;
        if (gate) await gate;
        return { closeFunction: countClose };
      },
    },
    {
      description: description('tl.refuses'),
      async trigger() {
        throw new Error('Connection refused');
      },
    },
    {
      description: description('tl.errorsWhileStarting'),
      async trigger(ctx) {
        ctx.emitError(new Error('Bad password'));
        return { closeFunction: countClose };
      },
    },
    {
      description: description('tl.emitsWhileStarting'),
      async trigger(ctx) {
        ctx.emit([[{ json: { retained: true } }]]);
        await new Promise((r) => setTimeout(r, 50));
        return { closeFunction: countClose };
      },
    },
    {
      description: description('tl.joinsLater'),
      async trigger(ctx) {
        return {
          // the consumer starts here and this call can take as long as a group join
          manualTriggerFunction: async () => {
            await new Promise((r) => setTimeout(r, 200));
            ctx.emit([[{ json: { joined: true } }]]);
          },
          closeFunction: countClose,
        };
      },
    },
    {
      description: description('tl.manualFails'),
      async trigger() {
        return {
          manualTriggerFunction: async () => {
            await new Promise((r) => setTimeout(r, 50));
            throw new Error('Group authorization failed');
          },
          closeFunction: countClose,
        };
      },
    },
    {
      description: { ...description('tl.slowStep'), group: ['transform'], inputs: ['main'] },
      async execute(ctx) {
        await new Promise((r) => setTimeout(r, 300));
        return [ctx.getInputData()];
      },
    },
    {
      description: { ...description('tl.sideEffect'), group: ['transform'], inputs: ['main'] },
      async execute(ctx) {
        sideEffects++;
        return [ctx.getInputData()];
      },
    },
    {
      description: description('tl.neverStarts'),
      async trigger() {
        return new Promise(() => {});
      },
    },
  ],
};

let server: TestServer;
let callers = 0;
/** each its own caller: signup allows 20 calls an hour per IP, counted in Redis across runs */
const signup = (app: TestServer['app'], input: { workspaceName?: string } = {}) =>
  signupAs(app, { ...input, remoteAddress: `10.21.${process.pid % 250}.${++callers}` });

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [listenPackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  listening = undefined;
  modes = [];
  closed = 0;
  gate = undefined;
  sideEffects = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const url = (id: string) => `/rest/workflows/${id}/listen-test-trigger`;
const listen = (client: TestClient, id: string, nodeName: string) => client.post(url(id), { nodeName });

const events = (type: string) => ({ nodes: [node('Events', type)] });

async function pushesOf(tenantId: string) {
  const seen: PushEvent[] = [];
  const unsubscribe = await server.ctx.push.subscribe(tenantId, (e) => seen.push(e));
  return { seen, unsubscribe };
}

const runsOf = (tenantId: string) => server.ctx.repos.executions.list(tenantId, { limit: 10 });
const tenantRow = async (id: string) => (await server.ctx.repos.tenants.get(id))!;

/** a main beside the server's, on the same bus and database */
const secondMain = async (extra: Partial<ActiveWorkflowDeps> = {}) => {
  const notLeader: Leadership = { isLeader: false, start: async () => {}, stop: async () => {} };
  const activeWorkflows = new ActiveWorkflowManager({
    config: server.ctx.config,
    database: server.ctx.database,
    repos: server.ctx.repos,
    nodeTypes: server.ctx.registries.nodeTypes,
    executions: server.ctx.executions,
    logger: server.ctx.logger,
    bus: server.ctx.bus,
    leadership: notLeader,
    serviceDeps: server.ctx.serviceDeps,
    ...extra,
  });
  await activeWorkflows.init();
  const workflows = new WorkflowService({
    config: server.ctx.config,
    database: server.ctx.database,
    repos: server.ctx.repos,
    nodeTypes: server.ctx.registries.nodeTypes,
    executions: server.ctx.executions,
    activeWorkflows,
    testWebhooks: server.ctx.testWebhooks,
    favorites: server.ctx.favorites,
    publishHistory: server.ctx.publishHistory,
    reviews: server.ctx.reviews,
    context: () => server.ctx,
  });
  return { activeWorkflows, workflows };
};

describe('POST /workflows/:id/listen-test-trigger', () => {
  it('starts the node in manual mode for 120 s and answers when that ends', async () => {
    expect(TEST_TRIGGER_TTL_MS).toBe(120_000);
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const before = Date.now();
    const answer = await client.data<{ expiresAt: string }>(listen(client, wf.id, 'Events'));
    expect(modes).toEqual(['manual']);
    const expiresAt = new Date(answer.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(await runsOf(tenant.id)).toEqual([]);
    await client.delete(url(wf.id));
  });

  it('the first event starts a test run, the editor is told and the trigger closes', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const { seen, unsubscribe } = await pushesOf(tenant.id);
    await client.data(listen(client, wf.id, 'Events'));

    listening?.emit([[{ json: { hello: 'world' } }]]);
    const [run] = await waitFor(async () => {
      const list = await runsOf(tenant.id);
      return list.length && list[0].status === 'success' ? list : undefined;
    });
    expect(run.mode).toBe('manual');
    expect(run.workflowId).toBe(wf.id);
    await waitFor(async () => closed === 1);
    await waitFor(async () => seen.some((e) => e.type === 'testWebhookReceived'));
    expect(seen.find((e) => e.type === 'testWebhookReceived')?.data).toEqual({
      workflowId: wf.id,
      executionId: run.id,
    });
    const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
    const stored = data?.state as { resultData: { runData: Record<string, Array<{ data: unknown }>> } };
    expect(JSON.stringify(stored.resultData.runData.Events[0].data)).toContain('world');
    unsubscribe();
  });

  it('only the first event runs', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    await client.data(listen(client, wf.id, 'Events'));
    const ctx = listening!;
    ctx.emit([[{ json: { n: 1 } }]]);
    const second = new Promise<TriggerRunResult>((resolve, reject) => {
      ctx.emit([[{ json: { n: 2 } }]], { resolve, reject });
    });
    await expect(second).rejects.toThrow('stopped');
    await waitFor(async () => closed === 1);
    expect(await runsOf(tenant.id)).toHaveLength(1);
  });

  it('an event during the start is not lost', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.emitsWhileStarting'));
    const res = await listen(client, wf.id, 'Events');
    expect(res.statusCode).toBe(200);
    await waitFor(async () => (await runsOf(tenant.id)).length === 1);
    await waitFor(async () => closed === 1);
  });

  it('does not wait for manualTriggerFunction, whose event starts the run', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.joinsLater'));
    await client.data(listen(client, wf.id, 'Events'));
    expect(await runsOf(tenant.id)).toEqual([]);
    await waitFor(async () => (await runsOf(tenant.id)).length === 1);
    await waitFor(async () => closed === 1);
  });

  it('closes only after the run when the node waits for the run result', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [node('Events', 'tl.events'), node('Slow', 'tl.slowStep', {}, [200, 0])],
      connections: chain('Events', 'Slow'),
    });
    await client.data(listen(client, wf.id, 'Events'));
    const result = await new Promise<TriggerRunResult>((resolve, reject) => {
      listening!.emit([[{ json: {} }]], {
        resolve(run) {
          // still open when the node hears the result, so it can acknowledge the message
          expect(closed).toBe(0);
          resolve(run);
        },
        reject,
      });
    });
    expect(result.status).toBe('success');
    await waitFor(async () => closed === 1);
  });

  it('a second listen replaces the first', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    await client.data(listen(client, wf.id, 'Events'));
    const first = listening!;
    await client.data(listen(client, wf.id, 'Events'));
    expect(closed).toBe(1);
    await expect(
      new Promise((resolve, reject) => first.emit([[{ json: {} }]], { resolve, reject })),
    ).rejects.toThrow('stopped');
    await client.delete(url(wf.id));
    expect(closed).toBe(2);
  });

  it('two listen calls at once leave one listener, which Stop reaches', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    // both calls pass their stop with nothing to stop before either one sets its listener
    const realPublish = server.ctx.bus.publish.bind(server.ctx.bus);
    let bothStopping!: () => void;
    const barrier = new Promise<void>((resolve) => {
      bothStopping = resolve;
    });
    let stopping = 0;
    vi.spyOn(server.ctx.bus, 'publish').mockImplementation(async (channel, message) => {
      if ((message as { type?: string }).type === 'test-triggers:stop') {
        if (++stopping === 2) bothStopping();
        await barrier;
      }
      return realPublish(channel, message);
    });

    const row = await tenantRow(tenant.id);
    const answers = await Promise.allSettled([
      server.ctx.workflows.listenTestTrigger(row, wf.id, 'Events'),
      server.ctx.workflows.listenTestTrigger(row, wf.id, 'Events'),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual(['fulfilled', 'rejected']);

    await client.delete(url(wf.id));
    await waitFor(async () => closed === modes.length);
    expect(closed).toBeGreaterThan(0);
  });

  it('a test run uses the pinned data of the nodes after the trigger, as other manual runs do', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await client.data<{ id: string }>(
      client.post('/rest/workflows', {
        name: 'Pinned',
        nodes: [node('Events', 'tl.events'), node('Send', 'tl.sideEffect', {}, [200, 0])],
        connections: chain('Events', 'Send'),
        pinData: { Events: [{ json: { pinned: 'trigger' } }], Send: [{ json: { pinned: 'send' } }] },
      }),
    );
    await client.data(listen(client, wf.id, 'Events'));

    listening?.emit([[{ json: { hello: 'world' } }]]);
    const [run] = await waitFor(async () => {
      const list = await runsOf(tenant.id);
      return list.length && list[0].status === 'success' ? list : undefined;
    });
    expect(sideEffects).toBe(0);
    const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
    const stored = data?.state as { resultData: { runData: Record<string, Array<{ data: unknown }>> } };
    // the event, not the trigger's own pin, starts the run
    expect(JSON.stringify(stored.resultData.runData.Events[0].data)).toContain('world');
    expect(JSON.stringify(stored.resultData.runData.Send[0].data)).toContain('send');
  });

  it('the test run carries who started the listen', async () => {
    const { client, tenant, user } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    await client.data(listen(client, wf.id, 'Events'));

    listening?.emit([[{ json: {} }]]);
    const [run] = await waitFor(async () => {
      const list = await runsOf(tenant.id);
      return list.length ? list : undefined;
    });
    const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
    const runOptions = data?.runOptions as { userId?: string };
    expect(runOptions.userId).toBe(user.id);
  });

  it('a start that fails answers 400 with the reason', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.refuses'));
    const res = await listen(client, wf.id, 'Events');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Events: Connection refused');
    expect(await runsOf(tenant.id)).toEqual([]);
  });

  it('an error during the start answers 400 and closes the node', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.errorsWhileStarting'));
    const res = await listen(client, wf.id, 'Events');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Events: Bad password');
    expect(closed).toBe(1);
  });

  it('a failure after the answer ends the test run in the editor, with the reason', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.manualFails'));
    const { seen, unsubscribe } = await pushesOf(tenant.id);
    expect((await listen(client, wf.id, 'Events')).statusCode).toBe(200);

    const finished = await waitFor(async () => seen.find((e) => e.type === 'executionFinished'));
    const data = finished.data as { executionId: string; status: string; error: { message: string } };
    expect(data.status).toBe('error');
    expect(data.error.message).toBe('Events: Group authorization failed');
    // the editor adopts it first, so the error reaches the screen
    const types = seen.map((e) => e.type);
    expect(types.indexOf('testWebhookReceived')).toBeLessThan(types.indexOf('executionFinished'));
    expect(seen.find((e) => e.type === 'testWebhookReceived')?.data).toEqual({
      workflowId: wf.id,
      executionId: data.executionId,
    });
    // a real row: it shows in the execution list
    const [row] = await runsOf(tenant.id);
    expect(row).toMatchObject({ id: data.executionId, status: 'error', mode: 'manual' });
    const stored = await server.ctx.repos.executions.getData(tenant.id, data.executionId);
    const state = stored?.state as {
      resultData: { error?: { message: string }; lastNodeExecuted?: string };
    };
    expect(state.resultData.error?.message).toBe('Events: Group authorization failed');
    expect(state.resultData.lastNodeExecuted).toBe('Events');
    await waitFor(async () => closed === 1);
    unsubscribe();
  });

  it('refuses a node that does not listen for events', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Set', 'core.set', {}, [200, 0]),
        node('Hook', 'core.webhook', { httpMethod: 'POST', path: 'x' }, [0, 0], { webhookId: 'w1' }),
        node('Off', 'tl.events', {}, [0, 200], { disabled: true }),
      ],
    });
    expect((await listen(client, wf.id, 'Set')).statusCode).toBe(400);
    expect((await listen(client, wf.id, 'Hook')).statusCode).toBe(400);
    expect((await listen(client, wf.id, 'Nope')).statusCode).toBe(400);
    expect((await listen(client, wf.id, 'Off')).statusCode).toBe(400);
    expect(modes).toEqual([]);
  });

  it('checks the role and the tenant', async () => {
    const a = await signup(server.app, { workspaceName: 'Tenant A' });
    const b = await signup(server.app, { workspaceName: 'Tenant B' });
    const wf = await createWorkflow(a.client, events('tl.events'));
    expect((await listen(b.client, wf.id, 'Events')).statusCode).toBe(404);
    expect((await b.client.delete(url(wf.id))).statusCode).toBe(404);

    const { client: viewer } = await memberAs(a, 'viewer', {
      email: 'viewer-p4@example.com',
      name: 'Viewer',
    });
    expect((await listen(viewer, wf.id, 'Events')).statusCode).toBe(403);
    expect((await viewer.delete(url(wf.id))).statusCode).toBe(403);
    expect((await new TestClient(server.app).post(url(wf.id), { nodeName: 'Events' })).statusCode).toBe(401);
    expect(modes).toEqual([]);
  });
});

describe('stopping', () => {
  it('DELETE closes the trigger; a later event starts nothing', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    await client.data(listen(client, wf.id, 'Events'));
    expect((await client.delete(url(wf.id))).statusCode).toBe(200);
    expect(closed).toBe(1);
    expect(listening?.signal.aborted).toBe(true);
    listening?.emit([[{ json: {} }]]);
    await new Promise((r) => setTimeout(r, 100));
    expect(await runsOf(tenant.id)).toEqual([]);
  });

  it('is a no-op when nothing listens', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    expect((await client.delete(url(wf.id))).statusCode).toBe(200);
    expect(closed).toBe(0);
  });

  it('stops a listener on another main', async () => {
    const { tenant, client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const other = await secondMain();
    await other.workflows.listenTestTrigger(await tenantRow(tenant.id), wf.id, 'Events');
    expect(modes).toEqual(['manual']);

    await client.delete(url(wf.id));
    await waitFor(async () => closed === 1);
    await other.activeWorkflows.close();
  });

  it('a listen on one main replaces the listener on another', async () => {
    const { tenant, client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const other = await secondMain();
    await other.workflows.listenTestTrigger(await tenantRow(tenant.id), wf.id, 'Events');
    await client.data(listen(client, wf.id, 'Events'));
    await waitFor(async () => closed === 1);
    await client.delete(url(wf.id));
    await other.activeWorkflows.close();
  });

  it('closes by itself when the time is up', async () => {
    const { tenant, client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const other = await secondMain({ testTriggerTtlMs: 150 });
    const { expiresAt } = await other.workflows.listenTestTrigger(
      await tenantRow(tenant.id),
      wf.id,
      'Events',
    );
    expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 150);
    await waitFor(async () => closed === 1);
    listening?.emit([[{ json: {} }]]);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runsOf(tenant.id)).toEqual([]);
    await other.activeWorkflows.close();
  });

  it('a node that never finishes starting answers 400 when the time is up', async () => {
    const { tenant, client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.neverStarts'));
    const other = await secondMain({ testTriggerTtlMs: 100 });
    await expect(
      other.workflows.listenTestTrigger(await tenantRow(tenant.id), wf.id, 'Events'),
    ).rejects.toMatchObject({ statusCode: 400 });
    await other.activeWorkflows.close();
  });

  it('a stop during the start closes the node as soon as it is up', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const pending = listen(client, wf.id, 'Events');
    await waitFor(async () => modes.length > 0);
    expect((await client.delete(url(wf.id))).statusCode).toBe(200);
    expect((await pending).statusCode).toBe(400);
    expect(closed).toBe(0);
    open();
    await waitFor(async () => closed === 1);
  });

  it('closing the main closes its listeners', async () => {
    const { tenant, client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    const other = await secondMain();
    await other.workflows.listenTestTrigger(await tenantRow(tenant.id), wf.id, 'Events');
    await other.activeWorkflows.close();
    expect(closed).toBe(1);
  });

  it('deleting the workflow closes its listener', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, events('tl.events'));
    await client.data(listen(client, wf.id, 'Events'));
    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    expect((await client.delete(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
    await waitFor(async () => closed === 1);
  });
});
