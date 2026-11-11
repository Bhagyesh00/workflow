/**
 * P6-04 (L2): the type policy on every run path. One check at run start (`ExecutionService.run`), so a run
 * of a workflow with a blocked type fails as an execution holding the violation, whatever started it: a
 * trigger start, a webhook, a retry, a resume, a queued run on a worker, a sub-workflow (saved or inline).
 * A manual run is refused before it starts; start-up leaves a blocked published workflow unstarted; the
 * store failing at start fails the run (fail closed).
 */
import { HttpClient } from '@workflow/core';
import { nodesBasePackage } from '@workflow/nodes-base';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  flushRedis,
  node,
  policyDeny,
  setNode,
  signup,
  TEST_REDIS,
  type TestServer,
  teamProjectOf,
  testConfig,
  testPackage,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

const BLOCKED = (type: string) => `Node type "${type}" is blocked by a workspace policy`;

let server: TestServer;
let signups = 0;
/** a new workspace with its team project, from its own IP (signup allows 20 an hour per IP) */
const newOwner = async (on: TestServer = server) => {
  signups++;
  const owner = await signup(on.app, { remoteAddress: `10.73.${signups >> 8}.${signups & 255}` });
  return { ...owner, projectId: await teamProjectOf(on, owner.tenant.id) };
};

const failing = (): { nodes: WorkflowNode[]; connections: Record<string, unknown> } => ({
  nodes: [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', {}, [200, 0])],
  connections: chain('Start', 'Boom'),
});

beforeAll(async () => {
  await flushRedis();
  server = await createTestServer();
}, 120_000);

afterAll(async () => {
  await server?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an old workflow with a blocked type', () => {
  it('saves, refuses to publish and a manual run; its run fails as an execution holding the violation', async () => {
    const { client, tenant, projectId } = await newOwner();
    const old = await workflowIn(server, tenant.id, projectId, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 }), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const current = await client.data(client.get(`/rest/workflows/${old.id}`));
    const saved = await client.patch(`/rest/workflows/${old.id}`, {
      versionId: current.versionId,
      name: 'Kept',
    });
    expect(saved.statusCode).toBe(200);

    const publish = await client.post(`/rest/workflows/${old.id}/activate`);
    expect(publish.statusCode).toBe(403);
    expect(publish.json().error.message).toBe(BLOCKED('core.set'));
    const manual = await client.post(`/rest/workflows/${old.id}/run`, {});
    expect(manual.statusCode).toBe(403);
    expect(manual.json().error.code).toBe('policy_violation');

    const row = await server.ctx.repos.workflows.get(tenant.id, old.id);
    const { executionId } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: {
        id: old.id,
        name: 'Kept',
        nodes: row!.nodes as WorkflowNode[],
        connections: row!.connections as never,
      },
      workflowId: old.id,
      mode: 'trigger',
    });
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('core.set') });
    const data = await server.ctx.repos.executions.getData(tenant.id, executionId);
    expect(JSON.stringify(data?.state)).toContain('blocked by a workspace policy');
  });
});

