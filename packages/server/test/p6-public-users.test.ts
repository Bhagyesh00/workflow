/**
 * P6-21 (L5): the public users routes, as n8n's: GET /users (limit, cursor, includeRole, projectId), GET
 * /users/:id (id or email), POST /users (an array of invites through `inviteMany`), DELETE /users/:id
 * (`transferId`; none deletes the work) and PATCH /users/:id/role (the checks of PATCH /members/:userId, then
 * `changeMemberRole`).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/http/errors';
import {
  addToProject,
  signup as baseSignup,
  createTestServer,
  memberAs,
  projectIn,
  realMember,
  resetDatabase,
  type TestClient,
  type TestServer,
  workflowIn,
} from './helpers';

const MISSING = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  vi.restoreAllMocks();
});

let ip = 1;
/** signup allows 20 calls an hour per IP: each call comes from its own address */
const signup = (input: Parameters<typeof baseSignup>[1] = {}) =>
  baseSignup(server.app, {
    remoteAddress: `127.7.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
    ...input,
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
  const made = await client.data(
    client.post('/rest/api-keys', { name: `k-${randomUUID().slice(0, 8)}`, ...(scopes ? { scopes } : {}) }),
  );
  return made.key as string;
}

async function setup() {
  const owner = await signup();
  return { owner, ownerKey: await keyOf(owner.client) };
}

describe('GET /users', () => {
  it('lists the members and pending invitations in the n8n shape, role only on request', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner, { name: 'Mia Member Jones' });
    await owner.client.data(
      owner.client.post('/rest/members/invite', {
        email: 'later@example.com',
        role: 'member',
      }),
    );
    const list = (await api(ownerKey, 'GET', '/users')).json();
    expect(list.data).toHaveLength(3);
    expect(list.nextCursor).toBeNull();
    const mia = list.data.find((u: { id: string }) => u.id === member.user.id);
    expect(mia).toMatchObject({
      email: member.email,
      firstName: 'Mia',
      lastName: 'Member Jones',
      isPending: false,
    });
    expect(mia).not.toHaveProperty('role');
    expect(mia.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const pending = list.data.find((u: { email: string }) => u.email === 'later@example.com');
    expect(pending.isPending).toBe(true);
    expect(pending.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const withRole = (await api(ownerKey, 'GET', '/users?includeRole=true')).json();
    expect(withRole.data.map((u: { role: string }) => u.role).sort()).toEqual(['member', 'member', 'owner']);
  });

  it('pages with limit and cursor, with no repeats', async () => {
    const { owner, ownerKey } = await setup();
    await realMember(owner);
    await realMember(owner);
    const first = (await api(ownerKey, 'GET', '/users?limit=2')).json();
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await api(ownerKey, 'GET', `/users?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.data, ...second.data].map((u: { id: string }) => u.id);
    expect(new Set(ids).size).toBe(3);
    expect((await api(ownerKey, 'GET', '/users?cursor=bogus')).statusCode).toBe(400);
    expect((await api(ownerKey, 'GET', '/users?limit=0')).statusCode).toBe(400);
  });

  it('filters by project', async () => {
    const { owner, ownerKey } = await setup();
    const inside = await realMember(owner);
    await realMember(owner);
    const project = await projectIn(server, owner.tenant.id, 'Team A');
    await addToProject(server, owner.tenant.id, project.id, inside.user.id, 'project:editor');
    const list = (await api(ownerKey, 'GET', `/users?projectId=${project.id}`)).json();
    expect(list.data.map((u: { id: string }) => u.id)).toEqual([inside.user.id]);
    expect((await api(ownerKey, 'GET', '/users?projectId=nope')).statusCode).toBe(400);
  });

  it('never lists another workspace', async () => {
    const { ownerKey } = await setup();
    const other = await signup();
    const list = (await api(ownerKey, 'GET', '/users')).json();
    expect(list.data.map((u: { id: string }) => u.id)).not.toContain(other.user.id);
  });
});

