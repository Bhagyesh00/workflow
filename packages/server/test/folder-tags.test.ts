/** Folder tags (P3-07 addendum): tagIds on PATCH, ?tags on the list, `tags` on the DTO. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, type TestClient, type TestServer } from './helpers';

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

const tag = (client: TestClient, name: string) =>
  client.data<{ id: string; name: string }>(client.post('/rest/tags', { name }));
const folder = (client: TestClient, name: string) =>
  client.data<{ id: string }>(client.post('/rest/folders', { name }));
const names = (res: { json(): any }) => res.json().data.map((f: { name: string }) => f.name);

describe('folder tags', () => {
  it('PATCH tagIds replaces the set and the DTO lists the tags', async () => {
    const { client } = await signup(server.app);
    const a = await tag(client, 'billing');
    const b = await tag(client, 'ops');
    const f = await folder(client, 'F');
    const both = await client.data(client.patch(`/rest/folders/${f.id}`, { tagIds: [a.id, b.id] }));
    expect(both.tags.map((t: { name: string }) => t.name).sort()).toEqual(['billing', 'ops']);
    expect(both.tags[0]).toEqual({ id: expect.any(String), name: expect.any(String) });
    const one = await client.data(client.patch(`/rest/folders/${f.id}`, { tagIds: [b.id, b.id] }));
    expect(one.tags).toEqual([{ id: b.id, name: 'ops' }]);
    // a rename alone keeps them; an empty list clears them
    expect((await client.data(client.patch(`/rest/folders/${f.id}`, { name: 'G' }))).tags).toHaveLength(1);
    expect((await client.data(client.patch(`/rest/folders/${f.id}`, { tagIds: [] }))).tags).toEqual([]);
    expect((await client.data(client.get(`/rest/folders/${f.id}`))).tags).toEqual([]);
  });

  it('a tag of another tenant is 404 and changes nothing; a bad id is 400', async () => {
    const { client } = await signup(server.app);
    const other = await signup(server.app);
    const mine = await tag(client, 'mine');
    const theirs = await tag(other.client, 'theirs');
    const f = await folder(client, 'F');
    await client.data(client.patch(`/rest/folders/${f.id}`, { tagIds: [mine.id] }));
    const res = await client.patch(`/rest/folders/${f.id}`, { tagIds: [mine.id, theirs.id] });
    expect(res.statusCode).toBe(404);
    expect((await client.data(client.get(`/rest/folders/${f.id}`))).tags).toEqual([
      { id: mine.id, name: 'mine' },
    ]);
    const rows = await server.ctx.database.pool.query('select tag_id from folder_tags where tag_id = $1', [
      theirs.id,
    ]);
    expect(rows.rowCount).toBe(0);
    expect((await client.patch(`/rest/folders/${f.id}`, { tagIds: ['nope'] })).statusCode).toBe(400);
  });

  it('?tags keeps the folders that have ALL the names; the list DTO carries the tags', async () => {
    const { client } = await signup(server.app);
    const a = await tag(client, 'billing');
    const b = await tag(client, 'ops');
    const f1 = await folder(client, 'One');
    const f2 = await folder(client, 'Two');
    await folder(client, 'Three');
    await client.data(client.patch(`/rest/folders/${f1.id}`, { tagIds: [a.id, b.id] }));
    await client.data(client.patch(`/rest/folders/${f2.id}`, { tagIds: [a.id] }));
    expect(names(await client.get('/rest/folders?tags=billing'))).toEqual(['One', 'Two']);
    expect(names(await client.get('/rest/folders?tags=billing,ops'))).toEqual(['One']);
    expect(names(await client.get('/rest/folders?tags=nope'))).toEqual([]);
    expect(names(await client.get('/rest/folders?tags=billing,nope'))).toEqual([]);
    const all = (await client.get('/rest/folders')).json().data;
    expect(all.find((f: { name: string }) => f.name === 'One').tags).toHaveLength(2);
    expect(all.find((f: { name: string }) => f.name === 'Three').tags).toEqual([]);
  });

  it('deleting a tag or a folder removes the mapping', async () => {
    const owner = await signup(server.app);
    const t = await tag(owner.client, 'x');
    const f = await folder(owner.client, 'F');
    await owner.client.data(owner.client.patch(`/rest/folders/${f.id}`, { tagIds: [t.id] }));
    await owner.client.data(owner.client.delete(`/rest/tags/${t.id}`));
    expect((await owner.client.data(owner.client.get(`/rest/folders/${f.id}`))).tags).toEqual([]);
    const t2 = await tag(owner.client, 'y');
    await owner.client.data(owner.client.patch(`/rest/folders/${f.id}`, { tagIds: [t2.id] }));
    await owner.client.request('DELETE', `/rest/folders/${f.id}`, {});
    const rows = await server.ctx.database.pool.query('select 1 from folder_tags');
    expect(rows.rowCount).toBe(0);
  });
});
