/** Tenant isolation: another tenant can never see or act on these resources. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
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

describe('tenant isolation', () => {
  it('returns 404 for every resource of another tenant', async () => {
    const a = await signup(server.app, { workspaceName: 'Tenant A' });
    const b = await signup(server.app, { workspaceName: 'Tenant B' });

    const workflow = await createWorkflow(a.client, {
      nodes: [
        node('Webhook', 'core.webhook', { path: 'orders', httpMethod: 'POST' }, [0, 0], { webhookId: 'w1' }),
        node('Wait', 'test.wait', {}, [200, 0]),
      ],
      connections: chain('Webhook', 'Wait'),
    });
    const credential = await a.client.data(
      a.client.post('/rest/credentials', { name: 'A key', type: 'testApi', data: { apiKey: 'a-secret' } }),
    );
    const variable = await a.client.data(a.client.post('/rest/variables', { key: 'A_VAR', value: 'a' }));
    const tag = await a.client.data(a.client.post('/rest/tags', { name: 'a-tag' }));
    await a.client.data(a.client.post(`/rest/workflows/${workflow.id}/activate`));

    // a waiting execution in tenant A
    const hook = await server.app.inject({
      method: 'POST',
      url: `/webhook/${a.tenant.slug}/orders`,
      payload: { id: 1 },
    });
    expect(hook.statusCode).toBe(200);
    const [execution] = await server.ctx.repos.executions.list(a.tenant.id, { limit: 10 });
    await waitForExecution(server.ctx, a.tenant.id, execution.id, ['waiting']);

    const forbidden: Array<[string, Promise<{ statusCode: number }>]> = [
      ['get workflow', b.client.get(`/rest/workflows/${workflow.id}`)],
      [
        'patch workflow',
        b.client.patch(`/rest/workflows/${workflow.id}`, { versionId: workflow.versionId, name: 'x' }),
      ],
      ['delete workflow', b.client.delete(`/rest/workflows/${workflow.id}`)],
      ['run workflow', b.client.post(`/rest/workflows/${workflow.id}/run`, {})],
      ['activate workflow', b.client.post(`/rest/workflows/${workflow.id}/deactivate`)],
      ['versions', b.client.get(`/rest/workflows/${workflow.id}/versions`)],
      ['webhook urls', b.client.get(`/rest/workflows/${workflow.id}/webhook-urls`)],
      [
        'listen',
        b.client.post(`/rest/workflows/${workflow.id}/listen-test-webhook`, { nodeName: 'Webhook' }),
      ],
      ['get credential', b.client.get(`/rest/credentials/${credential.id}`)],
      ['patch credential', b.client.patch(`/rest/credentials/${credential.id}`, { name: 'x' })],
      ['delete credential', b.client.delete(`/rest/credentials/${credential.id}`)],
      [
        'test credential',
        b.client.post('/rest/credentials/test', { type: 'testApi', id: credential.id, data: {} }),
      ],
      ['oauth', b.client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`)],
      ['get execution', b.client.get(`/rest/executions/${execution.id}`)],
      ['stop execution', b.client.post(`/rest/executions/${execution.id}/stop`)],
      ['retry execution', b.client.post(`/rest/executions/${execution.id}/retry`, {})],
      ['delete execution', b.client.delete(`/rest/executions/${execution.id}`)],
      ['get variable', b.client.get(`/rest/variables/${variable.id}`)],
      ['patch variable', b.client.patch(`/rest/variables/${variable.id}`, { value: 'x' })],
      ['delete variable', b.client.delete(`/rest/variables/${variable.id}`)],
      ['get tag', b.client.get(`/rest/tags/${tag.id}`)],
      ['delete tag', b.client.delete(`/rest/tags/${tag.id}`)],
    ];
    for (const [label, promise] of forbidden) {
      const res = await promise;
      expect({ label, status: res.statusCode }).toEqual({ label, status: 404 });
    }

    // lists only show the caller's own resources
    expect(await b.client.data(b.client.get('/rest/workflows'))).toEqual([]);
    expect(await b.client.data(b.client.get('/rest/credentials'))).toEqual([]);
    expect(await b.client.data(b.client.get('/rest/executions'))).toEqual([]);
    expect(await b.client.data(b.client.get('/rest/variables'))).toEqual([]);
    expect(await b.client.data(b.client.get('/rest/tags'))).toEqual([]);
    expect(await b.client.data(b.client.get(`/rest/executions?workflowId=${workflow.id}`))).toEqual([]);

    // tenant B cannot attach tenant A's tag or call A's webhook under its own slug
    const own = await b.client.post('/rest/workflows', { name: 'b', nodes: [], tagIds: [tag.id] });
    expect(own.statusCode).toBe(400);
    const crossHook = await server.app.inject({ method: 'POST', url: `/webhook/${b.tenant.slug}/orders` });
    expect(crossHook.statusCode).toBe(404);

    // B's own workflow can register the same path: webhook paths are namespaced per tenant
    const bWorkflow = await createWorkflow(b.client, {
      nodes: [
        node('Webhook', 'core.webhook', { path: 'orders', httpMethod: 'POST' }, [0, 0], { webhookId: 'w2' }),
      ],
    });
    await b.client.data(b.client.post(`/rest/workflows/${bWorkflow.id}/activate`));
    const bHook = await server.app.inject({ method: 'POST', url: `/webhook/${b.tenant.slug}/orders` });
    expect(bHook.statusCode).toBe(200);
    expect((await server.ctx.repos.executions.list(a.tenant.id, { limit: 10 })).length).toBe(1);

    // nothing was changed in tenant A
    const still = await server.ctx.repos.executions.get(a.tenant.id, execution.id);
    expect(still?.status).toBe('waiting');
    expect((await a.client.get(`/rest/credentials/${credential.id}`)).statusCode).toBe(200);
    expect((await a.client.get(`/rest/variables/${variable.id}`)).statusCode).toBe(200);
  });

  it('defines row-level security policies for roles other than the application owner', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    await createWorkflow(a.client, { nodes: [] });
    await createWorkflow(b.client, { nodes: [] });
    const pool = server.ctx.database.pool;
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool.query('GRANT SELECT ON workflows, tenants TO workflow_rls_probe');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      expect((await client.query('SELECT count(*)::int AS n FROM workflows')).rows[0].n).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenant.id]);
      const rows = (await client.query('SELECT tenant_id FROM workflows')).rows;
      expect(rows).toEqual([{ tenant_id: a.tenant.id }]);
      expect((await client.query('SELECT id FROM tenants')).rows).toEqual([{ id: a.tenant.id }]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // the application role (table owner) is not restricted
    expect((await pool.query('SELECT count(*)::int AS n FROM workflows')).rows[0].n).toBe(2);
  });

  it('never resolves credentials of another tenant inside executions', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const credential = await a.client.data(
      a.client.post('/rest/credentials', { name: 'A key', type: 'testApi', data: { apiKey: 'a-secret' } }),
    );
    // tenant B references A's credential id in its own workflow
    const workflow = await createWorkflow(b.client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Use', 'test.useCredential', {}, [200, 0], {
          credentials: { testApi: { id: credential.id, name: 'A key' } },
        }),
      ],
      connections: chain('Start', 'Use'),
    });
    const { executionId } = await b.client.data(b.client.post(`/rest/workflows/${workflow.id}/run`, {}));
    const row = await waitForExecution(server.ctx, b.tenant.id, executionId);
    expect(row.status).toBe('error');
    expect(row.errorMessage).toMatch(/not found/);
  });

  it('a resume URL only resumes its own execution, scoped to its own tenant', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const make = async (client: typeof a.client) => {
      const wf = await createWorkflow(client, {
        nodes: [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', {}, [200, 0])],
        connections: chain('Start', 'Wait'),
      });
      const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
      return executionId as string;
    };
    const aExecution = await make(a.client);
    const bExecution = await make(b.client);
    await waitForExecution(server.ctx, a.tenant.id, aExecution, ['waiting']);
    await waitForExecution(server.ctx, b.tenant.id, bExecution, ['waiting']);

    // tenant B's REST API cannot stop or delete A's waiting execution
    expect((await b.client.post(`/rest/executions/${aExecution}/stop`)).statusCode).toBe(404);

    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook-waiting/${bExecution}`,
      payload: { from: 'b' },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, b.tenant.id, bExecution, ['success']);
    expect((await server.ctx.repos.executions.get(a.tenant.id, aExecution))?.status).toBe('waiting');
    // ids are not guessable and malformed ids are rejected
    expect((await server.app.inject({ method: 'POST', url: '/webhook-waiting/not-a-uuid' })).statusCode).toBe(
      404,
    );
  });
});