describe('GET /users/:id', () => {
  it('finds a member by id and by email, and a pending person', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner, { name: 'Mia Jones' });
    const byId = (await api(ownerKey, 'GET', `/users/${member.user.id}?includeRole=true`)).json().data;
    expect(byId).toMatchObject({
      id: member.user.id,
      email: member.email,
      firstName: 'Mia',
      role: 'member',
    });
    const byEmail = (
      await api(ownerKey, 'GET', `/users/${encodeURIComponent(member.email.toUpperCase())}`)
    ).json().data;
    expect(byEmail.id).toBe(member.user.id);
    expect(byEmail).not.toHaveProperty('role');
    await owner.client.data(
      owner.client.post('/rest/members/invite', {
        email: 'wait@example.com',
        role: 'member',
      }),
    );
    const pending = (await api(ownerKey, 'GET', '/users/wait@example.com')).json().data;
    expect(pending).toMatchObject({
      email: 'wait@example.com',
      isPending: true,
    });
  });

  it('is a 404 for an unknown user, a user of another workspace and a bad id', async () => {
    const { ownerKey } = await setup();
    const other = await signup();
    expect((await api(ownerKey, 'GET', `/users/${randomUUID()}`)).statusCode).toBe(404);
    expect((await api(ownerKey, 'GET', `/users/${other.user.id}`)).statusCode).toBe(404);
    expect((await api(ownerKey, 'GET', `/users/${other.user.email}`)).statusCode).toBe(404);
    expect((await api(ownerKey, 'GET', '/users/not-a-user')).statusCode).toBe(404);
  });
});

