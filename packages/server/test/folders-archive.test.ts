/**
 * Folders, favorites, archive and move (P3-07, lane L8): the rules of the plan's D1 decision.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  waitForExecution,
} from './helpers';

let server: TestServer;

/** signup is limited to 20 per server instance, so each group of tests gets its own server */
function useServer() {
  beforeAll(async () => {
    server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(async () => {
    await resetDatabase(server.ctx);
  });
}

const pool = () => server.ctx.database.pool;
type Owner = Awaited<ReturnType<typeof signup>>;

async function member(owner: Owner, role: 'admin' | 'editor' | 'viewer') {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  await client.data(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: role, password: 'Passw0rd!' }),
  );
  return client;
}

const manual = (name = 'W') => ({
  name,
  nodes: [node('Start', 'core.manualTrigger'), setNode('Set', 'greeting', 'hi')],
  connections: chain('Start', 'Set'),
});

const hook = (path: string) => ({
  name: `Hook ${path}`,
  nodes: [
    node('Webhook', 'core.webhook', { httpMethod: 'POST', path }, [0, 0], { webhookId: `id-${path}` }),
    setNode('Set', 'a', 'b'),
  ],
  connections: chain('Webhook', 'Set'),
});

const folderOf = (client: TestClient, name: string, parentFolderId?: string | null) =>
  client.data<{ id: string; name: string; parentFolderId: string | null }>(
    client.post('/rest/folders', { name, parentFolderId }),
  );

const del = (client: TestClient, id: string, body: unknown = {}) =>
  client.request('DELETE', `/rest/folders/${id}`, body);

const inFolder = (client: TestClient, folderId: string | null, name = 'W') =>
  client.data<{ id: string }>(client.post('/rest/workflows', { ...manual(name), folderId }));

