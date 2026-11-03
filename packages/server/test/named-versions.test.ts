/**
 * P3-10 named versions: save writes the draft only, publish registers a version, every runtime read
 * uses the published copy, executions record the version they ran, versions can be named.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/http/errors';
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
  TestClient,
  type TestServer,
  waitFor,
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
  vi.restoreAllMocks();
});

type Client = Awaited<ReturnType<typeof signup>>['client'];

const webhook = (path: string, webhookId = `${path}-id`) =>
  node(
    'Webhook',
    'core.webhook',
    { httpMethod: 'POST', path, responseMode: 'lastNode', responseData: 'firstEntryJson' },
    [0, 0],
    { webhookId },
  );

/** Webhook -> Set `field` = value */
const answering = (path: string, value: string) => ({
  nodes: [webhook(path), setNode('Set', 'answer', value)],
  connections: chain('Webhook', 'Set'),
});

async function member(owner: Awaited<ReturnType<typeof signup>>, role: 'editor' | 'viewer') {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  await client.data(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: role, password: 'Passw0rd!' }),
  );
  return client;
}

async function save(client: Client, id: string, patch: Record<string, unknown>) {
  const current = await client.data(client.get(`/rest/workflows/${id}`));
  return client.data(client.patch(`/rest/workflows/${id}`, { versionId: current.versionId, ...patch }));
}

const publish = (client: Client, id: string, body: Record<string, unknown> = {}) =>
  client.data(client.post(`/rest/workflows/${id}/activate`, body));

const hit = (slug: string, path: string) =>
  server.app.inject({ method: 'POST', url: `/webhook/${slug}/${path}`, payload: {} });