describe('POST /users', () => {
  it('invites an array, one answer per row, through inviteMany', async () => {
    const { owner, ownerKey } = await setup();
    const spy = vi.spyOn(server.ctx.members, 'inviteMany');
    const res = await api(ownerKey, 'POST', '/users', [
      { email: 'a@example.com' },
      { email: 'b@example.com', role: 'global:admin' },
      { email: 'c@example.com', role: 'member' },
    ]);
    expect(res.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = res.json().data as Array<{
      email: string;
      role: string;
      emailSent: boolean;
      inviteAcceptUrl?: string;
    }>;
    expect(rows.map((r) => [r.email, r.role])).toEqual([
      ['a@example.com', 'member'],
      ['b@example.com', 'admin'],
      ['c@example.com', 'member'],
    ]);
    // no mail is set up in tests, so the link comes back
    expect(rows[0].emailSent).toBe(false);
    expect(rows[0].inviteAcceptUrl).toMatch(/\/invitation\//);
    const pending = await owner.client.data<Array<{ email: string; role: string }>>(
      owner.client.get('/rest/invitations'),
    );
    expect(pending).toHaveLength(3);
  });

  it('answers a row that fails by itself and still sends the others', async () => {
    const { owner, ownerKey } = await setup();
    const res = await api(ownerKey, 'POST', '/users', [
      { email: owner.user.email },
      { email: 'fresh@example.com', role: 'no-such-role' },
      { email: 'ok@example.com' },
    ]);
    expect(res.statusCode).toBe(201);
    const rows = res.json().data as Array<{ email: string; error?: string }>;
    expect(rows[0].error).toBeTruthy();
    expect(rows[1].error).toBeTruthy();
    expect(rows[2].error).toBeUndefined();
  });

  it('is refused whole when assertInviteAllowed throws', async () => {
    const { owner, ownerKey } = await setup();
    vi.spyOn(server.ctx.ssoLogin, 'assertInviteAllowed').mockRejectedValue(
      ApiError.forbidden('Invitations are off while SSO is on'),
    );
    const res = await api(ownerKey, 'POST', '/users', [{ email: 'no@example.com' }]);
    expect(res.statusCode).toBe(403);
    expect(await owner.client.data(owner.client.get('/rest/invitations'))).toEqual([]);
  });

  it('keeps the grant ceiling: a caller cannot invite above their own scopes, and bodies are checked', async () => {
    const { owner, ownerKey } = await setup();
    expect((await api(ownerKey, 'POST', '/users', [])).statusCode).toBe(400);
    expect((await api(ownerKey, 'POST', '/users', { email: 'x@example.com' })).statusCode).toBe(400);
    expect((await api(ownerKey, 'POST', '/users', [{ email: 'not-mail' }])).statusCode).toBe(400);
    const admin = await memberAs(owner, 'admin');
    const adminKey = await keyOf(admin.client);
    const res = await api(adminKey, 'POST', '/users', [{ email: 'boss@example.com', role: 'owner' }]);
    expect(res.statusCode).toBe(201);
    expect((res.json().data as Array<{ error?: string }>)[0].error).toBeTruthy();
    expect(await owner.client.data(owner.client.get('/rest/invitations'))).toEqual([]);
  });
});

describe('DELETE /users/:id', () => {
  it('with no transferId deletes the member and their work', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner);
    const personal = await server.ctx.repos.projects.getPersonal(owner.tenant.id, member.user.id);
    const wf = await workflowIn(server, owner.tenant.id, personal!.id);
    const res = await api(ownerKey, 'DELETE', `/users/${member.user.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect(
      await server.ctx.repos.memberships.getIncludingDisabled(owner.tenant.id, member.user.id),
    ).toBeUndefined();
    expect(await server.ctx.repos.workflows.get(owner.tenant.id, wf.id)).toBeUndefined();
    expect((await api(ownerKey, 'GET', `/users/${member.user.id}`)).statusCode).toBe(404);
  });

  it('with transferId moves the work to that project', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner);
    const personal = await server.ctx.repos.projects.getPersonal(owner.tenant.id, member.user.id);
    const wf = await workflowIn(server, owner.tenant.id, personal!.id);
    const team = await projectIn(server, owner.tenant.id, 'Receiver');
    const res = await api(ownerKey, 'DELETE', `/users/${member.user.id}?transferId=${team.id}`);
    expect(res.statusCode).toBe(200);
    const kept = await server.ctx.repos.workflows.get(owner.tenant.id, wf.id);
    expect(kept?.projectId).toBe(team.id);
  });

  it('refuses your own user, the last owner, an unknown member and a bad transferId', async () => {
    const { owner, ownerKey } = await setup();
    expect((await api(ownerKey, 'DELETE', `/users/${owner.user.id}`)).statusCode).toBe(400);
    expect((await api(ownerKey, 'DELETE', `/users/${randomUUID()}`)).statusCode).toBe(404);
    expect((await api(ownerKey, 'DELETE', `/users/${randomUUID()}?transferId=nope`)).statusCode).toBe(400);
    const member = await realMember(owner);
    expect(
      (await api(ownerKey, 'DELETE', `/users/${member.user.id}?transferId=${randomUUID()}`)).statusCode,
    ).toBe(404);
    expect(
      await server.ctx.repos.memberships.getIncludingDisabled(owner.tenant.id, member.user.id),
    ).toBeDefined();
  });

  it('keeps an owner from being removed by an admin', async () => {
    const { owner } = await setup();
    const admin = await memberAs(owner, 'admin');
    const adminKey = await keyOf(admin.client);
    const res = await api(adminKey, 'DELETE', `/users/${owner.user.id}`);
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /users/:id/role', () => {
  it('changes the role and calls the stubs of changeMemberRole', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner);
    const editable = vi.spyOn(server.ctx.provisioning, 'assertInstanceRolesEditable');
    const strip = vi.spyOn(server.ctx.apiKeys, 'onRoleChange');
    const after = vi.spyOn(server.ctx.privateCredentials, 'afterAccessChange');
    const res = await api(ownerKey, 'PATCH', `/users/${member.user.id}/role`, {
      newRoleName: 'global:admin',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
    expect(await server.ctx.repos.memberships.get(owner.tenant.id, member.user.id)).toEqual({
      role: 'admin',
    });
    expect(editable).toHaveBeenCalledWith(owner.tenant.id);
    expect(strip).toHaveBeenCalledWith(owner.tenant.id, member.user.id, 'admin');
    expect(after).toHaveBeenCalledWith(owner.tenant.id, {
      userId: member.user.id,
    });
  });

  it('takes a custom workspace role by its full slug, on a change and on an invite', async () => {
    const { owner, ownerKey } = await setup();
    await server.ctx.repos.roles.create(owner.tenant.id, {
      slug: 'global:auditor-1a2b3c',
      displayName: 'Auditor',
      roleType: 'global',
      scopes: ['workflow:read'],
    });
    const member = await realMember(owner);
    const change = await api(ownerKey, 'PATCH', `/users/${member.user.id}/role`, {
      newRoleName: 'global:auditor-1a2b3c',
    });
    expect(change.statusCode).toBe(200);
    expect(await server.ctx.repos.memberships.get(owner.tenant.id, member.user.id)).toEqual({
      role: 'global:auditor-1a2b3c',
    });
    const invite = await api(ownerKey, 'POST', '/users', [
      { email: 'auditor@example.com', role: 'global:auditor-1a2b3c' },
    ]);
    expect(invite.statusCode).toBe(201);
    expect(invite.json().data[0].error).toBeUndefined();
    const pending = await owner.client.data<Array<{ email: string; role: string }>>(
      owner.client.get('/rest/invitations'),
    );
    expect(pending.find((p) => p.email === 'auditor@example.com')?.role).toBe('global:auditor-1a2b3c');
  });

  it('is refused when the workspace manages roles itself (assertInstanceRolesEditable throws)', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner);
    vi.spyOn(server.ctx.provisioning, 'assertInstanceRolesEditable').mockRejectedValue(
      ApiError.forbidden('Roles are managed by provisioning'),
    );
    const strip = vi.spyOn(server.ctx.apiKeys, 'onRoleChange');
    const res = await api(ownerKey, 'PATCH', `/users/${member.user.id}/role`, {
      newRoleName: 'admin',
    });
    expect(res.statusCode).toBe(403);
    expect(strip).not.toHaveBeenCalled();
    expect(await server.ctx.repos.memberships.get(owner.tenant.id, member.user.id)).toEqual({
      role: 'member',
    });
  });

  it('keeps the owner rules, your own role, the last owner and the grant ceiling', async () => {
    const { owner, ownerKey } = await setup();
    const member = await realMember(owner);
    const admin = await memberAs(owner, 'admin');
    const adminKey = await keyOf(admin.client);
    // an admin neither grants nor takes the owner role
    expect(
      (
        await api(adminKey, 'PATCH', `/users/${member.user.id}/role`, {
          newRoleName: 'owner',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await api(adminKey, 'PATCH', `/users/${owner.user.id}/role`, {
          newRoleName: 'member',
        })
      ).statusCode,
    ).toBe(403);
    // the only owner stays, and hears why before the own-role rule
    const alone = await api(ownerKey, 'PATCH', `/users/${owner.user.id}/role`, { newRoleName: 'admin' });
    expect(alone.statusCode).toBe(409);
    const second = await memberAs(owner, 'owner');
    const secondKey = await keyOf(second.client);
    // not your own role
    const own = await api(ownerKey, 'PATCH', `/users/${owner.user.id}/role`, { newRoleName: 'admin' });
    expect(own.statusCode).toBe(403);
    expect(
      (await api(secondKey, 'PATCH', `/users/${owner.user.id}/role`, { newRoleName: 'member' })).statusCode,
    ).toBe(200);
    const last = await api(secondKey, 'PATCH', `/users/${second.user.id}/role`, { newRoleName: 'member' });
    expect(last.statusCode).toBe(409);
    // unknown role, bad body, unknown member
    expect(
      (
        await api(secondKey, 'PATCH', `/users/${member.user.id}/role`, {
          newRoleName: 'ghost',
        })
      ).statusCode,
    ).toBe(400);
    expect((await api(secondKey, 'PATCH', `/users/${member.user.id}/role`, {})).statusCode).toBe(400);
    expect(
      (
        await api(secondKey, 'PATCH', `/users/${randomUUID()}/role`, {
          newRoleName: 'member',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('scopes', () => {
  it('each route needs the key scope, and the user scope too', async () => {
    const { owner } = await setup();
    const member = await realMember(owner);
    const target = await realMember(owner);
    const wrongKey = await keyOf(owner.client, ['workflow:list']);
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/users'],
      ['GET', `/users/${target.user.id}`],
      ['POST', '/users', [{ email: 'k@example.com' }]],
      ['PATCH', `/users/${target.user.id}/role`, { newRoleName: 'admin' }],
      ['DELETE', `/users/${target.user.id}`],
    ];
    for (const [method, url, body] of calls) {
      const res = await api(wrongKey, method as 'GET', url, body);
      expect(res.statusCode, `${method} ${url} with the wrong key scope`).toBe(403);
    }
    // a member holds user:list but no user:read and none of the writes
    const memberKey = await keyOf(member.client);
    expect((await api(memberKey, 'GET', '/users')).statusCode).toBe(200);
    // a member's key offers user:list but not user:read
    expect((await api(memberKey, 'GET', `/users/${target.user.id}`)).statusCode).toBe(403);
    for (const [method, url, body] of calls.slice(2)) {
      const res = await api(memberKey, method as 'GET', url, body);
      expect(res.statusCode, `${method} ${url} as a member`).toBe(403);
      expect(res.json().error.message).toBe(MISSING);
    }
    // the right key scope on an owner works
    const listKey = await keyOf(owner.client, ['user:list']);
    expect((await api(listKey, 'GET', '/users')).statusCode).toBe(200);
    const readKey = await keyOf(owner.client, ['user:read']);
    expect((await api(readKey, 'GET', `/users/${target.user.id}`)).statusCode).toBe(200);
    const createKey = await keyOf(owner.client, ['user:create']);
    expect((await api(createKey, 'POST', '/users', [{ email: 'k2@example.com' }])).statusCode).toBe(201);
    const roleKey = await keyOf(owner.client, ['user:changeRole']);
    expect(
      (
        await api(roleKey, 'PATCH', `/users/${target.user.id}/role`, {
          newRoleName: 'admin',
        })
      ).statusCode,
    ).toBe(200);
    const deleteKey = await keyOf(owner.client, ['user:delete']);
    expect((await api(deleteKey, 'DELETE', `/users/${target.user.id}`)).statusCode).toBe(200);
  });

  it('a request with no key is 401', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/api/v1/users' })).statusCode).toBe(401);
  });
});
