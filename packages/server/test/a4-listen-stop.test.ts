/** A4 R53: stopping a test listener removes its registration on the server, on whichever main holds it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActiveWorkflowManager } from '../src/services/active-workflows';
import type { Leadership } from '../src/services/queue';
import { WorkflowService } from '../src/services/workflows';
import {
  createTestServer,
  createWorkflow,
  hookRegistry,
  memberAs,
  node,
  resetDatabase,
  signup,
  TestClient,
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
  await resetDatabase(server.ctx);
  hookRegistry.length = 0;
});

const webhook = (name: string, path: string) =>
  node(name, 'core.webhook', { httpMethod: 'POST', path }, [0, 0], { webhookId: `id-${name}` });

const remote = () => node('Remote', 'test.hookRegister', {}, [0, 0], { webhookId: 'remote-hook' });

/** a second main on the same bus and database: the main that a request reaches behind the load balancer */
const secondMain = async () => {
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

const listen = (client: TestClient, id: string, nodeName: string) =>
  client.data(client.post(`/rest/workflows/${id}/listen-test-webhook`, { nodeName }));
const stop = (client: TestClient, id: string, nodeName: string) =>
  client.request('DELETE', `/rest/workflows/${id}/listen-test-webhook`, { nodeName });

describe('R53: DELETE /workflows/:id/listen-test-webhook', () => {
  it('removes the registration so a call to the test URL no longer runs', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [webhook('Webhook', 'stop-me')] });
    await listen(client, wf.id, 'Webhook');
    expect(await server.ctx.testWebhooks.list(tenant.id)).toHaveLength(1);

    const res = await stop(client, wf.id, 'Webhook');
    expect(res.statusCode).toBe(200);
    expect(await server.ctx.testWebhooks.list(tenant.id)).toEqual([]);
    const call = await server.app.inject({ method: 'POST', url: `/webhook-test/${tenant.slug}/stop-me` });
    expect(call.statusCode).toBe(404);
    const executions = await server.ctx.repos.executions.list(tenant.id, { limit: 10 });
    expect(executions).toEqual([]);
  });

  it('removes only the registrations of that workflow and node', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [webhook('First', 'first'), webhook('Second', 'second')],
    });
    const other = await createWorkflow(client, { nodes: [webhook('First', 'other-first')] });
    await listen(client, wf.id, 'First');
    await listen(client, wf.id, 'Second');
    await listen(client, other.id, 'First');

    expect((await stop(client, wf.id, 'First')).statusCode).toBe(200);
    const left = await server.ctx.testWebhooks.list(tenant.id);
    expect(left.map((r) => `${r.workflowId}:${r.nodeName}`).sort()).toEqual(
      [`${wf.id}:Second`, `${other.id}:First`].sort(),
    );
  });

  it('is a no-op when nothing is listening', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [webhook('Webhook', 'idle')] });
    expect((await stop(client, wf.id, 'Webhook')).statusCode).toBe(200);
  });

  it('never touches another tenant and answers 404 for its workflow', async () => {
    const a = await signup(server.app, { workspaceName: 'Tenant A' });
    const b = await signup(server.app, { workspaceName: 'Tenant B' });
    const wf = await createWorkflow(a.client, { nodes: [webhook('Webhook', 'tenant-a')] });
    await listen(a.client, wf.id, 'Webhook');

    expect((await stop(b.client, wf.id, 'Webhook')).statusCode).toBe(404);
    expect(await server.ctx.testWebhooks.list(a.tenant.id)).toHaveLength(1);
  });

  it('requires the editor role and a signed-in user', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [webhook('Webhook', 'roles')] });
    await listen(owner.client, wf.id, 'Webhook');

    const { client: viewer } = await memberAs(owner, 'viewer', {
      email: 'viewer-a4@example.com',
      name: 'Viewer',
    });
    expect((await stop(viewer, wf.id, 'Webhook')).statusCode).toBe(403);
    expect((await stop(new TestClient(server.app), wf.id, 'Webhook')).statusCode).toBe(401);
    expect(await server.ctx.testWebhooks.list(owner.tenant.id)).toHaveLength(1);
  });

  it('rejects a body without a node name', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [webhook('Webhook', 'bad-body')] });
    expect(
      (await client.request('DELETE', `/rest/workflows/${wf.id}/listen-test-webhook`, {})).statusCode,
    ).toBe(400);
  });
});