describe('P3-10 save vs publish', () => {
  it('(a, b) a saved draft never goes live; publishing it does, and runs record their version', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('orders', 'v1'));
    const published = await publish(client, wf.id);
    expect(published.publishedVersionId).toBe(wf.versionId);
    const activate = vi.spyOn(server.ctx.activeWorkflows, 'activate');

    const draft = await save(client, wf.id, answering('orders', 'v2'));
    expect(draft.versionId).not.toBe(wf.versionId);
    expect(draft.publishedVersionId).toBe(wf.versionId);
    expect(draft.active).toBe(true);
    expect(activate).not.toHaveBeenCalled();

    const first = await hit(tenant.slug, 'orders');
    expect(first.json()).toMatchObject({ answer: 'v1' });
    const [run] = await executionsOf(server.ctx, tenant.id, wf.id);
    expect(run.workflowVersionId).toBe(wf.versionId);

    const next = await publish(client, wf.id);
    expect(next.publishedVersionId).toBe(draft.versionId);
    expect((await hit(tenant.slug, 'orders')).json()).toMatchObject({ answer: 'v2' });
    const runs = await executionsOf(server.ctx, tenant.id, wf.id);
    expect(runs.map((r) => r.workflowVersionId).sort()).toEqual([wf.versionId, draft.versionId].sort());
  });

  it('(d) a publish that fails keeps the published version running', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('keep', 'v1'));
    await publish(client, wf.id);
    await save(client, wf.id, { nodes: [node('Noop', 'core.noOp')], connections: {} });
    const res = await client.post(`/rest/workflows/${wf.id}/activate`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('activation_failed');
    const row = await server.ctx.repos.workflows.get(tenant.id, wf.id);
    expect(row).toMatchObject({ active: true, publishedVersionId: wf.versionId });
    expect((await hit(tenant.slug, 'keep')).json()).toMatchObject({ answer: 'v1' });
  });

  it('(e) unpublish clears the pointer and the webhook', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('gone', 'v1'));
    await publish(client, wf.id);
    const record = vi.spyOn(server.ctx.publishHistory, 'record');
    const off = await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    expect(off).toMatchObject({ active: false, publishedVersionId: null });
    expect((await hit(tenant.slug, 'gone')).statusCode).toBe(404);
    expect(record).toHaveBeenCalledWith('deactivated', expect.objectContaining({ versionId: wf.versionId }));
  });

  it('publishes a chosen version with its name and description, and audits the version id', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('named', 'v1'));
    await save(client, wf.id, answering('named', 'v2'));
    const record = vi.spyOn(server.ctx.publishHistory, 'record');
    const afterPublished = vi.spyOn(server.ctx.reviews, 'afterWorkflowPublished');
    const done = await publish(client, wf.id, {
      versionId: wf.versionId,
      versionName: 'First release',
      description: 'The v1 answer',
    });
    expect(done.publishedVersionId).toBe(wf.versionId);
    expect((await hit(tenant.slug, 'named')).json()).toMatchObject({ answer: 'v1' });
    const versions = await client.data(client.get(`/rest/workflows/${wf.id}/versions`));
    expect(versions.find((v: { versionId: string }) => v.versionId === wf.versionId)).toMatchObject({
      versionName: 'First release',
      description: 'The v1 answer',
    });
    expect(record).toHaveBeenCalledWith('activated', expect.objectContaining({ versionId: wf.versionId }));
    expect(afterPublished).toHaveBeenCalledWith(tenant.id, wf.id, wf.versionId);
    const audit = await client.data(client.get('/rest/audit-log'));
    const activated = audit.find((a: { action: string }) => a.action === 'workflow.activated');
    expect(activated.metadata).toEqual({ versionId: wf.versionId });
  });

  it('refuses a version of another workflow (404) and a publish the review guard blocks (409)', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('guarded', 'v1'));
    const other = await createWorkflow(client, answering('elsewhere', 'x'));
    const foreign = await client.post(`/rest/workflows/${wf.id}/activate`, { versionId: other.versionId });
    expect(foreign.statusCode).toBe(404);
    vi.spyOn(server.ctx.reviews, 'assertCanPublish').mockRejectedValueOnce(
      ApiError.conflict('A review is pending', { reason: 'review_pending' }),
    );
    expect((await client.post(`/rest/workflows/${wf.id}/activate`)).statusCode).toBe(409);
    expect((await server.ctx.repos.workflows.get(tenant.id, wf.id))?.active).toBe(false);
  });

  it('applies a settings change of a published workflow without a publish', async () => {
    const { client, tenant } = await signup(server.app);
    const handler = await createWorkflow(client, {
      nodes: [node('Error Trigger', 'core.errorTrigger'), setNode('Note', 'handled', 'yes')],
      connections: chain('Error Trigger', 'Note'),
    });
    const wf = await createWorkflow(client, {
      nodes: [webhook('failing'), node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0])],
      connections: chain('Webhook', 'Boom'),
    });
    await publish(client, wf.id);
    const saved = await save(client, wf.id, { settings: { errorWorkflow: handler.id } });
    expect(saved.publishedVersionId).toBe(wf.versionId);
    await hit(tenant.slug, 'failing');
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
      message: 'error workflow execution',
    });

    // a trigger restarts with the new settings: its runs carry them
    const timer = await createWorkflow(client, {
      nodes: [node('Interval', 'test.interval', { intervalMs: 50 })],
    });
    await publish(client, timer.id);
    await save(client, timer.id, { settings: { timezone: 'Asia/Tokyo' } });
    await waitFor(
      async () => {
        for (const run of await executionsOf(server.ctx, tenant.id, timer.id)) {
          const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
          const settings = (data?.workflowData as { settings?: { timezone?: string } } | undefined)?.settings;
          if (settings?.timezone === 'Asia/Tokyo') return true;
        }
        return false;
      },
      { message: 'a run with the new timezone' },
    );
    await client.data(client.post(`/rest/workflows/${timer.id}/deactivate`));
  });

  it('public PUT publishes a published workflow unless publishIfActive=false', async () => {
    const { client, tenant } = await signup(server.app);
    const key = (await client.data(client.post('/rest/api-keys', { name: 'k' }))).key as string;
    const put = (id: string, query: string, body: unknown) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/v1/workflows/${id}${query}`,
        headers: { 'x-api-key': key },
        payload: body as object,
      });
    const wf = await createWorkflow(client, answering('public', 'v1'));
    await publish(client, wf.id);

    const kept = (await put(wf.id, '?publishIfActive=false', { ...answering('public', 'v2') })).json().data;
    expect(kept.publishedVersionId).toBe(wf.versionId);
    expect((await hit(tenant.slug, 'public')).json()).toMatchObject({ answer: 'v1' });

    const live = (await put(wf.id, '', { ...answering('public', 'v3') })).json().data;
    expect(live.publishedVersionId).toBe(live.versionId);
    expect((await hit(tenant.slug, 'public')).json()).toMatchObject({ answer: 'v3' });
  });

  it('public PUT whose publish is refused still restarts the triggers with the new settings', async () => {
    const { client, tenant } = await signup(server.app);
    const key = (await client.data(client.post('/rest/api-keys', { name: 'k' }))).key as string;
    const definition = { nodes: [node('Interval', 'test.interval', { intervalMs: 50 })], connections: {} };
    const timer = await createWorkflow(client, definition);
    await publish(client, timer.id);
    vi.spyOn(server.ctx.reviews, 'assertCanPublish').mockRejectedValueOnce(
      ApiError.conflict('A review is pending', { reason: 'review_pending' }),
    );
    const res = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/workflows/${timer.id}`,
      headers: { 'x-api-key': key },
      payload: { ...definition, settings: { timezone: 'Asia/Tokyo' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ active: true, publishedVersionId: timer.versionId });
    expect(res.json().data.activationError).toBeDefined();
    await waitFor(
      async () => {
        for (const run of await executionsOf(server.ctx, tenant.id, timer.id)) {
          const data = await server.ctx.repos.executions.getData(tenant.id, run.id);
          const settings = (data?.workflowData as { settings?: { timezone?: string } } | undefined)?.settings;
          if (settings?.timezone === 'Asia/Tokyo') return true;
        }
        return false;
      },
      { message: 'a run with the new timezone' },
    );
    await client.data(client.post(`/rest/workflows/${timer.id}/deactivate`));
  });
});

