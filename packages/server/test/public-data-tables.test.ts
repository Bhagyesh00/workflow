/** Public API data tables (P4-18): the 16 routes, cursor paging and API key scopes. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_KEY_SCOPES, assertApiKeyScope } from '../src/http/api-key-scopes';
import type { AuthContext } from '../src/http/auth';
import {
  addToProject,
  createTestServer,
  memberAs,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestServer,
} from './helpers';

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

async function setup(scopes: string[] = []) {
  const owner = await signup(server.app);
  const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k', scopes }));
  return { ...owner, key: key.key as string };
}

async function viewerKey() {
  const owner = await signup(server.app);
  const { client: viewer } = await memberAs(owner, 'viewer', { email: 'v@example.com', name: 'V' });
  const key = await viewer.data(viewer.post('/rest/api-keys', { name: 'v' }));
  return { key: key.key as string, team: owner.client.defaultProjectId! };
}

const api = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

const json = (value: unknown) => encodeURIComponent(JSON.stringify(value));

async function makeTable(key: string, name = 'people') {
  const res = await api(key, 'POST', '/data-tables', {
    name,
    columns: [
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number' },
    ],
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as { id: string; columns: Array<{ id: string; name: string; index: number }> };
}

describe('public API data tables', () => {
  it('creates, gets, lists, renames and deletes a table', async () => {
    const { key } = await setup();
    const table = await makeTable(key);
    expect(table.columns.map((c) => [c.name, c.index])).toEqual([
      ['name', 0],
      ['age', 1],
    ]);
    expect((await api(key, 'GET', `/data-tables/${table.id}`)).json().data.name).toBe('people');
    const listed = (await api(key, 'GET', `/data-tables?filter=${json({ name: 'peo' })}`)).json();
    expect(listed.data.map((t: { name: string }) => t.name)).toEqual(['people']);
    expect(listed.nextCursor).toBeNull();
    const renamed = await api(key, 'PATCH', `/data-tables/${table.id}`, { name: 'staff' });
    expect(renamed.json().data.name).toBe('staff');
    expect((await api(key, 'GET', `/data-tables/${table.id}/dependencies`)).json().data).toEqual([]);
    expect((await api(key, 'DELETE', `/data-tables/${table.id}`)).json().data).toBe(true);
    expect((await api(key, 'GET', `/data-tables/${table.id}`)).statusCode).toBe(404);
  });

  it('adds, renames, moves and deletes columns', async () => {
    const { key } = await setup();
    const table = await makeTable(key);
    const added = await api(key, 'POST', `/data-tables/${table.id}/columns`, {
      name: 'city',
      type: 'string',
    });
    expect(added.json().data).toMatchObject({ name: 'city', type: 'string', index: 2 });
    const cols = (await api(key, 'GET', `/data-tables/${table.id}/columns`)).json().data;
    expect(cols.map((c: { name: string }) => c.name)).toEqual(['name', 'age', 'city']);
    const city = cols[2];
    const moved = await api(key, 'PATCH', `/data-tables/${table.id}/columns/${city.id}`, {
      name: 'town',
      index: 0,
    });
    expect(moved.json().data).toMatchObject({ name: 'town', index: 0 });
    const empty = await api(key, 'PATCH', `/data-tables/${table.id}/columns/${city.id}`, {});
    expect(empty.statusCode).toBe(400);
    expect((await api(key, 'DELETE', `/data-tables/${table.id}/columns/${city.id}`)).json().data).toBe(true);
    const after = (await api(key, 'GET', `/data-tables/${table.id}/columns`)).json().data;
    expect(after.map((c: { name: string }) => c.name)).toEqual(['name', 'age']);
  });

  it('inserts, upserts, updates, deletes and clears rows', async () => {
    const { key } = await setup();
    const table = await makeTable(key);
    const base = `/data-tables/${table.id}/rows`;
    const ins = await api(key, 'POST', base, {
      data: [
        { name: 'ann', age: 30 },
        { name: 'bob', age: 40 },
      ],
      returnType: 'all',
    });
    expect(ins.json().data.map((r: { name: string }) => r.name)).toEqual(['ann', 'bob']);
    const byAnn = { type: 'and', filters: [{ columnName: 'name', condition: 'eq', value: 'ann' }] };
    const up = await api(key, 'POST', `${base}/upsert`, {
      filter: byAnn,
      data: { age: 31 },
      returnData: true,
    });
    expect(up.json().data[0]).toMatchObject({ name: 'ann', age: 31 });
    const upNew = await api(key, 'POST', `${base}/upsert`, {
      filter: { type: 'and', filters: [{ columnName: 'name', condition: 'eq', value: 'cy' }] },
      data: { age: 5 },
    });
    expect(upNew.json().data).toBe(true);
    const upd = await api(key, 'PATCH', `${base}/update`, {
      filter: { type: 'and', filters: [{ columnName: 'name', condition: 'eq', value: 'bob' }] },
      data: { age: 41 },
      returnData: true,
    });
    expect(upd.json().data[0]).toMatchObject({ name: 'bob', age: 41 });
    const found = (await api(key, 'GET', `${base}?filter=${json(byAnn)}`)).json();
    expect(found.data).toHaveLength(1);
    const dry = await api(key, 'DELETE', `${base}/delete?filter=${json(byAnn)}&dryRun=true&returnData=true`);
    expect(dry.json().data.length).toBeGreaterThan(0);
    expect((await api(key, 'GET', base)).json().data).toHaveLength(3);
    const del = await api(key, 'DELETE', `${base}/delete?filter=${json(byAnn)}&returnData=true`);
    expect(del.json().data[0].name).toBe('ann');
    expect((await api(key, 'DELETE', `${base}/delete`)).statusCode).toBe(400);
    const clear = await api(key, 'DELETE', `${base}/clear`);
    expect(clear.statusCode).toBe(200);
    expect((await api(key, 'GET', base)).json().data).toEqual([]);
  });

  it('pages tables and rows with a cursor, limit 100 by default and 250 at most', async () => {
    const { key } = await setup();
    const table = await makeTable(key);
    const rows = Array.from({ length: 5 }, (_, i) => ({ name: `n${i}`, age: i }));
    await api(key, 'POST', `/data-tables/${table.id}/rows`, { data: rows });
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<typeof api>> = await api(
        key,
        'GET',
        `/data-tables/${table.id}/rows?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const body = res.json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      for (const row of body.data) seen.push(row.age);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect((await api(key, 'GET', `/data-tables/${table.id}/rows?limit=251`)).statusCode).toBe(400);
    expect((await api(key, 'GET', `/data-tables/${table.id}/rows?limit=0`)).statusCode).toBe(400);
    expect((await api(key, 'GET', `/data-tables/${table.id}/rows?cursor=not-a-cursor`)).statusCode).toBe(400);
    await makeTable(key, 'second');
    const first = (await api(key, 'GET', '/data-tables?limit=1')).json();
    expect(first.data).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const next = (
      await api(key, 'GET', `/data-tables?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    expect(next.data).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect(next.data[0].id).not.toBe(first.data[0].id);
  });

  it('keeps tenants apart and answers n8n errors', async () => {
    const a = await setup();
    const table = await makeTable(a.key);
    await api(a.key, 'POST', `/data-tables/${table.id}/rows`, { data: [{ name: 'x', age: 1 }] });
    const b = await setup();
    expect((await api(b.key, 'GET', '/data-tables')).json().data).toEqual([]);
    expect((await api(b.key, 'GET', `/data-tables/${table.id}`)).statusCode).toBe(404);
    expect((await api(b.key, 'GET', `/data-tables/${table.id}/rows`)).statusCode).toBe(404);
    expect((await api(b.key, 'DELETE', `/data-tables/${table.id}/rows/clear`)).statusCode).toBe(404);
    const bad = await api(a.key, 'POST', `/data-tables/${table.id}/rows`, { data: [{ nope: 1 }] });
    expect(bad.statusCode).toBe(400);
    expect((await api(a.key, 'GET', '/data-tables/not-a-uuid')).statusCode).toBe(400);
  });

  it("creates in the caller's personal project (P6-39), or in the project the body names (P6-34)", async () => {
    const owner = await signup(server.app);
    const key = (await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k' }))).key as string;
    const home = (await server.ctx.repos.projects.getPersonal(owner.tenant.id, owner.user.id))!.id;
    const made = await api(key, 'POST', '/data-tables', { name: 'in_default', columns: [] });
    expect(made.json().data.projectId).toBe(home);
    const other = await projectIn(server, owner.tenant.id, 'Other');
    const named = await api(key, 'POST', '/data-tables', {
      name: 'in_other',
      columns: [],
      projectId: other.id,
    });
    expect(named.statusCode).toBe(200);
    expect(named.json().data.projectId).toBe(other.id);
    const unknown = await api(key, 'POST', '/data-tables', {
      name: 'nowhere',
      columns: [],
      projectId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('lets a member key create only in a project where the user holds dataTable:create (P6-34)', async () => {
    const owner = await signup(server.app);
    const member = await realMember(owner);
    const mine = await projectIn(server, owner.tenant.id, 'Mine');
    const theirs = await projectIn(server, owner.tenant.id, 'Theirs');
    await addToProject(server, owner.tenant.id, mine.id, member.user.id, 'project:editor');
    const key = (await member.client.data(member.client.post('/rest/api-keys', { name: 'm' }))).key as string;
    const ok = await api(key, 'POST', '/data-tables', { name: 'ok', columns: [], projectId: mine.id });
    expect(ok.statusCode).toBe(200);
    const refused = await api(key, 'POST', '/data-tables', { name: 'no', columns: [], projectId: theirs.id });
    expect(refused.statusCode).toBe(403);
  });

  it('refuses writes in the team project to a viewer key', async () => {
    const { key, team } = await viewerKey();
    expect((await api(key, 'GET', '/data-tables')).statusCode).toBe(200);
    expect(
      (await api(key, 'POST', '/data-tables', { name: 't', columns: [], projectId: team })).statusCode,
    ).toBe(403);
  });
});

describe('API key scopes', () => {
  it('lets a scoped key reach only the routes whose scope it holds', async () => {
    const { key } = await setup(['dataTable:list', 'dataTable:create']);
    expect((await api(key, 'GET', '/data-tables')).statusCode).toBe(200);
    const made = await api(key, 'POST', '/data-tables', { name: 't', columns: [] });
    expect(made.statusCode).toBe(200);
    const id = made.json().data.id;
    expect((await api(key, 'GET', `/data-tables/${id}`)).statusCode).toBe(403);
    expect((await api(key, 'DELETE', `/data-tables/${id}`)).statusCode).toBe(403);
    expect((await api(key, 'GET', `/data-tables/${id}/columns`)).statusCode).toBe(403);
    expect((await api(key, 'GET', `/data-tables/${id}/rows`)).statusCode).toBe(403);
    expect((await api(key, 'GET', '/workflows')).statusCode).toBe(403);
    expect((await api(key, 'GET', '/tags')).statusCode).toBe(403);
  });

  it('gives a key with no scopes every route, and stores the scopes it was made with', async () => {
    const { key, client } = await setup();
    expect((await api(key, 'GET', '/workflows')).statusCode).toBe(200);
    expect((await api(key, 'GET', '/data-tables')).statusCode).toBe(200);
    await client.data(client.post('/rest/api-keys', { name: 's', scopes: ['tag:list', 'tag:list'] }));
    const keys = await client.data(client.get('/rest/api-keys'));
    expect(keys.find((k: { name: string }) => k.name === 's').scopes).toEqual(['tag:list']);
    expect((await client.post('/rest/api-keys', { name: 'x', scopes: ['nope:read'] })).statusCode).toBe(400);
  });

  it('fails closed on a route without a scope', () => {
    const scoped = { apiKeyScopes: ['tag:list'] } as AuthContext;
    expect(() => assertApiKeyScope(scoped, undefined)).toThrow();
    expect(() => assertApiKeyScope(scoped, 'tag:read')).toThrow();
    expect(() => assertApiKeyScope(scoped, 'tag:list')).not.toThrow();
    expect(() => assertApiKeyScope({ apiKeyScopes: [] } as unknown as AuthContext, undefined)).not.toThrow();
    expect(() => assertApiKeyScope({} as AuthContext, undefined)).not.toThrow();
  });

  it('names a scope on every public route', async () => {
    const { PUBLIC_ROUTES } = await import('../src/routes/public-api');
    for (const route of PUBLIC_ROUTES) {
      expect(route.scope, `${route.method} ${route.path}`).toBeDefined();
      expect(API_KEY_SCOPES).toContain(route.scope);
    }
  });
});