describe('run paths', () => {
  it('a webhook run fails', async () => {
    const { client, tenant } = await newOwner();
    const wf = await createWorkflow(client, {
      nodes: [
        node('Webhook', 'core.webhook', { httpMethod: 'POST', path: 'policy-hook' }, [0, 0], {
          webhookId: 'ph',
        }),
        setNode('Set', 'a', 1),
      ],
      connections: chain('Webhook', 'Set'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await policyDeny(server, tenant.id, 'node', 'core.set');
    await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/policy-hook`,
      payload: { v: 1 },
    });
    const run = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id))[0], {
      message: 'the webhook run',
    });
    const failed = await waitForExecution(server.ctx, tenant.id, run.id);
    expect(failed).toMatchObject({ status: 'error', mode: 'webhook', errorMessage: BLOCKED('core.set') });
  });

  it('a retry fails', async () => {
    const { client, tenant } = await newOwner();
    const wf = await createWorkflow(client, failing());
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    expect(await waitForExecution(server.ctx, tenant.id, executionId)).toMatchObject({
      status: 'error',
      errorMessage: 'Intentional failure',
    });
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    const retry = await client.data(client.post(`/rest/executions/${executionId}/retry`, {}));
    const failed = await waitForExecution(server.ctx, tenant.id, retry.executionId);
    expect(failed).toMatchObject({ status: 'error', mode: 'retry', errorMessage: BLOCKED('test.fail') });
  });

  it('a resume fails', async () => {
    const { client, tenant } = await newOwner();
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        setNode('Set', 'a', 1, [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'Set'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    await policyDeny(server, tenant.id, 'node', 'core.set');
    const resumed = await server.ctx.executions.resume(tenant.id, executionId);
    expect(resumed?.executionId).toBe(executionId);
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('core.set') });
  });

  it('a saved sub-workflow with a blocked type fails, and so does its caller', async () => {
    const { client, tenant, projectId } = await newOwner();
    const child = await workflowIn(server, tenant.id, projectId, failing());
    const parent = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    await policyDeny(server, tenant.id, 'node', 'test.fail');
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    expect((await waitForExecution(server.ctx, tenant.id, executionId)).status).toBe('error');
    const sub = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, child.id))[0], {
      message: 'the sub-run',
    });
    expect(await waitForExecution(server.ctx, tenant.id, sub.id)).toMatchObject({
      status: 'error',
      errorMessage: BLOCKED('test.fail'),
    });
  });

  it('an inline sub-workflow with a blocked type fails', async () => {
    const { client, tenant } = await newOwner();
    const parent = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Run inline',
          'core.executeWorkflow',
          {
            source: 'parameter',
            workflowJson: JSON.stringify({
              name: 'Inline',
              nodes: [
                node('Inner start', 'core.executeWorkflowTrigger'),
                node('Nothing', 'core.noOp', {}, [200, 0]),
              ],
              connections: chain('Inner start', 'Nothing'),
            }),
          },
          [200, 0],
        ),
      ],
      connections: chain('Start', 'Run inline'),
    });
    await policyDeny(server, tenant.id, 'node', 'core.noOp');
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const failed = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(failed.status).toBe('error');
    const runs = await executionsOf(server.ctx, tenant.id);
    const inline = runs.find((run) => run.id !== executionId);
    expect(inline).toBeDefined();
    expect(await waitForExecution(server.ctx, tenant.id, inline!.id)).toMatchObject({
      status: 'error',
      errorMessage: BLOCKED('core.noOp'),
    });
  });

  it('the store failing at start fails the run (fail closed)', async () => {
    const { client, tenant } = await newOwner();
    const wf = await createWorkflow(client, {
      nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'a', 1)],
      connections: chain('Start', 'Set'),
    });
    await server.ctx.policySnapshots.invalidate(tenant.id);
    vi.spyOn(server.ctx.repos.typePolicies, 'loadTenant').mockRejectedValue(new Error('database down'));
    const manual = await client.post(`/rest/workflows/${wf.id}/run`, {});
    expect(manual.statusCode).toBe(503);
    expect(manual.json().error.code).toBe('policy_check_failed');
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    const { executionId } = await server.ctx.executions.start({
      tenantId: tenant.id,
      workflow: {
        id: wf.id,
        name: 'x',
        nodes: row!.nodes as WorkflowNode[],
        connections: row!.connections as never,
      },
      workflowId: wf.id,
      mode: 'trigger',
    });
    expect(await waitForExecution(server.ctx, tenant.id, executionId)).toMatchObject({
      status: 'error',
      errorMessage: 'Could not verify policy for workflowStart, so the action was blocked',
    });
  });
});

describe('start-up', () => {
  it('leaves a blocked published workflow unstarted, with the violation as its activation error', async () => {
    const { client, tenant } = await newOwner();
    const wf = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 }), setNode('Set', 'a', 1)],
      connections: chain('Interval', 'Set'),
    });
    const allowed = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 60_000 })],
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await client.data(client.post(`/rest/workflows/${allowed.id}/activate`));
    const active = server.ctx.activeWorkflows;
    expect(active.runningWorkflowIds).toEqual(expect.arrayContaining([wf.id, allowed.id]));

    await policyDeny(server, tenant.id, 'node', 'core.set');
    await active.stopAll();
    await active.startAll();
    expect(active.runningWorkflowIds).toContain(allowed.id);
    expect(active.runningWorkflowIds).not.toContain(wf.id);
    expect(active.activationErrorOf(wf.id)).toBe(BLOCKED('core.set'));
    // still published: an admin who lifts the block gets it back at the next start-up
    expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(true);
    await active.stopAll();
  });
});

describe('queue mode', () => {
  const QUEUE_ENV = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfpolicy' };
  let main: TestServer;
  let worker: ServerContext;

  beforeAll(async () => {
    main = await createTestServer(QUEUE_ENV, { reset: false });
    worker = await createContext({
      config: testConfig({ ...QUEUE_ENV, BINARY_DATA_DIR: main.ctx.config.binaryData.dir }),
      nodePackages: [nodesBasePackage, testPackage],
      http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
      migrate: false,
    });
    await worker.startWorker();
  }, 120_000);

  afterAll(async () => {
    await main?.close();
    await worker?.close();
  });

  it('a queued run fails on the worker', async () => {
    const { tenant, projectId } = await newOwner(main);
    const old = await workflowIn(main, tenant.id, projectId, failing());
    await policyDeny(main, tenant.id, 'node', 'test.fail');
    const { executionId } = await main.ctx.executions.start({
      tenantId: tenant.id,
      workflow: { id: old.id, name: old.name, ...failing() } as never,
      workflowId: old.id,
      mode: 'trigger',
    });
    const failed = await waitForExecution(main.ctx, tenant.id, executionId, undefined, 20_000);
    expect(failed).toMatchObject({ status: 'error', errorMessage: BLOCKED('test.fail') });
    expect(main.ctx.executions.runningCount).toBe(0);
  });
});