describe('folder names and nesting', () => {
  useServer();

  it('trims the name and applies the n8n name rule', async () => {
    const { client } = await signup(server.app);
    expect((await folderOf(client, '  Sales  ')).name).toBe('Sales');
    const bad = [
      '',
      '   ',
      '.',
      '...',
      '.hidden',
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a[b]',
      'a^b',
      'x'.repeat(129),
    ];
    for (const name of bad) {
      const res = await client.post('/rest/folders', { name });
      expect(res.statusCode, name).toBe(400);
    }
    expect((await folderOf(client, 'x'.repeat(128))).name).toHaveLength(128);
    expect((await folderOf(client, 'v1.2 final')).name).toBe('v1.2 final');
  });

  it('nests folders, lists by parent and answers the breadcrumb and recursive counts', async () => {
    const { client } = await signup(server.app);
    const a = await folderOf(client, 'A');
    const b = await folderOf(client, 'B', a.id);
    const c = await folderOf(client, 'C', b.id);
    await folderOf(client, 'Other');
    await inFolder(client, a.id, 'in A');
    await inFolder(client, c.id, 'in C');
    const archivedOne = await inFolder(client, c.id, 'gone');
    await client.data(client.post(`/rest/workflows/${archivedOne.id}/archive`));

    const root = (await client.get('/rest/folders?parentFolderId=root')).json();
    expect(root.data.map((f: { name: string }) => f.name)).toEqual(['A', 'Other']);
    expect(root.nextCursor).toBeNull();
    const kids = (await client.get(`/rest/folders?parentFolderId=${a.id}`)).json().data;
    expect(kids.map((f: { name: string }) => f.name)).toEqual(['B']);
    expect((await client.get('/rest/folders')).json().data).toHaveLength(4);
    expect((await client.get('/rest/folders?search=oth')).json().data).toHaveLength(1);

    const detail = await client.data(client.get(`/rest/folders/${c.id}`));
    expect(detail).toMatchObject({
      id: c.id,
      name: 'C',
      parentFolderId: b.id,
      workflowCount: 1,
      subFolderCount: 0,
    });
    expect(detail.path).toEqual([
      { id: a.id, name: 'A' },
      { id: b.id, name: 'B' },
    ]);
    expect(detail.tags).toEqual([]);
    const top = await client.data(client.get(`/rest/folders/${a.id}`));
    expect(top).toMatchObject({ workflowCount: 2, subFolderCount: 2, path: [] });
  });

  it('pages the list with a cursor', async () => {
    const { client } = await signup(server.app);
    for (const n of ['a', 'b', 'c']) await folderOf(client, n);
    const first = (await client.get('/rest/folders?limit=2')).json();
    expect(first.data.map((f: { name: string }) => f.name)).toEqual(['a', 'b']);
    const next = (await client.get(`/rest/folders?limit=2&cursor=${first.nextCursor}`)).json();
    expect(next.data.map((f: { name: string }) => f.name)).toEqual(['c']);
    expect(next.nextCursor).toBeNull();
  });

  it('renames and moves a folder; self and descendant parents are refused (400)', async () => {
    const { client } = await signup(server.app);
    const a = await folderOf(client, 'A');
    const b = await folderOf(client, 'B', a.id);
    const c = await folderOf(client, 'C', b.id);
    const renamed = await client.data(
      client.patch(`/rest/folders/${c.id}`, { name: ' C2 ', parentFolderId: a.id }),
    );
    expect(renamed).toMatchObject({ name: 'C2', parentFolderId: a.id });
    expect((await client.patch(`/rest/folders/${a.id}`, { parentFolderId: a.id })).statusCode).toBe(400);
    expect((await client.patch(`/rest/folders/${a.id}`, { parentFolderId: b.id })).statusCode).toBe(400);
    expect((await client.patch(`/rest/folders/${a.id}`, { parentFolderId: c.id })).statusCode).toBe(400);
    expect((await client.patch(`/rest/folders/${a.id}`, {})).statusCode).toBe(400);
    const toRoot = await client.data(client.patch(`/rest/folders/${b.id}`, { parentFolderId: null }));
    expect(toRoot.parentFolderId).toBeNull();
  });

  it('two moves at the same time cannot make a cycle (A under B and B under A)', async () => {
    const { client } = await signup(server.app);
    for (let round = 0; round < 5; round++) {
      const a = await folderOf(client, `A${round}`);
      const b = await folderOf(client, `B${round}`);
      const results = await Promise.all([
        client.patch(`/rest/folders/${a.id}`, { parentFolderId: b.id }),
        client.patch(`/rest/folders/${b.id}`, { parentFolderId: a.id }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
      const rows = await pool().query('select id, parent_folder_id from folders where id = any($1::uuid[])', [
        [a.id, b.id],
      ]);
      expect(rows.rows.filter((r) => r.parent_folder_id === null)).toHaveLength(1);
    }
  });

  it('a cycle that already exists ends the walk: read, move and delete answer instead of hanging', async () => {
    const { client } = await signup(server.app);
    const a = await folderOf(client, 'A');
    const b = await folderOf(client, 'B', a.id);
    await pool().query('update folders set parent_folder_id = $1 where id = $2', [b.id, a.id]);
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('hung')), ms));
    const read = await Promise.race([client.get(`/rest/folders/${a.id}`), timeout(10_000)]);
    expect(read.statusCode).toBe(200);
    const move = await Promise.race([
      client.patch(`/rest/folders/${a.id}`, { parentFolderId: b.id }),
      timeout(10_000),
    ]);
    expect(move.statusCode).toBe(400);
    const removed = await Promise.race([del(client, a.id), timeout(10_000)]);
    expect(removed.statusCode).toBeLessThan(500);
  });

  it('writes audit rows', async () => {
    const { client, tenant } = await signup(server.app);
    const f = await folderOf(client, 'A');
    await client.data(client.patch(`/rest/folders/${f.id}`, { name: 'B' }));
    expect((await del(client, f.id)).statusCode).toBe(200);
    const { rows } = await pool().query(
      "select action from audit_log where tenant_id = $1 and action like 'folder.%' order by id",
      [tenant.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['folder.created', 'folder.updated', 'folder.deleted']);
  });
});

describe('folder delete', () => {
  useServer();

  it('omitted transfer: workflows go to the root and are archived, the folders and their favorites go', async () => {
    const { client, user, tenant } = await signup(server.app);
    const a = await folderOf(client, 'A');
    const b = await folderOf(client, 'B', a.id);
    const w1 = await inFolder(client, a.id, 'w1');
    const w2 = await inFolder(client, b.id, 'w2');
    const live = await createWorkflow(client, hook('del-me'));
    await client.data(client.post('/rest/workflows/move', { workflowIds: [live.id], folderId: b.id }));
    await client.data(client.post(`/rest/workflows/${live.id}/activate`));
    await client.data(client.post('/rest/favorites', { resourceType: 'folder', resourceId: b.id }));
    await client.data(client.post('/rest/favorites', { resourceType: 'workflow', resourceId: w1.id }));

    expect((await del(client, a.id)).statusCode).toBe(200);
    expect((await client.get(`/rest/folders/${a.id}`)).statusCode).toBe(404);
    expect((await client.get(`/rest/folders/${b.id}`)).statusCode).toBe(404);
    const all = (await client.get('/rest/workflows?archived=all&folderId=root')).json().data;
    expect(all.map((w: { id: string }) => w.id).sort()).toEqual([w1.id, w2.id, live.id].sort());
    expect(all.every((w: { isArchived: boolean; active: boolean }) => w.isArchived && !w.active)).toBe(true);
    const favorites = await pool().query('select resource_type from user_favorites where user_id = $1', [
      user.id,
    ]);
    expect(favorites.rows.map((r) => r.resource_type)).toEqual(['workflow']);
    const res = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/del-me` });
    expect(res.statusCode).toBe(404);
  });

  it('transferToFolderId (uuid or root): content moves there in one step and nothing is archived', async () => {
    const { client } = await signup(server.app);
    const a = await folderOf(client, 'A');
    const kid = await folderOf(client, 'Kid', a.id);
    const target = await folderOf(client, 'Target');
    const w = await inFolder(client, a.id, 'w');
    expect((await del(client, a.id, { transferToFolderId: target.id })).statusCode).toBe(200);
    const moved = await client.data(client.get(`/rest/workflows/${w.id}`));
    expect(moved).toMatchObject({ folderId: target.id, isArchived: false });
    expect((await client.data(client.get(`/rest/folders/${kid.id}`))).parentFolderId).toBe(target.id);

    const x = await folderOf(client, 'X');
    const xk = await folderOf(client, 'XK', x.id);
    const wx = await inFolder(client, x.id, 'wx');
    expect((await del(client, x.id, { transferToFolderId: 'root' })).statusCode).toBe(200);
    expect(await client.data(client.get(`/rest/workflows/${wx.id}`))).toMatchObject({
      folderId: null,
      isArchived: false,
    });
    expect((await client.data(client.get(`/rest/folders/${xk.id}`))).parentFolderId).toBeNull();
  });

  it('refuses a target inside the deleted folder (400), the folder itself and a foreign folder (404)', async () => {
    const { client } = await signup(server.app);
    const other = await signup(server.app);
    const a = await folderOf(client, 'A');
    const kid = await folderOf(client, 'Kid', a.id);
    const foreign = await folderOf(other.client, 'F');
    expect((await del(client, a.id, { transferToFolderId: kid.id })).statusCode).toBe(400);
    expect((await del(client, a.id, { transferToFolderId: a.id })).statusCode).toBe(400);
    expect((await del(client, a.id, { transferToFolderId: foreign.id })).statusCode).toBe(404);
    expect((await del(client, a.id, { transferToFolderId: 'nope' })).statusCode).toBe(400);
    expect((await client.get(`/rest/folders/${a.id}`)).statusCode).toBe(200);
  });
});

describe('move workflows', () => {
  useServer();

  it('moves workflows between folders and the root and filters the list by folder', async () => {
    const { client } = await signup(server.app);
    const f = await folderOf(client, 'F');
    const w1 = await inFolder(client, null, 'w1');
    const w2 = await inFolder(client, null, 'w2');
    const moved = await client.data(
      client.post('/rest/workflows/move', { workflowIds: [w1.id, w2.id], folderId: f.id }),
    );
    expect(moved.moved.sort()).toEqual([w1.id, w2.id].sort());
    expect((await client.get(`/rest/workflows?folderId=${f.id}`)).json().data).toHaveLength(2);
    expect((await client.get('/rest/workflows?folderId=root')).json().data).toHaveLength(0);
    await client.data(client.post('/rest/workflows/move', { workflowIds: [w1.id], folderId: null }));
    expect((await client.get('/rest/workflows?folderId=root')).json().data).toHaveLength(1);
  });

  it('an archived workflow cannot be moved (400) and nothing in the request moves', async () => {
    const { client } = await signup(server.app);
    const f = await folderOf(client, 'F');
    const live = await inFolder(client, null, 'live');
    const old = await inFolder(client, null, 'old');
    await client.data(client.post(`/rest/workflows/${old.id}/archive`));
    const refused = await client.post('/rest/workflows/move', {
      workflowIds: [live.id, old.id],
      folderId: f.id,
    });
    expect(refused.statusCode).toBe(400);
    expect((await client.data(client.get(`/rest/workflows/${live.id}`))).folderId).toBeNull();
    expect((await client.data(client.get(`/rest/workflows/${old.id}`))).folderId).toBeNull();
    await client.data(client.post(`/rest/workflows/${old.id}/unarchive`));
    const ok = await client.data(
      client.post('/rest/workflows/move', { workflowIds: [old.id], folderId: f.id }),
    );
    expect(ok.moved).toEqual([old.id]);
  });

  it('a foreign folder is 404, a foreign workflow is 404 and nothing moves', async () => {
    const { client } = await signup(server.app);
    const other = await signup(server.app);
    const mine = await inFolder(client, null);
    const theirs = await inFolder(other.client, null);
    const foreignFolder = await folderOf(other.client, 'F');
    const own = await folderOf(client, 'Own');
    const toForeign = await client.post('/rest/workflows/move', {
      workflowIds: [mine.id],
      folderId: foreignFolder.id,
    });
    expect(toForeign.statusCode).toBe(404);
    const mixed = await client.post('/rest/workflows/move', {
      workflowIds: [mine.id, theirs.id],
      folderId: own.id,
    });
    expect(mixed.statusCode).toBe(404);
    expect((await client.data(client.get(`/rest/workflows/${mine.id}`))).folderId).toBeNull();
    const created = await client.post('/rest/workflows', { ...manual(), folderId: foreignFolder.id });
    expect(created.statusCode).toBe(404);
  });
});

describe('archive', () => {
  useServer();

  it('unpublishes first: the webhook answers 404, the history records one deactivation, the review closes', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, hook('arch'));
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    const call = () => server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/arch` });
    expect((await call()).statusCode).toBe(200);
    const record = vi.spyOn(server.ctx.publishHistory, 'record');
    const closed = vi.spyOn(server.ctx.reviews, 'afterWorkflowArchived');
    const dto = await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    expect(dto).toMatchObject({ isArchived: true, active: false, publishedVersionId: null });
    expect((await call()).statusCode).toBe(404);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toBe('deactivated');
    expect(record.mock.calls[0][1]).toMatchObject({ tenantId: tenant.id, workflowId: wf.id });
    expect(closed).toHaveBeenCalledWith(tenant.id, wf.id);
    record.mockRestore();
    closed.mockRestore();
    // an unpublished workflow records nothing
    const idle = await createWorkflow(client, manual('idle'));
    const again = vi.spyOn(server.ctx.publishHistory, 'record');
    await client.data(client.post(`/rest/workflows/${idle.id}/archive`));
    expect(again).not.toHaveBeenCalled();
    again.mockRestore();
  });

  it('editor: archiving an archived workflow and unarchiving a live one are 400; unarchive stays unpublished', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, hook('stay-off'));
    expect((await client.post(`/rest/workflows/${wf.id}/unarchive`)).statusCode).toBe(400);
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    await client.data(client.post(`/rest/workflows/${wf.id}/archive`));
    expect((await client.post(`/rest/workflows/${wf.id}/archive`)).statusCode).toBe(400);
    const back = await client.data(client.post(`/rest/workflows/${wf.id}/unarchive`));
    expect(back).toMatchObject({ isArchived: false, active: false, publishedVersionId: null });
  });

  it('public API: archive twice answers 200 both times; its delete forces', async () => {
    const owner = await signup(server.app);
    const key = (await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k' }))).key as string;
    const wf = await createWorkflow(owner.client, manual());
    const call = (method: 'POST' | 'DELETE', path: string) =>
      server.app.inject({ method, url: `/api/v1${path}`, headers: { 'x-api-key': key } });
    expect((await call('POST', `/workflows/${wf.id}/archive`)).statusCode).toBe(200);
    expect((await call('POST', `/workflows/${wf.id}/archive`)).statusCode).toBe(200);
    expect((await owner.client.data(owner.client.get(`/rest/workflows/${wf.id}`))).isArchived).toBe(true);
    const live = await createWorkflow(owner.client, manual('live'));
    expect((await call('DELETE', `/workflows/${live.id}`)).statusCode).toBe(200);
  });

  it('refuses update, activate and a call as sub-workflow while archived', async () => {
    const { client, tenant } = await signup(server.app);
    const child = await createWorkflow(client, {
      name: 'Child',
      nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Set', 'x', '1', [200, 0])],
      connections: chain('Called', 'Set'),
    });
    const parent = await createWorkflow(client, {
      name: 'Parent',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Call', 'test.callWorkflow', { workflowId: child.id }, [200, 0]),
      ],
      connections: chain('Start', 'Call'),
    });
    await client.data(client.post(`/rest/workflows/${child.id}/archive`));
    const current = await client.data(client.get(`/rest/workflows/${child.id}`));
    const rename = () =>
      client.patch(`/rest/workflows/${child.id}`, { versionId: current.versionId, name: 'New' });
    expect((await rename()).statusCode).toBe(400);
    expect((await client.post(`/rest/workflows/${child.id}/activate`)).statusCode).toBe(400);
    const { executionId } = await client.data(client.post(`/rest/workflows/${parent.id}/run`, {}));
    const row = await waitForExecution(server.ctx, tenant.id, executionId);
    expect(row.status).toBe('error');
    // after unarchive everything works again
    await client.data(client.post(`/rest/workflows/${child.id}/unarchive`));
    expect((await rename()).statusCode).toBe(200);
  });

  it('the editor deletes only archived workflows; no favorite is left; another user never sees the star', async () => {
    const owner = await signup(server.app);
    const editor = await member(owner, 'editor');
    const wf = await createWorkflow(owner.client, manual());
    await owner.client.data(
      owner.client.post('/rest/favorites', { resourceType: 'workflow', resourceId: wf.id }),
    );
    const ids = (await owner.client.data(owner.client.get('/rest/favorites'))).map(
      (f: { resourceId: string }) => f.resourceId,
    );
    expect(ids).toEqual([wf.id]);
    expect(await editor.data(editor.get('/rest/favorites'))).toEqual([]);

    expect((await owner.client.delete(`/rest/workflows/${wf.id}`)).statusCode).toBe(400);
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/archive`));
    // an archived workflow leaves the favorite list
    expect(await owner.client.data(owner.client.get('/rest/favorites'))).toEqual([]);
    expect((await owner.client.delete(`/rest/workflows/${wf.id}`)).statusCode).toBe(200);
    const left = await pool().query('select 1 from user_favorites');
    expect(left.rowCount).toBe(0);
  });

  it('writes audit rows and checks roles and tenants', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const wf = await createWorkflow(owner.client, manual());
    expect((await viewer.post(`/rest/workflows/${wf.id}/archive`)).statusCode).toBe(403);
    expect((await other.client.post(`/rest/workflows/${wf.id}/archive`)).statusCode).toBe(404);
    const move = { workflowIds: [wf.id], folderId: null };
    expect((await viewer.post('/rest/workflows/move', move)).statusCode).toBe(403);
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/archive`));
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/unarchive`));
    await owner.client.data(owner.client.post('/rest/workflows/move', move));
    const { rows } = await pool().query(
      "select action from audit_log where tenant_id = $1 and action in ('workflow.archived','workflow.unarchived','workflow.moved') order by id",
      [owner.tenant.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['workflow.archived', 'workflow.unarchived', 'workflow.moved']);
  });
});

describe('favorites', () => {
  useServer();

  it('adds (idempotent), lists with names and removes workflows and folders', async () => {
    const { client } = await signup(server.app);
    const wf = await createWorkflow(client, manual('Nightly'));
    const f = await folderOf(client, 'Reports');
    const added = await client.data(
      client.post('/rest/favorites', { resourceType: 'workflow', resourceId: wf.id }),
    );
    expect(added).toMatchObject({ resourceType: 'workflow', resourceId: wf.id, name: 'Nightly' });
    await client.data(client.post('/rest/favorites', { resourceType: 'workflow', resourceId: wf.id }));
    await client.data(client.post('/rest/favorites', { resourceType: 'folder', resourceId: f.id }));
    const list = await client.data(client.get('/rest/favorites'));
    expect(list.map((x: { name: string }) => x.name)).toEqual(['Nightly', 'Reports']);
    expect(await client.data(client.delete(`/rest/favorites/folder/${f.id}`))).toEqual({ ok: true });
    expect(await client.data(client.delete(`/rest/favorites/folder/${f.id}`))).toEqual({ ok: true });
    expect((await client.data(client.get('/rest/favorites'))).length).toBe(1);
  });

  it('refuses another tenant resource (404), a bad type or id (400); a viewer may star', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const theirs = await createWorkflow(other.client, manual());
    const mine = await createWorkflow(owner.client, manual());
    const add = (client: TestClient, resourceType: string, resourceId: string) =>
      client.post('/rest/favorites', { resourceType, resourceId });
    expect((await add(owner.client, 'workflow', theirs.id)).statusCode).toBe(404);
    expect((await add(owner.client, 'project', mine.id)).statusCode).toBe(400);
    expect((await add(owner.client, 'workflow', 'x')).statusCode).toBe(400);
    expect((await add(viewer, 'workflow', mine.id)).statusCode).toBe(200);
    expect((await owner.client.get('/rest/favorites')).json().data).toEqual([]);
    expect((await new TestClient(server.app).get('/rest/favorites')).statusCode).toBe(401);
  });
});

describe('roles and tenants on folders', () => {
  useServer();

  it('viewer reads but cannot write (403); another tenant gets 404 everywhere', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const other = await signup(server.app);
    const f = await folderOf(owner.client, 'F');
    expect((await viewer.get('/rest/folders')).statusCode).toBe(200);
    expect((await viewer.get(`/rest/folders/${f.id}`)).statusCode).toBe(200);
    expect((await viewer.post('/rest/folders', { name: 'x' })).statusCode).toBe(403);
    expect((await viewer.patch(`/rest/folders/${f.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await viewer.request('DELETE', `/rest/folders/${f.id}`, {})).statusCode).toBe(403);
    expect((await other.client.get(`/rest/folders/${f.id}`)).statusCode).toBe(404);
    expect((await other.client.patch(`/rest/folders/${f.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await del(other.client, f.id)).statusCode).toBe(404);
    expect((await other.client.post('/rest/folders', { name: 'c', parentFolderId: f.id })).statusCode).toBe(
      404,
    );
    expect((await other.client.get('/rest/folders')).json().data).toEqual([]);
    expect((await other.client.get(`/rest/folders?parentFolderId=${f.id}`)).json().data).toEqual([]);
  });
});
