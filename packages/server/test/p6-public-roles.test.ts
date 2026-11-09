/**
 * P6-34 (L13): the public roles routes, as n8n's: GET /roles and GET /roles/:slug (role:list, role:read),
 * POST, PUT and DELETE (role:manage, or role:manageProject for a project role). A member holds none of them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToProject,
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  signup,
  type TestClient,
  type TestServer,
} from './helpers';

const FORBIDDEN = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const api = (
  key: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

async function keyOf(client: TestClient, scopes?: string[]): Promise<string> {
  const made = await client.data(client.post('/rest/api-keys', { name: 'k', ...(scopes ? { scopes } : {}) }));
  return made.key as string;
}

async function setup() {
  const owner = await signup(server.app);
  const member = await realMember(owner);
  return { owner, member, ownerKey: await keyOf(owner.client), memberKey: await keyOf(member.client) };
}

describe('roles', () => {
  it('lists every role in one array and gets one by slug', async () => {
    const { ownerKey } = await setup();
    const list = (await api(ownerKey, 'GET', '/roles')).json();
    const slugs = list.data.map((r: { slug: string }) => r.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(['owner', 'admin', 'member', 'project:admin', 'project:editor']),
    );
    expect(slugs).toEqual(expect.arrayContaining(['workflow:owner', 'credential:user']));
    expect(list.nextCursor).toBeNull();
    const one = (await api(ownerKey, 'GET', '/roles/project:editor')).json().data;
    expect(one).toMatchObject({ slug: 'project:editor', systemRole: true, roleType: 'project' });
    expect(one.scopes).toContain('workflow:update');
    expect((await api(ownerKey, 'GET', '/roles/project:nope')).statusCode).toBe(404);
  });

  it('pages the list', async () => {
    const { ownerKey } = await setup();
    const first = (await api(ownerKey, 'GET', '/roles?limit=3')).json();
    expect(first.data).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = (await api(ownerKey, 'GET', `/roles?limit=3&cursor=${first.nextCursor}`)).json();
    const slugs = [...first.data, ...second.data].map((r: { slug: string }) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('creates, updates and deletes a custom project role', async () => {
    const { ownerKey } = await setup();
    const made = await api(ownerKey, 'POST', '/roles', {
      displayName: 'Reviewer',
      description: 'Reads and runs',
      roleType: 'project',
      scopes: ['workflow:read', 'workflow:execute', 'workflow:list'],
    });
    expect(made.statusCode).toBe(201);
    const role = made.json().data;
    expect(role).toMatchObject({ displayName: 'Reviewer', roleType: 'project', systemRole: false });
    expect((await api(ownerKey, 'GET', `/roles/${role.slug}`)).statusCode).toBe(200);
    const updated = await api(ownerKey, 'PUT', `/roles/${role.slug}`, { displayName: 'Checker' });
    expect(updated.json().data.displayName).toBe('Checker');
    expect((await api(ownerKey, 'DELETE', `/roles/${role.slug}`)).statusCode).toBe(200);
    expect((await api(ownerKey, 'GET', `/roles/${role.slug}`)).statusCode).toBe(404);
  });

  it('refuses a scope a custom role may not hold, and a system role cannot be changed', async () => {
    const { ownerKey } = await setup();
    const bad = await api(ownerKey, 'POST', '/roles', {
      displayName: 'Bad',
      roleType: 'global',
      scopes: ['logStreaming:manage'],
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await api(ownerKey, 'PUT', '/roles/project:editor', { displayName: 'Changed' })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await api(ownerKey, 'DELETE', '/roles/project:editor')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a member holds no role scope, and a key without the scope is refused', async () => {
    const { memberKey, owner, member } = await setup();
    const project = await projectIn(server, owner.tenant.id, 'Team');
    await addToProject(server, owner.tenant.id, project.id, member.user.id, 'project:admin');
    for (const [method, url, payload] of [
      ['GET', '/roles', undefined],
      ['GET', '/roles/project:editor', undefined],
      ['POST', '/roles', { displayName: 'Nope', roleType: 'project', scopes: [] }],
      ['PUT', '/roles/project:editor', { displayName: 'Nope' }],
      ['DELETE', '/roles/project:editor', undefined],
    ] as const) {
      const res = await api(memberKey, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(FORBIDDEN);
    }
    const narrow = await keyOf(owner.client, ['role:list']);
    expect((await api(narrow, 'GET', '/roles')).statusCode).toBe(200);
    expect((await api(narrow, 'GET', '/roles/project:editor')).statusCode).toBe(403);
    expect(
      (await api(narrow, 'POST', '/roles', { displayName: 'Nope', roleType: 'project', scopes: [] }))
        .statusCode,
    ).toBe(403);
  });
});