describe('R53: third-party trigger provider hooks', () => {
  it('unregisters the provider hook right after DELETE', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [remote()] });
    await listen(client, wf.id, 'Remote');
    const testUrl = `http://localhost:5678/webhook-test/${tenant.slug}/remote-hook/events`;
    expect(hookRegistry).toEqual([{ action: 'create', url: testUrl }]);

    expect((await stop(client, wf.id, 'Remote')).statusCode).toBe(200);
    expect(hookRegistry).toEqual([
      { action: 'create', url: testUrl },
      { action: 'delete', url: testUrl },
    ]);
    expect(await server.ctx.testWebhooks.list(tenant.id)).toEqual([]);
  });

  it('leaves the provider hook of another tenant registered', async () => {
    const a = await signup(server.app, { workspaceName: 'Tenant A' });
    const b = await signup(server.app, { workspaceName: 'Tenant B' });
    const wfA = await createWorkflow(a.client, { nodes: [remote()] });
    const wfB = await createWorkflow(b.client, { nodes: [remote()] });
    await listen(a.client, wfA.id, 'Remote');
    await listen(b.client, wfB.id, 'Remote');
    const urlA = `http://localhost:5678/webhook-test/${a.tenant.slug}/remote-hook/events`;
    const urlB = `http://localhost:5678/webhook-test/${b.tenant.slug}/remote-hook/events`;

    expect((await stop(a.client, wfA.id, 'Remote')).statusCode).toBe(200);
    expect(hookRegistry.filter((h) => h.action === 'delete')).toEqual([{ action: 'delete', url: urlA }]);
    expect(await server.ctx.testWebhooks.list(b.tenant.id)).toHaveLength(1);

    // tenant B's own hook is still tracked: stopping it removes exactly its provider hook
    expect((await stop(b.client, wfB.id, 'Remote')).statusCode).toBe(200);
    expect(hookRegistry.filter((h) => h.action === 'delete')).toEqual([
      { action: 'delete', url: urlA },
      { action: 'delete', url: urlB },
    ]);
  });

  it('does not call the provider when another tenant tries to stop the listener', async () => {
    const a = await signup(server.app, { workspaceName: 'Tenant A' });
    const b = await signup(server.app, { workspaceName: 'Tenant B' });
    const wf = await createWorkflow(a.client, { nodes: [remote()] });
    await listen(a.client, wf.id, 'Remote');

    expect((await stop(b.client, wf.id, 'Remote')).statusCode).toBe(404);
    expect(hookRegistry.map((h) => h.action)).toEqual(['create']);
  });

  it('unregisters the provider hook when the DELETE reaches another main than the listen request', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [remote()] });
    const other = await secondMain();
    try {
      const tenantRow = (await server.ctx.repos.tenants.get(tenant.id))!;
      await other.workflows.listenTestWebhook(tenantRow, wf.id, { nodeName: 'Remote' }, {});
      const testUrl = `http://localhost:5678/webhook-test/${tenant.slug}/remote-hook/events`;
      expect(hookRegistry).toEqual([{ action: 'create', url: testUrl }]);

      // this main holds no provider hook for the node: the main that registered it removes it
      expect((await stop(client, wf.id, 'Remote')).statusCode).toBe(200);
      await waitFor(async () => hookRegistry.length === 2, { message: 'the provider hook to be removed' });
      expect(hookRegistry).toEqual([
        { action: 'create', url: testUrl },
        { action: 'delete', url: testUrl },
      ]);
      expect(await server.ctx.testWebhooks.list(tenant.id)).toEqual([]);
    } finally {
      await other.activeWorkflows.close();
    }
    expect(hookRegistry.filter((h) => h.action === 'delete')).toHaveLength(1);
  });

  it('removes the provider hooks a main still holds when it shuts down', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [remote()] });
    const other = await secondMain();
    const tenantRow = (await server.ctx.repos.tenants.get(tenant.id))!;
    await other.workflows.listenTestWebhook(tenantRow, wf.id, { nodeName: 'Remote' }, {});

    await other.activeWorkflows.close();

    const testUrl = `http://localhost:5678/webhook-test/${tenant.slug}/remote-hook/events`;
    expect(hookRegistry).toEqual([
      { action: 'create', url: testUrl },
      { action: 'delete', url: testUrl },
    ]);
  });
});