describe('P3-04 groups with sticky note members', () => {
  it('a group listing a sticky note passes on create, update and version restore', async () => {
    const { client } = await signup(server.app);
    const nodes = [node('Start', 'core.manualTrigger'), setNode('A', 'a', 1, [200, 0])];
    const sticky = { id: 's1', content: 'Note', position: [0, 200], width: 240, height: 160 };
    const nodeGroups = [{ id: 'g', name: 'G', nodeIds: [nodes[1].id, 's1'] }];
    const created = await client.data(
      client.post('/rest/workflows', {
        name: 'Sticky group',
        nodes,
        connections: {},
        stickyNotes: [sticky],
        nodeGroups,
      }),
    );
    const updated = await client.data(
      client.patch(`/rest/workflows/${created.id}`, {
        versionId: created.versionId,
        connections: chain('Start', 'A'),
      }),
    );
    expect(updated.nodeGroups).toEqual(nodeGroups);
    const restored = await client.data(
      client.post(`/rest/workflows/${created.id}/versions/${created.versionId}/restore`),
    );
    expect(restored.nodeGroups).toEqual(nodeGroups);

    // removing the sticky alone is checked again: the group would list a missing member
    const orphaned = await client.patch(`/rest/workflows/${created.id}`, {
      versionId: restored.versionId,
      stickyNotes: [],
    });
    expect(orphaned.statusCode).toBe(400);
    expect(orphaned.json().error.code).toBe('invalid_node_groups');
  });
});

