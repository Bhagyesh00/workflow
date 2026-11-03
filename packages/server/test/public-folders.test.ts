/** Public API folders (P3-15): /api/v1/folders list, create, get, update, delete. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, TestClient, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function setup(role: 'owner' | 'viewer' = 'owner') {
  const owner = await signup(server.app);
  if (role === 'owner') {
    const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k' }));
    return { ...owner, key: key.key as string };
  }
  const invite = await owner.client.data(
    owner.client.post('/rest/members/invite', { email: 'v@example.com', role }),
  );
  const viewer = new TestClient(server.app);
  await viewer.data(
    viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'V', password: 'Passw0rd!' }),
  );
  const key = await viewer.data(viewer.post('/rest/api-keys', { name: 'v' }));
  return { ...owner, key: key.key as string };
}

const api = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

describe('public API folders', () => {
  it('creates, gets, lists, renames, moves and tags a folder', async () => {
    const { key, client } = await setup();
    const a = (await api(key, 'POST', '/folders', { name: 'A' })).json().data;
    expect(a).toMatchObject({ name: 'A', parentFolderId: null, tags: [] });
    const b = (await api(key, 'POST', '/folders', { name: 'B', parentFolderId: a.id })).json().data;
    expect(b.parentFolderId).toBe(a.id);
    expect((await api(key, 'GET', `/folders/${b.id}`)).json().data.name).toBe('B');
    const root = (await api(key, 'GET', '/folders?parentFolderId=root')).json();
    expect(root.data.map((f: { name: string }) => f.name)).toEqual(['A']);
    expect(root.nextCursor).toBeNull();
    const tag = await client.data(client.post('/rest/tags', { name: 'ops' }));
    const patched = (
      await api(key, 'PATCH', `/folders/${b.id}`, { name: 'C', parentFolderId: null, tagIds: [tag.id] })
    ).json().data;
    expect(patched).toMatchObject({ name: 'C', parentFolderId: null, tags: [{ id: tag.id, name: 'ops' }] });
    const byTag = (await api(key, 'GET', '/folders?tags=ops')).json();
    expect(byTag.data.map((f: { name: string }) => f.name)).toEqual(['C']);
    expect((await client.data(client.get(`/rest/folders/${b.id}`))).name).toBe('C');
  });

  it('applies the editor name rule and rejects an empty patch', async () => {
    const { key } = await setup();
    expect((await api(key, 'POST', '/folders', { name: 'a/b' })).statusCode).toBe(400);
    expect((await api(key, 'POST', '/folders', { name: '.hidden' })).statusCode).toBe(400);
    const f = (await api(key, 'POST', '/folders', { name: 'ok' })).json().data;
    expect((await api(key, 'PATCH', `/folders/${f.id}`, {})).statusCode).toBe(400);
    expect((await api(key, 'GET', '/folders/not-a-uuid')).statusCode).toBe(400);
  });

  it('deletes with transferToFolderId (moves content) or archives workflows to root', async () => {
    const { key, client } = await setup();
    const a = (await api(key, 'POST', '/folders', { name: 'A' })).json().data;
    const t = (await api(key, 'POST', '/folders', { name: 'T' })).json().data;
    const wf = await client.data(client.post('/rest/workflows', { name: 'w', folderId: a.id }));
    const res = await api(key, 'DELETE', `/folders/${a.id}?transferToFolderId=${t.id}`);
    expect(res.statusCode).toBe(200);
    expect((await api(key, 'GET', `/folders/${a.id}`)).statusCode).toBe(404);
    const moved = await client.data(client.get(`/rest/workflows/${wf.id}`));
    expect(moved.folderId).toBe(t.id);
    const wf2 = await client.data(client.post('/rest/workflows', { name: 'w2', folderId: t.id }));
    expect((await api(key, 'DELETE', `/folders/${t.id}`)).statusCode).toBe(200);
    const after = await client.data(client.get(`/rest/workflows/${wf2.id}`));
    expect(after.folderId ?? null).toBeNull();
    expect(after.isArchived).toBe(true);
  });

  it('a viewer key reads but cannot write; a missing key is 401', async () => {
    const { key } = await setup('viewer');
    expect((await api(key, 'GET', '/folders')).statusCode).toBe(200);
    expect((await api(key, 'POST', '/folders', { name: 'x' })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/v1/folders' })).statusCode).toBe(401);
  });

  it('another tenant folder is 404 and cannot be a parent, patched or deleted', async () => {
    const mine = await setup();
    const theirs = await setup();
    const f = (await api(theirs.key, 'POST', '/folders', { name: 'theirs' })).json().data;
    expect((await api(mine.key, 'GET', `/folders/${f.id}`)).statusCode).toBe(404);
    expect((await api(mine.key, 'PATCH', `/folders/${f.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await api(mine.key, 'DELETE', `/folders/${f.id}`)).statusCode).toBe(404);
    expect((await api(mine.key, 'POST', '/folders', { name: 'c', parentFolderId: f.id })).statusCode).toBe(
      404,
    );
    expect((await api(mine.key, 'GET', '/folders')).json().data).toEqual([]);
    expect((await api(theirs.key, 'GET', `/folders/${f.id}`)).json().data.name).toBe('theirs');
  });

  it('lists under OpenAPI', async () => {
    const doc = (await server.app.inject({ url: '/api/v1/openapi.json' })).json();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/folders', '/folders/{folderId}']));
  });
});
