/**
 * P3-16 publish timeline: every publish ('activated') and unpublish ('deactivated') is a row with
 * the version, the user and the time; GET /workflows/:id/publish-timeline lists them newest first.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  TestClient,
  type TestServer,
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

type Owner = Awaited<ReturnType<typeof signup>>;

const published = (path: string) => ({
  nodes: [
    node(
      'Webhook',
      'core.webhook',
      { httpMethod: 'POST', path, responseMode: 'lastNode', responseData: 'firstEntryJson' },
      [0, 0],
      { webhookId: `${path}-id` },
    ),
    setNode('Set', 'answer', 'v1'),
  ],
  connections: chain('Webhook', 'Set'),
});

async function viewerOf(owner: Owner) {
  const email = `viewer-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role: 'viewer' }));
  const client = new TestClient(server.app);
  await client.data(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: 'Vera Viewer', password: 'Passw0rd!' }),
  );
  return client;
}

const timeline = (client: TestClient, id: string, query = '') =>
  client.data<any[]>(client.get(`/rest/workflows/${id}/publish-timeline${query}`));

describe('P3-16 publish timeline', () => {
  it('publish then unpublish shows two entries, newest first, with version, user and time', async () => {
    const owner = await signup(server.app, { name: 'Pat Owner' });
    const wf = await createWorkflow(owner.client, published('timeline-a'));
    const before = Date.now();
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`, { versionName: 'Launch' }));
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/deactivate`));

    const rows = await timeline(owner.client, wf.id);
    expect(rows.map((r) => r.event)).toEqual(['deactivated', 'activated']);
    for (const row of rows) {
      expect(row).toMatchObject({
        versionId: wf.versionId,
        versionName: 'Launch',
        userId: owner.user.id,
        userName: 'Pat Owner',
      });
      expect(typeof row.id).toBe('string');
      expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
    expect(Number(rows[0].id)).toBeGreaterThan(Number(rows[1].id));
  });

  it('pages with skip and take (default 20)', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, published('timeline-page'));
    for (let i = 0; i < 11; i++) {
      await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
      await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/deactivate`));
    }
    expect(await timeline(owner.client, wf.id)).toHaveLength(20);
    expect(await timeline(owner.client, wf.id, '?skip=20')).toHaveLength(2);
    const page = await timeline(owner.client, wf.id, '?skip=1&take=2');
    expect(page.map((r) => r.event)).toEqual(['activated', 'deactivated']);
  });

  it('a viewer reads it; another tenant gets 404; no session gets 401', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, published('timeline-roles'));
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    const viewer = await viewerOf(owner);
    expect(await timeline(viewer, wf.id)).toHaveLength(1);

    const other = await signup(server.app);
    expect((await other.client.get(`/rest/workflows/${wf.id}/publish-timeline`)).statusCode).toBe(404);
    expect((await new TestClient(server.app).get(`/rest/workflows/${wf.id}/publish-timeline`)).statusCode).toBe(
      401,
    );
  });

  it('a row whose version was pruned keeps the event with versionId null', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, published('timeline-pruned'));
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/deactivate`));
    await server.ctx.database.pool.query('DELETE FROM workflow_versions WHERE id = $1', [wf.versionId]);

    const rows = await timeline(owner.client, wf.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ versionId: null, versionName: null });
  });

  it('record stays in the tenant, stores null for an unknown version and never throws', async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const wf = await createWorkflow(owner.client, published('timeline-record'));
    const { publishHistory } = server.ctx;

    // another tenant's workflow id: nothing is written
    await publishHistory.record('activated', { tenantId: other.tenant.id, workflowId: wf.id, versionId: wf.versionId });
    expect((await publishHistory.list(owner.tenant.id, wf.id, { skip: 0, take: 20 })).data).toEqual([]);
    expect((await publishHistory.list(other.tenant.id, wf.id, { skip: 0, take: 20 })).data).toEqual([]);

    // a version that does not exist (or is not a uuid) and an unknown user are stored as null
    await publishHistory.record('activated', {
      tenantId: owner.tenant.id,
      workflowId: wf.id,
      versionId: randomUUID(),
      userId: randomUUID(),
    });
    await publishHistory.record('deactivated', {
      tenantId: owner.tenant.id,
      workflowId: wf.id,
      versionId: 'not-a-uuid',
      userId: null,
    });
    const rows = (await publishHistory.list(owner.tenant.id, wf.id, { skip: 0, take: 20 })).data;
    expect(rows.map((r) => [r.event, r.versionId, r.userId])).toEqual([
      ['deactivated', null, null],
      ['activated', null, null],
    ]);

    // a workflow that no longer exists: resolves, nothing stored
    await expect(
      publishHistory.record('activated', { tenantId: owner.tenant.id, workflowId: randomUUID(), versionId: null }),
    ).resolves.toBeUndefined();
    const { rows: count } = await server.ctx.database.pool.query(
      'SELECT count(*)::int AS n FROM workflow_publish_history',
    );
    expect(count[0].n).toBe(2);
  });
});