describe('P3-10 version names', () => {
  it('(c) names and describes a version; null clears; viewer 403; another tenant 404', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, answering('rename', 'v1'));
    const url = `/rest/workflows/${wf.id}/versions/${wf.versionId}`;
    const named = await owner.client.data(
      owner.client.patch(url, { versionName: 'Launch', description: 'Ready' }),
    );
    expect(named).toMatchObject({ versionId: wf.versionId, versionName: 'Launch', description: 'Ready' });
    const cleared = await owner.client.data(owner.client.patch(url, { description: null }));
    expect(cleared).toMatchObject({ versionName: 'Launch', description: null });

    const viewer = await member(owner, 'viewer');
    expect((await viewer.patch(url, { versionName: 'x' })).statusCode).toBe(403);
    const other = await signup(server.app);
    expect((await other.client.patch(url, { versionName: 'x' })).statusCode).toBe(404);
    const otherWf = await createWorkflow(other.client, answering('mine', 'x'));
    expect(
      (
        await owner.client.patch(`/rest/workflows/${wf.id}/versions/${otherWf.versionId}`, {
          versionName: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('(g) filters executions by version', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, answering('filter', 'v1'));
    await publish(client, wf.id);
    await hit(tenant.slug, 'filter');
    const v2 = await save(client, wf.id, answering('filter', 'v2'));
    await publish(client, wf.id);
    await hit(tenant.slug, 'filter');
    await hit(tenant.slug, 'filter');
    const list = (version: string) =>
      client.data(client.get(`/rest/executions?workflowId=${wf.id}&workflowVersionId=${version}`));
    expect(await list(wf.versionId)).toHaveLength(1);
    const second = await list(v2.versionId);
    expect(second).toHaveLength(2);
    expect(second[0].workflowVersionId).toBe(v2.versionId);
  });
});

describe('P3-10 sub-workflows and error workflows', () => {
  /** a callee that answers `value`; its webhook only makes it publishable */
  const callee = (value: string, path: string) => ({
    nodes: [
      node('Called', 'core.executeWorkflowTrigger'),
      setNode('Set', 'answer', value),
      node('Hook', 'core.webhook', { httpMethod: 'POST', path }, [0, 300], { webhookId: `${path}-id` }),
    ],
    connections: chain('Called', 'Set'),
  });

  it('(h) a manual root runs callee drafts (nested too), a production root runs the published callee', async () => {
    const { client, tenant } = await signup(server.app);
    const child = await createWorkflow(client, callee('published', 'child'));
    await publish(client, child.id);
    await save(client, child.id, callee('draft', 'child'));

    const middle = await createWorkflow(client, {
      nodes: [
        node('Called', 'core.executeWorkflowTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Called', 'Call'),
    });
    const manual = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    const nested = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: middle.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    const runOf = async (id: string) => {
      const { executionId } = await client.data(client.post(`/rest/workflows/${id}/run`, {}));
      await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
      const data = await client.data(client.get(`/rest/executions/${executionId}`));
      return outputOf(data.state, 'Call');
    };
    expect(await runOf(manual.id)).toMatchObject([{ answer: 'draft' }]);
    expect(await runOf(nested.id)).toMatchObject([{ answer: 'draft' }]);

    const production = await createWorkflow(client, {
      nodes: [webhook('parent'), node('Call', 'test.callWorkflow', { workflowId: middle.id }, [200, 0])],
      connections: chain('Webhook', 'Call'),
    });
    await publish(client, production.id);
    expect((await hit(tenant.slug, 'parent')).json()).toMatchObject({ answer: 'published' });
  });

  it('(h) the error workflow runs its published version', async () => {
    const { client, tenant } = await signup(server.app);
    const handlerDefinition = (value: string) => ({
      nodes: [
        node('Error Trigger', 'core.errorTrigger'),
        setNode('Note', 'handled', value),
        node('Hook', 'core.webhook', { httpMethod: 'POST', path: 'handler' }, [0, 300], {
          webhookId: 'h-id',
        }),
      ],
      connections: chain('Error Trigger', 'Note'),
    });
    const handler = await createWorkflow(client, handlerDefinition('published'));
    await publish(client, handler.id);
    await save(client, handler.id, handlerDefinition('draft'));
    const wf = await createWorkflow(client, {
      nodes: [webhook('boom'), node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0])],
      connections: chain('Webhook', 'Boom'),
      settings: { errorWorkflow: handler.id },
    });
    await publish(client, wf.id);
    await hit(tenant.slug, 'boom');
    const run = await waitFor(async () => (await executionsOf(server.ctx, tenant.id, handler.id))[0], {
      message: 'error workflow execution',
    });
    await waitForExecution(server.ctx, tenant.id, run.id, ['success']);
    const data = await client.data(client.get(`/rest/executions/${run.id}`));
    expect(outputOf(data.state, 'Note')[0]).toMatchObject({ handled: 'published' });
    expect(data.workflowVersionId).toBe(handler.versionId);
  });
});
