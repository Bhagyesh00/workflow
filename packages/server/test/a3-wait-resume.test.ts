import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
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

/** the signed path of an execution's resume URL */
const resumePath = (executionId: string) => new URL(server.ctx.executions.resumeUrl(executionId)).pathname;

describe('resume webhooks of the Wait node', () => {
  it('a public webhook caller cannot end a time interval wait early (R36, R48)', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'order', responseMode: 'lastNode' },
          [0, 0],
          {
            webhookId: 'order-hook',
          },
        ),
        node('Wait', 'core.wait', { resume: 'timeInterval', amount: 1, unit: 'days' }, [200, 0]),
        setNode('Charge', 'charged', 'yes', [400, 0]),
      ],
      connections: chain('Webhook', 'Wait', 'Charge'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));

    const started = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/order`,
      payload: { amount: 10 },
    });
    expect(started.statusCode).toBe(202);
    const [{ id: executionId }] = await executionsOf(server.ctx, tenant.id, wf.id);

    const early = await server.app.inject({
      method: 'POST',
      url: resumePath(executionId),
      payload: { injected: true },
    });
    expect(early.statusCode).toBe(404);
    const row = await server.ctx.repos.executions.get(tenant.id, executionId);
    expect(row?.status).toBe('waiting');
    expect(row!.waitTill!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('only resumes a webhook wait on its own suffix', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Wait',
          'core.wait',
          { resume: 'webhook', httpMethod: 'POST', options: { webhookSuffix: 'approve' } },
          [200, 0],
        ),
        setNode('After', 'done', 'yes', [400, 0]),
      ],
      connections: chain('Start', 'Wait', 'After'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);

    for (const url of [resumePath(executionId), `${resumePath(executionId)}/reject`]) {
      const wrong = await server.app.inject({ method: 'POST', url, payload: { approved: false } });
      expect(wrong.statusCode).toBe(404);
    }
    expect((await server.ctx.repos.executions.get(tenant.id, executionId))?.status).toBe('waiting');

    const res = await server.app.inject({
      method: 'POST',
      url: `${resumePath(executionId)}/approve`,
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(after.state, 'After')[0]).toMatchObject({ body: { approved: true }, done: 'yes' });
  });

  it('resumes a webhook wait without a suffix on the bare resume URL', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'core.wait', { resume: 'webhook', httpMethod: 'POST' }, [200, 0]),
      ],
      connections: chain('Start', 'Wait'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['waiting']);
    const res = await server.app.inject({
      method: 'POST',
      url: resumePath(executionId),
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
  });

  it('a webhook wait resumes only on the signed resume URL, which the public reply does not reveal (R48)', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, {
      nodes: [
        node(
          'Webhook',
          'core.webhook',
          { httpMethod: 'POST', path: 'refund', responseMode: 'lastNode' },
          [0, 0],
          {
            webhookId: 'refund-hook',
          },
        ),
        node('Approval', 'core.wait', { resume: 'webhook', httpMethod: 'POST' }, [200, 0]),
        setNode('Charge', 'resume', '={{ $execution.resumeUrl }}', [400, 0]),
      ],
      connections: chain('Webhook', 'Approval', 'Charge'),
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));

    const started = await server.app.inject({
      method: 'POST',
      url: `/webhook/${tenant.slug}/refund`,
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toEqual({ message: 'Workflow is waiting' });
    const [{ id: executionId }] = await executionsOf(server.ctx, tenant.id, wf.id);

    const signature = resumePath(executionId).split('/').pop()!;
    const forged = signature.slice(0, -2) + (signature.endsWith('AA') ? 'BB' : 'AA');
    for (const url of [
      `/webhook-waiting/${executionId}`,
      `/webhook-waiting/${executionId}/${forged}`,
      `/webhook-waiting/${executionId}/short`,
    ]) {
      const denied = await server.app.inject({ method: 'POST', url, payload: { approved: true } });
      expect(denied.statusCode).toBe(404);
    }
    expect((await server.ctx.repos.executions.get(tenant.id, executionId))?.status).toBe('waiting');

    const approved = await server.app.inject({
      method: 'POST',
      url: resumePath(executionId),
      payload: { approved: true },
    });
    expect(approved.statusCode).toBe(200);
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const after = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(after.state, 'Charge')[0]).toMatchObject({
      body: { approved: true },
      resume: `http://localhost:5678${resumePath(executionId)}`,
    });
  });
});
