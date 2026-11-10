/**
 * P6-11 (L9): the public role mapping rules, as n8n's: GET and POST `/role-mapping-rules`, POST
 * `/:id/move`, PATCH and DELETE `/:id`, each with its own key scope (`roleMappingRule:list`, `:create`,
 * `:update`, `:delete`), the cursor, the type filter, the tenant bound and the checks of the service.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, projectIn, realMember, resetDatabase, signup as baseSignup, type TestClient, type TestServer } from './helpers';

const MISSING = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
}, 120_000);
afterAll(async () => {
  await server?.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

let ip = 1;
const signup = () =>
  baseSignup(server.app, { remoteAddress: `127.8.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, projects: 'real' });

const api = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k-${randomUUID().slice(0, 8)}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

async function setup() {
  const owner = await signup();
  return { owner, key: await keyOf(owner.client) };
}

const body = (extra: Record<string, unknown> = {}) => ({
  type: 'instance',
  expression: '{{ true }}',
  role: 'admin',
  ...extra,
});

describe('create, list, move, update, delete', () => {
  it('runs the whole life of a rule with the n8n shape and our slugs', async () => {
    const { owner, key } = await setup();
    const project = await projectIn(server, owner.tenant.id, 'Team A');
    const first = await api(key, 'POST', '/role-mapping-rules', body({ expression: "{{ $claims.a === 'x' }}" }));
    expect(first.statusCode).toBe(201);
    const a = first.json().data;
    expect(a).toMatchObject({ type: 'instance', role: 'admin', order: 0, projectIds: [] });
    expect(typeof a.createdAt).toBe('string');
    const second = (await api(key, 'POST', '/role-mapping-rules', body({ role: 'member' }))).json().data;
    expect(second.order).toBe(1);
    const projectRule = (
      await api(
        key,
        'POST',
        '/role-mapping-rules',
        body({ type: 'project', role: 'project:editor', projectIds: [project.id] }),
      )
    ).json().data;
    expect(projectRule).toMatchObject({ type: 'project', order: 0, projectIds: [project.id] });

    const all = (await api(key, 'GET', '/role-mapping-rules')).json();
    expect(all.data.map((r: { id: string }) => r.id)).toEqual([a.id, second.id, projectRule.id]);
    expect(all.nextCursor).toBeNull();
    const onlyProject = (await api(key, 'GET', '/role-mapping-rules?type=project')).json();
    expect(onlyProject.data.map((r: { id: string }) => r.id)).toEqual([projectRule.id]);

    const page1 = (await api(key, 'GET', '/role-mapping-rules?limit=2')).json();
    expect(page1.data.length).toBe(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await api(key, 'GET', `/role-mapping-rules?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.data.map((r: { id: string }) => r.id)).toEqual([projectRule.id]);
    expect(page2.nextCursor).toBeNull();
    expect((await api(key, 'GET', '/role-mapping-rules?cursor=garbage')).statusCode).toBe(400);

    const moved = await api(key, 'POST', `/role-mapping-rules/${second.id}/move`, { order: 0 });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data).toMatchObject({ id: second.id, order: 0 });
    const order = (await api(key, 'GET', '/role-mapping-rules?type=instance')).json().data;
    expect(order.map((r: { id: string }) => r.id)).toEqual([second.id, a.id]);

    const patched = await api(key, 'PATCH', `/role-mapping-rules/${a.id}`, {
      role: 'member',
      expression: '{{ $claims.b }}',
    });
    expect(patched.json().data).toMatchObject({ id: a.id, role: 'member', expression: '{{ $claims.b }}' });

    const removed = await api(key, 'DELETE', `/role-mapping-rules/${a.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toEqual({ ok: true });
    expect((await api(key, 'DELETE', `/role-mapping-rules/${a.id}`)).statusCode).toBe(404);
  });

  it('refuses a bad expression, a role a rule may not give, a missing project and a bad body', async () => {
    const { key } = await setup();
    expect((await api(key, 'POST', '/role-mapping-rules', body({ expression: '{{ ( }}' }))).statusCode).toBe(400);
    expect((await api(key, 'POST', '/role-mapping-rules', body({ expression: 'x'.repeat(2001) }))).statusCode).toBe(
      400,
    );
    expect((await api(key, 'POST', '/role-mapping-rules', body({ role: 'owner' }))).statusCode).toBe(400);
    expect((await api(key, 'POST', '/role-mapping-rules', body({ role: 'global:nope' }))).statusCode).toBe(400);
    expect(
      (
        await api(
          key,
          'POST',
          '/role-mapping-rules',
          body({ type: 'project', role: 'project:editor', projectIds: [randomUUID()] }),
        )
      ).statusCode,
    ).toBe(404);
    expect((await api(key, 'POST', '/role-mapping-rules', { type: 'other' })).statusCode).toBe(400);
    expect((await api(key, 'POST', `/role-mapping-rules/${randomUUID()}/move`, { order: -1 })).statusCode).toBe(400);
    expect((await api(key, 'PATCH', `/role-mapping-rules/${randomUUID()}`, { role: 'member' })).statusCode).toBe(404);
  });
});

describe('scopes and tenants', () => {
  it('each route needs its own key scope', async () => {
    const { owner } = await setup();
    const made = (
      await api(await keyOf(owner.client), 'POST', '/role-mapping-rules', body())
    ).json().data as { id: string };
    const only = async (scope: string) => keyOf(owner.client, [scope]);
    const listKey = await only('roleMappingRule:list');
    const createKey = await only('roleMappingRule:create');
    const updateKey = await only('roleMappingRule:update');
    const deleteKey = await only('roleMappingRule:delete');

    expect((await api(listKey, 'GET', '/role-mapping-rules')).statusCode).toBe(200);
    expect((await api(createKey, 'GET', '/role-mapping-rules')).statusCode).toBe(403);
    expect((await api(listKey, 'POST', '/role-mapping-rules', body())).statusCode).toBe(403);
    expect((await api(createKey, 'POST', '/role-mapping-rules', body())).statusCode).toBe(201);
    expect((await api(listKey, 'PATCH', `/role-mapping-rules/${made.id}`, { role: 'member' })).statusCode).toBe(403);
    expect((await api(updateKey, 'PATCH', `/role-mapping-rules/${made.id}`, { role: 'member' })).statusCode).toBe(200);
    expect((await api(deleteKey, 'POST', `/role-mapping-rules/${made.id}/move`, { order: 0 })).statusCode).toBe(403);
    expect((await api(updateKey, 'POST', `/role-mapping-rules/${made.id}/move`, { order: 0 })).statusCode).toBe(200);
    expect((await api(updateKey, 'DELETE', `/role-mapping-rules/${made.id}`)).statusCode).toBe(403);
    expect((await api(deleteKey, 'DELETE', `/role-mapping-rules/${made.id}`)).statusCode).toBe(200);
  });

  it('a member without the scopes is refused even with an unrestricted key', async () => {
    const { owner } = await setup();
    const member = await realMember(owner);
    const memberKey = await keyOf(member.client);
    for (const [method, url] of [
      ['GET', '/role-mapping-rules'],
      ['POST', '/role-mapping-rules'],
      ['DELETE', `/role-mapping-rules/${randomUUID()}`],
    ] as const) {
      const res = await api(memberKey, method, url, method === 'POST' ? body() : undefined);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe(MISSING);
    }
  });

  it('another workspace sees none of the rules and gets 404 on their ids', async () => {
    const a = await setup();
    const b = await setup();
    const made = (await api(a.key, 'POST', '/role-mapping-rules', body())).json().data as { id: string };
    expect((await api(b.key, 'GET', '/role-mapping-rules')).json().data).toEqual([]);
    expect((await api(b.key, 'PATCH', `/role-mapping-rules/${made.id}`, { role: 'member' })).statusCode).toBe(404);
    expect((await api(b.key, 'POST', `/role-mapping-rules/${made.id}/move`, { order: 0 })).statusCode).toBe(404);
    expect((await api(b.key, 'DELETE', `/role-mapping-rules/${made.id}`)).statusCode).toBe(404);
    expect((await api(a.key, 'GET', '/role-mapping-rules')).json().data.length).toBe(1);
  });

  it('a project of another workspace is refused', async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await projectIn(server, b.owner.tenant.id, 'Foreign');
    const res = await api(
      a.key,
      'POST',
      '/role-mapping-rules',
      body({ type: 'project', role: 'project:editor', projectIds: [foreign.id] }),
    );
    expect(res.statusCode).toBe(404);
  });
});
