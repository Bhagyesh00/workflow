/**
 * P4-21 trigger runtime: a trigger that errors or fails to start comes back by itself (1 s doubling to
 * 1 day, activation error, error workflow), closers are bounded, static data is merged on emit, the
 * run result reaches `responsePromise` and a Respond to Webhook output reaches `responseHook`.
 */
import type {
  DataObject,
  NodePackage,
  NodeTypeDescription,
  TriggerContext,
  TriggerRunResult,
  WebhookResponse,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveWorkflowManager } from '../src/services/active-workflows';
import type { Leadership } from '../src/services/queue';
import {
  closeBounded,
  TRIGGER_CLOSE_TIMEOUT_MS,
  TRIGGER_RETRY_FIRST_MS,
  TRIGGER_RETRY_MAX_MS,
  TriggerRetryQueue,
} from '../src/services/trigger-retry';
import {
  chain,
  createTestServer,
  createWorkflow,
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

/** the test server a reconnecting trigger talks to */
const remote = {
  up: true,
  attempts: [] as number[],
  clients: [] as TriggerContext[],
  closed: 0,
  reset() {
    this.up = true;
    this.attempts = [];
    this.clients = [];
    this.closed = 0;
  },
  /** every client loses its connection, as a broker restart does */
  drop(message = 'Connection lost') {
    for (const client of [...this.clients]) client.emitError(new Error(message));
  },
};

let stateContext: TriggerContext | undefined;
const stateSeen: unknown[] = [];

const runtimePackage: NodePackage = {
  name: 'p4-trigger-runtime-tests',
  credentials: [],
  nodes: [
    {
      description: description('rt.reconnecting'),
      async trigger(ctx) {
        remote.attempts.push(Date.now());
        if (!remote.up) throw new Error('Connection refused');
        remote.clients.push(ctx);
        return {
          closeFunction: async () => {
            remote.closed++;
            remote.clients = remote.clients.filter((c) => c !== ctx);
          },
        };
      },
    },
    {
      description: description('rt.slowRefuses'),
      async trigger() {
        await new Promise((r) => setTimeout(r, 300));
        throw new Error('Connection refused late');
      },
    },
    {
      description: description('rt.neverCloses'),
      async trigger() {
        return { closeFunction: () => new Promise<void>(() => {}) };
      },
    },
    {
      description: description('rt.stateful'),
      async trigger(ctx) {
        const scope = ctx.getWorkflowStaticData('node') as { cursor?: number };
        stateSeen.push(scope.cursor ?? null);
        stateContext = ctx;
        return {};
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
  server = await createTestServer({}, { nodePackages: [runtimePackage] });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await server.ctx.activeWorkflows.stopAll();
  await resetDatabase(server.ctx);
  remote.reset();
  stateContext = undefined;
  stateSeen.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const manager = () => server.ctx.activeWorkflows;
const LONG = { timeout: 15_000 };

const reconnecting = (settings: DataObject = {}) => ({
  nodes: [node('Events', 'rt.reconnecting')],
  settings,
});

async function activated(data: Parameters<typeof createWorkflow>[1]) {
  const owner = await signup(server.app);
  const wf = await createWorkflow(owner.client, data);
  await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
  return { ...owner, wf };
}

describe('TriggerRetryQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits 1 s, doubles each time and stops at 1 day', () => {
    const queue = new TriggerRetryQueue();
    const fired = vi.fn();
    const delays: number[] = [];
    for (let i = 0; i < 20; i++) delays.push(queue.schedule('w1', fired));
    expect(delays[0]).toBe(TRIGGER_RETRY_FIRST_MS);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[19]).toBe(TRIGGER_RETRY_MAX_MS);
    expect(TRIGGER_RETRY_MAX_MS).toBe(86_400_000);
    queue.clearAll();
  });

  it('fires once after the delay, and only the last schedule', () => {
    const queue = new TriggerRetryQueue();
    const first = vi.fn();
    const second = vi.fn();
    queue.schedule('w1', first);
    queue.schedule('w1', second);
    vi.advanceTimersByTime(2_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100_000);
    expect(second).toHaveBeenCalledTimes(1);
    queue.clearAll();
  });

  it('clear stops the timer and starts the next schedule at 1 s again', () => {
    const queue = new TriggerRetryQueue();
    const fired = vi.fn();
    queue.schedule('w1', fired);
    queue.schedule('w1', fired);
    expect(queue.has('w1')).toBe(true);
    queue.clear('w1');
    expect(queue.has('w1')).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(fired).not.toHaveBeenCalled();
    expect(queue.schedule('w1', fired)).toBe(TRIGGER_RETRY_FIRST_MS);
    queue.clearAll();
    vi.advanceTimersByTime(10_000);
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('closeBounded', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up on a closer that hangs after 10 s', async () => {
    expect(TRIGGER_CLOSE_TIMEOUT_MS).toBe(10_000);
    const closing = closeBounded(() => new Promise<void>(() => {}));
    const failed = expect(closing).rejects.toThrow('did not close within 10 seconds');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
  });

  it('answers a closer that finishes, throws at once or rejects', async () => {
    await expect(closeBounded(async () => {})).resolves.toBeUndefined();
    await expect(
      closeBounded(() => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(closeBounded(async () => Promise.reject(new Error('async')))).rejects.toThrow('async');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('restart after an error', () => {
  it('a trigger whose server drops comes back by itself', async () => {
    const { wf, tenant } = await activated(reconnecting());
    expect(manager().runningWorkflowIds).toContain(wf.id);
    expect(remote.clients).toHaveLength(1);

    remote.up = false;
    remote.drop();
    await waitFor(async () => manager().activationErrorOf(wf.id));
    expect(manager().activationErrorOf(wf.id)).toContain('Connection lost');
    expect(manager().runningWorkflowIds).not.toContain(wf.id);
    expect(remote.closed).toBe(1);

    remote.up = true;
    await waitFor(async () => remote.clients.length === 1, LONG);
    await waitFor(async () => !manager().activationErrorOf(wf.id));
    expect(manager().runningWorkflowIds).toContain(wf.id);

    remote.clients[0].emit([[{ json: { back: true } }]]);
    const runs = await waitFor(async () => {
      const list = await server.ctx.repos.executions.list(tenant.id, { limit: 10 });
      return list.length ? list : undefined;
    });
    expect(runs[0].mode).toBe('trigger');
  });

  it('handles many errors of one trigger as one failure', async () => {
    const { wf } = await activated(reconnecting());
    const errorRun = vi.spyOn(server.ctx.executions, 'runActivationErrorWorkflow');
    const [client] = remote.clients;
    client.emitError(new Error('first'));
    client.emitError(new Error('second'));
    await waitFor(async () => !manager().runningWorkflowIds.includes(wf.id));
    await waitFor(async () => errorRun.mock.calls.length > 0);
    // back up after the 1 s retry; the old context is no longer listened to
    await waitFor(async () => remote.clients.length === 1, LONG);
    client.emitError(new Error('late'));
    await new Promise((r) => setTimeout(r, 100));
    expect(manager().runningWorkflowIds).toContain(wf.id);
    expect(errorRun).toHaveBeenCalledTimes(1);
    expect(errorRun.mock.calls[0][2]).toEqual({ message: 'first', node: 'Events' });
  });

  it('retries a failed start at start-up with a doubling delay', async () => {
    const { wf } = await activated(reconnecting());
    await manager().stopAll();
    remote.attempts = [];
    remote.up = false;
    await manager().startAll();
    expect(manager().activationErrorOf(wf.id)).toContain('Connection refused');
    expect(manager().runningWorkflowIds).not.toContain(wf.id);

    await waitFor(async () => remote.attempts.length >= 3, LONG);
    const [a, b, c] = remote.attempts;
    expect(b - a).toBeGreaterThanOrEqual(900);
    expect(b - a).toBeLessThan(1_900);
    expect(c - b).toBeGreaterThanOrEqual(1_900);

    remote.up = true;
    await waitFor(async () => !manager().activationErrorOf(wf.id), LONG);
    expect(manager().runningWorkflowIds).toContain(wf.id);
  });

  it('a publish that fails to start answers the error and queues no retry', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, reconnecting());
    remote.up = false;
    const res = await owner.client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(400);
    const tried = remote.attempts.length;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(remote.attempts.length).toBe(tried);
  });

  it('deactivating clears the retry timer and the activation error', async () => {
    const { wf, client } = await activated(reconnecting());
    remote.up = false;
    remote.drop();
    await waitFor(async () => manager().activationErrorOf(wf.id));
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    expect(manager().activationErrorOf(wf.id)).toBeUndefined();
    const tried = remote.attempts.length;
    remote.up = true;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(remote.attempts.length).toBe(tried);
    expect(manager().runningWorkflowIds).not.toContain(wf.id);
  });

  it('stopAll clears every retry timer (this main is no longer the leader)', async () => {
    const { wf } = await activated(reconnecting());
    remote.up = false;
    remote.drop();
    await waitFor(async () => manager().activationErrorOf(wf.id));
    await manager().stopAll();
    const tried = remote.attempts.length;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(remote.attempts.length).toBe(tried);
  });
});

describe('a start another main asked for', () => {
  const notLeader: Leadership = { isLeader: false, start: async () => {}, stop: async () => {} };
  const follower = (triggerStartTimeoutMs?: number) =>
    new ActiveWorkflowManager({
      config: server.ctx.config,
      database: server.ctx.database,
      repos: server.ctx.repos,
      nodeTypes: server.ctx.registries.nodeTypes,
      executions: server.ctx.executions,
      logger: server.ctx.logger,
      bus: server.ctx.bus,
      leadership: notLeader,
      triggerStartTimeoutMs,
    });
  /** the leader of the test server measures the wait with the same setting as the asker */
  const leaderWait = (ms: number) => {
    const { deps } = manager() as unknown as { deps: { triggerStartTimeoutMs?: number } };
    deps.triggerStartTimeoutMs = ms;
    return () => {
      deps.triggerStartTimeoutMs = undefined;
    };
  };

  it('a rollback that cannot restart the old version queues a retry on the leader', async () => {
    const { wf, client, tenant } = await activated(reconnecting());
    const updated = await client.data<{ versionId: string }>(
      client.patch(`/rest/workflows/${wf.id}`, { name: 'Second', versionId: wf.versionId }),
    );
    // a second main publishes the new version while the broker is down
    remote.up = false;
    const warn = vi.spyOn(server.ctx.logger, 'warn');
    const other = follower();
    await expect(other.activate(tenant.id, wf.id, { versionId: updated.versionId })).rejects.toMatchObject({
      code: 'activation_failed',
    });

    expect(warn.mock.calls.some((call) => call[1] === 'Restarting triggers failed')).toBe(false);
    await waitFor(async () => manager().activationErrorOf(wf.id));
    expect(manager().activationErrorOf(wf.id)).toContain('Connection refused');
    remote.up = true;
    await waitFor(async () => manager().runningWorkflowIds.includes(wf.id), LONG);
    await waitFor(async () => !manager().activationErrorOf(wf.id), LONG);
  });

  it('a failure after the asker stopped waiting queues a retry, as nobody hears the answer', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [node('Events', 'rt.slowRefuses')] });
    const restore = leaderWait(100);
    try {
      const row = await follower(100).activate(owner.tenant.id, wf.id);
      expect(row.active).toBe(true);
      await waitFor(async () => manager().activationErrorOf(wf.id));
      expect(manager().activationErrorOf(wf.id)).toContain('Connection refused late');
    } finally {
      restore();
    }
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/deactivate`));
  });

  it('a failure the asker still waits for only answers it', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, reconnecting());
    remote.up = false;
    await expect(follower().activate(owner.tenant.id, wf.id)).rejects.toMatchObject({
      code: 'activation_failed',
    });
    expect(manager().activationErrorOf(wf.id)).toBeUndefined();
    const tried = remote.attempts.length;
    await new Promise((r) => setTimeout(r, 1_300));
    expect(remote.attempts.length).toBe(tried);
  });
});

describe('GET /active-workflows/error/:id', () => {
  const url = (id: string) => `/rest/active-workflows/error/${id}`;

  it('answers why the triggers are down, and null once they are up', async () => {
    const { wf, client } = await activated(reconnecting());
    expect(await client.data(client.get(url(wf.id)))).toBeNull();
    remote.up = false;
    remote.drop();
    await waitFor(async () => manager().activationErrorOf(wf.id));
    expect(await client.data(client.get(url(wf.id)))).toContain('Connection lost');
    remote.up = true;
    await waitFor(async () => !manager().activationErrorOf(wf.id), LONG);
    expect(await client.data(client.get(url(wf.id)))).toBeNull();
  });

  it('checks the role and the tenant', async () => {
    const { wf, client } = await activated(reconnecting());
    remote.up = false;
    remote.drop();
    await waitFor(async () => manager().activationErrorOf(wf.id));

    const invite = await client.data<{ token: string }>(
      client.post('/rest/members/invite', { email: 'viewer-p4-error@example.com', role: 'viewer' }),
    );
    const viewer = new TestClient(server.app);
    await viewer.data(
      viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'Viewer', password: 'Passw0rd!' }),
    );
    expect(await viewer.data(viewer.get(url(wf.id)))).toContain('Connection lost');

    const other = await signup(server.app, { workspaceName: 'Other' });
    const res = await other.client.get(url(wf.id));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('could not be found');
    expect(res.body).not.toContain('Connection lost');
    expect((await new TestClient(server.app).get(url(wf.id))).statusCode).toBe(401);
  });
});

describe('error workflow on an activation error', () => {
  const errorFlow = {
    nodes: [node('On error', 'core.errorTrigger')],
  };

  it('runs once with the error and the workflow, without a source execution', async () => {
    const owner = await signup(server.app);
    const handler = await createWorkflow(owner.client, errorFlow);
    const wf = await createWorkflow(owner.client, {
      ...reconnecting({ errorWorkflow: handler.id }),
      name: 'Listens to a broker',
    });
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));

    remote.up = false;
    remote.drop('Broker went away');
    const errorRuns = () =>
      server.ctx.repos.executions
        .list(owner.tenant.id, { limit: 10 })
        .then((list) => list.filter((e) => e.mode === 'error'));
    const [run] = await waitFor(async () => {
      const list = await errorRuns();
      return list.length ? list : undefined;
    });
    expect(run.workflowId).toBe(handler.id);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, run.id);
    const options = data?.runOptions as { triggerItems: Array<{ json: DataObject }> };
    expect(options.triggerItems[0].json).toEqual({
      trigger: {
        error: { name: 'WorkflowActivationError', message: 'Broker went away', node: { name: 'Events' } },
        mode: 'trigger',
      },
      workflow: { id: wf.id, name: 'Listens to a broker' },
    });

    // the failed retries do not start it again
    await waitFor(async () => remote.attempts.length >= 3, LONG);
    expect(await errorRuns()).toHaveLength(1);
  });

  it('does nothing without an error workflow, or when the workflow is gone', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, reconnecting());
    const { executions } = server.ctx;
    const error = { message: 'x' };
    await expect(executions.runActivationErrorWorkflow(owner.tenant.id, wf.id, error)).resolves.toBeUndefined();
    await expect(
      executions.runActivationErrorWorkflow(owner.tenant.id, '00000000-0000-4000-8000-000000000000', error),
    ).resolves.toBeUndefined();
    expect(await server.ctx.repos.executions.list(owner.tenant.id, { limit: 10 })).toEqual([]);
  });

  it('never reads an error workflow of another tenant', async () => {
    const other = await signup(server.app, { workspaceName: 'Other' });
    const foreign = await createWorkflow(other.client, errorFlow);
    const owner = await signup(server.app, { workspaceName: 'Mine' });
    const wf = await createWorkflow(owner.client, reconnecting({ errorWorkflow: foreign.id }));
    await server.ctx.executions.runActivationErrorWorkflow(owner.tenant.id, wf.id, { message: 'x' });
    expect(await server.ctx.repos.executions.list(other.tenant.id, { limit: 10 })).toEqual([]);
    expect(await server.ctx.repos.executions.list(owner.tenant.id, { limit: 10 })).toEqual([]);
  });
});

describe('closing', () => {
  it('a closer that hangs does not hold the deactivation past 10 s', async () => {
    const { wf, client } = await activated({ nodes: [node('Stuck', 'rt.neverCloses')] });
    const started = Date.now();
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(9_500);
    expect(took).toBeLessThan(13_000);
    expect(manager().runningWorkflowIds).not.toContain(wf.id);
  });
});

describe('static data', () => {
  it('is merged on emit, reaches the run and survives a restart', async () => {
    const { wf, tenant } = await activated({ nodes: [node('State', 'rt.stateful')] });
    const ctx = await waitFor(async () => stateContext);
    (ctx.getWorkflowStaticData('node') as { cursor?: number }).cursor = 5;
    ctx.emit([[{ json: {} }]]);

    const stored = await waitFor(async () => {
      const data = await server.ctx.repos.staticData.get(tenant.id, wf.id);
      return (data?.['node:State'] as { cursor?: number } | undefined)?.cursor ? data : undefined;
    });
    expect(stored?.['node:State']).toEqual({ cursor: 5 });

    const [run] = await waitFor(async () => {
      const list = await server.ctx.repos.executions.list(tenant.id, { limit: 5 });
      return list.length ? list : undefined;
    });
    const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
    const definition = data?.workflowData as { staticData?: DataObject };
    expect(definition.staticData?.['node:State']).toEqual({ cursor: 5 });

    await manager().stopAll();
    await manager().startAll();
    expect(stateSeen).toEqual([null, 5]);
  });

  it('keeps what the trigger wrote without an emit when it stops', async () => {
    const { wf, tenant } = await activated({ nodes: [node('State', 'rt.stateful')] });
    const ctx = await waitFor(async () => stateContext);
    (ctx.getWorkflowStaticData('node') as { cursor?: number }).cursor = 9;
    await manager().stopTriggers(wf.id);
    const stored = await server.ctx.repos.staticData.get(tenant.id, wf.id);
    expect(stored?.['node:State']).toEqual({ cursor: 9 });
  });

  it('an emit does not put back a key a run changed since the trigger started', async () => {
    const { wf, tenant } = await activated({ nodes: [node('State', 'rt.stateful')] });
    const ctx = await waitFor(async () => stateContext);
    const before = (await server.ctx.repos.staticData.get(tenant.id, wf.id)) ?? {};
    await server.ctx.repos.staticData.merge(tenant.id, wf.id, before, { ...before, global: { byRun: 1 } });
    (ctx.getWorkflowStaticData('node') as { cursor?: number }).cursor = 1;
    ctx.emit([[{ json: {} }]]);
    await waitFor(async () => {
      const data = await server.ctx.repos.staticData.get(tenant.id, wf.id);
      return data?.['node:State'] ? data : undefined;
    });
    const stored = await server.ctx.repos.staticData.get(tenant.id, wf.id);
    expect(stored?.global).toEqual({ byRun: 1 });
  });
});

describe('run result and response hook', () => {
  const emitWithResult = (ctx: TriggerContext, hook?: (r: WebhookResponse) => void) =>
    new Promise<TriggerRunResult>((resolve, reject) => {
      ctx.emit([[{ json: { n: 1 } }]], { resolve, reject }, hook);
    });

  it('resolves with the status of a run that ended well', async () => {
    await activated(reconnecting());
    const result = await emitWithResult(remote.clients[0]);
    expect(result).toEqual({ executionId: expect.any(String), status: 'success' });
  });

  it('resolves, not rejects, when the run fails', async () => {
    const { nodes } = reconnecting();
    await activated({
      nodes: [...nodes, node('Boom', 'core.code', { jsCode: 'throw new Error("run failed")' }, [200, 0])],
      connections: chain('Events', 'Boom'),
    });
    const result = await emitWithResult(remote.clients[0]);
    expect(result.status).toBe('error');
    expect(result.error).toContain('run failed');
    expect(result.executionId).toEqual(expect.any(String));
  });

  it('rejects when the run cannot start', async () => {
    await activated(reconnecting());
    vi.spyOn(server.ctx.executions, 'start').mockRejectedValueOnce(new Error('The monthly limit is reached'));
    await expect(emitWithResult(remote.clients[0])).rejects.toThrow('The monthly limit is reached');
  });

  it('rejects when the trigger has stopped', async () => {
    const { wf } = await activated(reconnecting());
    const [client] = remote.clients;
    await manager().stopTriggers(wf.id);
    await expect(emitWithResult(client)).rejects.toThrow('stopped');
  });

  it('hands a Respond to Webhook output to the response hook', async () => {
    const { nodes } = reconnecting();
    await activated({
      nodes: [
        ...nodes,
        node('Reply', 'core.respondToWebhook', { respondWith: 'text', responseText: 'handled' }, [200, 0]),
      ],
      connections: chain('Events', 'Reply'),
    });
    const replies: WebhookResponse[] = [];
    const result = await emitWithResult(remote.clients[0], (r) => replies.push(r));
    expect(result.status).toBe('success');
    expect(replies).toHaveLength(1);
    expect(replies[0].body).toBe('handled');
  });

  it('a response hook that throws does not fail the run', async () => {
    const { nodes } = reconnecting();
    await activated({
      nodes: [
        ...nodes,
        node('Reply', 'core.respondToWebhook', { respondWith: 'text', responseText: 'x' }, [200, 0]),
      ],
      connections: chain('Events', 'Reply'),
    });
    const result = await emitWithResult(remote.clients[0], () => {
      throw new Error('hook failed');
    });
    expect(result.status).toBe('success');
  });
});
