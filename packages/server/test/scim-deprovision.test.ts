/**
 * P6-02 (L13): what a SCIM removal stops and moves. A deactivated or deleted user loses sessions, API keys
 * and MCP OAuth tokens in that workspace only; re-activation works; DELETE follows the policy
 * (`onDelete`, `dataAction`, the transfer target).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import { mintScimToken } from '../src/services/scim-token';
import {
  createTestServer,
  folderIn,
  projectIn,
  realMember,
  resetDatabase,
  sessionFor,
  signup,
  ssoOn,
  type TestServer,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ SCIM_RATE_LIMIT: '1000' }, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;
const SCIM = 'application/scim+json';

let ipCounter = 0;
const nextIp = () => `10.131.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

type Owner = Awaited<ReturnType<typeof signup>>;

/** SSO and SCIM on, with the policy; returns the token */
async function turnOn(
  owner: Owner,
  policy: { onDelete?: 'disable' | 'delete'; dataAction?: 'transfer' | 'delete'; transferProjectId?: string | null } = {},
) {
  await ssoOn(server, owner.tenant.id, 'saml');
  await repos().scim.patchSettings(owner.tenant.id, { enabled: true, ...policy });
  return (await mintScimToken(server.ctx.scim.deps, owner.tenant.id, owner.user.id)).token;
}

function scim(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, token: string, body?: unknown) {
  return server.app.inject({
    method,
    url: `/scim/v2${path}`,
    remoteAddress: '10.201.0.1',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': SCIM }) },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUser(token: string) {
  const userName = `dep-${randomUUID().slice(0, 8)}@example.com`;
  const res = await scim('POST', '/Users', token, {
    userName,
    externalId: randomUUID(),
    name: { givenName: 'Dee', familyName: 'Provision' },
    emails: [{ value: userName, primary: true, type: 'work' }],
    active: true,
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, userName };
}

/** an MCP OAuth access token of the user in the workspace; returns its hash */
async function mcpToken(tenantId: string, userId: string): Promise<string> {
  const clientId = `client-${randomUUID()}`;
  await repos().mcpOAuth.createClient({
    id: clientId,
    tenantId,
    name: 'Client',
    redirectUris: ['https://client.example/cb'],
    grantTypes: ['authorization_code'],
    tokenEndpointAuthMethod: 'none',
  });
  const access = sha256(`access-${randomUUID()}`);
  const base = {
    tenantId,
    clientId,
    userId,
    resource: 'http://localhost:5678/mcp-server/x/http',
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  await repos().mcpOAuth.saveTokens(
    { ...base, tokenHash: access },
    { ...base, tokenHash: sha256(`refresh-${randomUUID()}`) },
  );
  return access;
}

/** the same SCIM-made person is also a member of a second workspace B, with a session and a key there */
async function twoWorkspaces() {
  const a = await signup(server.app, { remoteAddress: nextIp() });
  const b = await signup(server.app, { remoteAddress: nextIp() });
  const token = await turnOn(a);
  const user = await createUser(token);
  await repos().memberships.add(b.tenant.id, user.id, 'member');
  await repos().projects.ensurePersonal(b.tenant.id, (await repos().users.get(user.id))!);
  return { a, b, token, user };
}

describe('deactivation', () => {
  it('stops sessions, API keys and MCP tokens in that workspace, and the same person in another keeps access', async () => {
    const { a, b, token, user } = await twoWorkspaces();
    const inA = await sessionFor(server, a.tenant.id, user.id);
    const inB = await sessionFor(server, b.tenant.id, user.id);
    const keyA = await server.ctx.auth.createApiKey(a.tenant.id, user.id, 'a-key');
    const keyB = await server.ctx.auth.createApiKey(b.tenant.id, user.id, 'b-key');
    const mcpA = await mcpToken(a.tenant.id, user.id);
    const mcpB = await mcpToken(b.tenant.id, user.id);
    expect((await inA.client.get('/rest/auth/me')).statusCode).toBe(200);

    // Okta and Entra send the deactivation as a PATCH of active
    const off = await scim('PATCH', `/Users/${user.id}`, token, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().active).toBe(false);

    expect((await inA.client.get('/rest/auth/me')).statusCode).toBe(401);
    expect(await repos().sessions.get(inA.sessionId)).toBeUndefined();
    expect(await server.ctx.auth.authenticateApiKey(keyA.key)).toBeUndefined();
    expect(
      (await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': keyA.key } })).statusCode,
    ).toBe(401);
    expect(await repos().mcpOAuth.getAccessToken(a.tenant.id, mcpA)).toBeUndefined();

    // workspace B is untouched
    expect((await inB.client.get('/rest/auth/me')).statusCode).toBe(200);
    expect((await server.ctx.auth.authenticateApiKey(keyB.key))?.user.id).toBe(user.id);
    expect(await repos().mcpOAuth.getAccessToken(b.tenant.id, mcpB)).toBeDefined();
    expect(await repos().memberships.get(b.tenant.id, user.id)).toBeDefined();
    const audit = await repos().audit.list(a.tenant.id, 50);
    expect(audit.find((r) => r.action === 'member.disabled')).toMatchObject({ resourceId: user.id });
  });

  it('active true enables the member again: a new session and the old key work', async () => {
    const { a, token, user } = await twoWorkspaces();
    const key = await server.ctx.auth.createApiKey(a.tenant.id, user.id, 'again');
    await scim('PATCH', `/Users/${user.id}`, token, { Operations: [{ op: 'replace', value: { active: 'False' } }] });
    expect(await repos().memberships.get(a.tenant.id, user.id)).toBeUndefined();
    const on = await scim('PATCH', `/Users/${user.id}`, token, {
      Operations: [{ op: 'replace', path: 'active', value: 'True' }],
    });
    expect(on.json().active).toBe(true);
    expect(await repos().memberships.get(a.tenant.id, user.id)).toBeDefined();
    expect((await server.ctx.auth.authenticateApiKey(key.key))?.user.id).toBe(user.id);
    const again = await sessionFor(server, a.tenant.id, user.id);
    expect((await again.client.get('/rest/auth/me')).statusCode).toBe(200);
    expect((await repos().audit.list(a.tenant.id, 50)).some((r) => r.action === 'member.enabled')).toBe(true);
  });
});

describe('DELETE with the policy disable (the default)', () => {
  it('deactivates, keeps the membership and the work, answers 204', async () => {
    const { a, token, user } = await twoWorkspaces();
    const personal = (await repos().projects.getPersonal(a.tenant.id, user.id))!;
    const workflow = await workflowIn(server, a.tenant.id, personal.id);
    const session = await sessionFor(server, a.tenant.id, user.id);
    const res = await scim('DELETE', `/Users/${user.id}`, token);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(await repos().sessions.get(session.sessionId)).toBeUndefined();
    expect((await repos().memberships.getIncludingDisabled(a.tenant.id, user.id))?.disabledAt).toBeTruthy();
    expect(await repos().workflows.get(a.tenant.id, workflow.id)).toBeDefined();
    expect(await repos().users.get(user.id)).toBeDefined();
    // gone from nowhere: SCIM still finds it, inactive
    expect((await scim('GET', `/Users/${user.id}`, token)).json().active).toBe(false);
    const audit = await repos().audit.list(a.tenant.id, 50);
    expect(audit.find((r) => r.action === 'scim.user_deleted')).toMatchObject({ metadata: { result: 'disabled' } });
  });
});

describe('DELETE with the policy delete', () => {
  it('moves the work to the stored team project, removes the membership and the SCIM-made account, keeps other workspaces', async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const b = await signup(server.app, { remoteAddress: nextIp() });
    const team = await projectIn(server, a.tenant.id, 'Receiving team');
    const token = await turnOn(a, { onDelete: 'delete', dataAction: 'transfer', transferProjectId: team.id });

    // user 1 is only in A: the account goes; user 2 is also in B: the account stays
    const only = await createUser(token);
    const shared = await createUser(token);
    await repos().memberships.add(b.tenant.id, shared.id, 'member');
    await repos().projects.ensurePersonal(b.tenant.id, (await repos().users.get(shared.id))!);
    const inB = await sessionFor(server, b.tenant.id, shared.id);
    const sharedPersonalB = (await repos().projects.getPersonal(b.tenant.id, shared.id))!;
    expect(await repos().projects.relations.listForUser(b.tenant.id, shared.id)).toHaveLength(1);

    const work: Record<string, string> = {};
    for (const user of [only, shared]) {
      const personal = (await repos().projects.getPersonal(a.tenant.id, user.id))!;
      work[user.id] = (await workflowIn(server, a.tenant.id, personal.id)).id;
      await folderIn(server, a.tenant.id, personal.id);
    }
    const key = await server.ctx.auth.createApiKey(a.tenant.id, only.id, 'gone');
    const mcp = await mcpToken(a.tenant.id, only.id);

    expect((await scim('DELETE', `/Users/${only.id}`, token)).statusCode).toBe(204);
    expect((await scim('DELETE', `/Users/${shared.id}`, token)).statusCode).toBe(204);

    for (const user of [only, shared]) {
      expect(await repos().memberships.getIncludingDisabled(a.tenant.id, user.id)).toBeUndefined();
      expect(await repos().projects.relations.listForUser(a.tenant.id, user.id)).toHaveLength(0);
      const moved = await repos().workflows.get(a.tenant.id, work[user.id]);
      expect(moved?.projectId).toBe(team.id);
      expect((await scim('GET', `/Users/${user.id}`, token)).statusCode).toBe(404);
    }
    expect(await repos().users.get(only.id)).toBeUndefined();
    expect(await server.ctx.auth.authenticateApiKey(key.key)).toBeUndefined();
    expect(await repos().mcpOAuth.getAccessToken(a.tenant.id, mcp)).toBeUndefined();

    // the other workspace keeps the person, the session and the project relation
    expect(await repos().users.get(shared.id)).toBeDefined();
    expect(await repos().memberships.get(b.tenant.id, shared.id)).toBeDefined();
    expect(await repos().sessions.get(inB.sessionId)).toBeDefined();
    expect(await repos().projects.relations.listForUser(b.tenant.id, shared.id)).toHaveLength(1);
    expect((await repos().projects.get(b.tenant.id, sharedPersonalB.id))?.id).toBe(sharedPersonalB.id);
    const audit = await repos().audit.list(a.tenant.id, 100);
    expect(audit.filter((r) => r.action === 'scim.user_deleted')).toHaveLength(2);
  });

  it('keeps the account of a user the workspace did not make (an invited member)', async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const member = await realMember(a);
    const token = await turnOn(a, { onDelete: 'delete', dataAction: 'transfer' });
    const res = await scim('DELETE', `/Users/${member.user.id}`, token);
    expect(res.statusCode).toBe(204);
    expect(await repos().memberships.getIncludingDisabled(a.tenant.id, member.user.id)).toBeUndefined();
    expect(await repos().users.get(member.user.id)).toBeDefined();
  });

  it("moves the work to the owner's personal project when the stored target is gone or is the user's own", async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const gone = await projectIn(server, a.tenant.id, 'Soon gone');
    const token = await turnOn(a, { onDelete: 'delete', dataAction: 'transfer', transferProjectId: gone.id });
    await repos().projects.delete(a.tenant.id, gone.id);
    const ownerHome = (await repos().projects.getPersonal(a.tenant.id, a.user.id))!;

    const first = await createUser(token);
    const w1 = await workflowIn(server, a.tenant.id, (await repos().projects.getPersonal(a.tenant.id, first.id))!.id);
    expect((await scim('DELETE', `/Users/${first.id}`, token)).statusCode).toBe(204);
    expect((await repos().workflows.get(a.tenant.id, w1.id))?.projectId).toBe(ownerHome.id);

    // the stored target is the personal project of the user who is removed
    const second = await createUser(token);
    const own = (await repos().projects.getPersonal(a.tenant.id, second.id))!;
    await repos().scim.patchSettings(a.tenant.id, { transferProjectId: own.id });
    const w2 = await workflowIn(server, a.tenant.id, own.id);
    expect((await scim('DELETE', `/Users/${second.id}`, token)).statusCode).toBe(204);
    expect((await repos().workflows.get(a.tenant.id, w2.id))?.projectId).toBe(ownerHome.id);
  });

  it('deletes the work with dataAction delete', async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const token = await turnOn(a, { onDelete: 'delete', dataAction: 'delete' });
    const user = await createUser(token);
    const personal = (await repos().projects.getPersonal(a.tenant.id, user.id))!;
    const workflow = await workflowIn(server, a.tenant.id, personal.id);
    const folder = await folderIn(server, a.tenant.id, personal.id);
    expect((await scim('DELETE', `/Users/${user.id}`, token)).statusCode).toBe(204);
    expect(await repos().workflows.get(a.tenant.id, workflow.id)).toBeUndefined();
    expect(await repos().folders.get(a.tenant.id, folder.id)).toBeUndefined();
    expect(await repos().memberships.getIncludingDisabled(a.tenant.id, user.id)).toBeUndefined();
  });

  it('an admin is only deactivated, an owner is refused with 403 and nothing moves', async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const token = await turnOn(a, { onDelete: 'delete', dataAction: 'delete' });
    const admin = await createUser(token);
    await repos().memberships.updateRole(a.tenant.id, admin.id, 'admin');
    const workflow = await workflowIn(server, a.tenant.id, (await repos().projects.getPersonal(a.tenant.id, admin.id))!.id);
    expect((await scim('DELETE', `/Users/${admin.id}`, token)).statusCode).toBe(204);
    expect((await repos().memberships.getIncludingDisabled(a.tenant.id, admin.id))?.disabledAt).toBeTruthy();
    expect(await repos().workflows.get(a.tenant.id, workflow.id)).toBeDefined();

    const ownerWork = await workflowIn(server, a.tenant.id, (await repos().projects.getPersonal(a.tenant.id, a.user.id))!.id);
    expect((await scim('DELETE', `/Users/${a.user.id}`, token)).statusCode).toBe(403);
    expect(await repos().memberships.get(a.tenant.id, a.user.id)).toEqual({ role: 'owner' });
    expect(await repos().workflows.get(a.tenant.id, ownerWork.id)).toBeDefined();
  });

  it("answers 404 for an unknown user and never removes another workspace's member", async () => {
    const a = await signup(server.app, { remoteAddress: nextIp() });
    const b = await signup(server.app, { remoteAddress: nextIp() });
    const tokenA = await turnOn(a, { onDelete: 'delete', dataAction: 'transfer' });
    expect((await scim('DELETE', `/Users/${randomUUID()}`, tokenA)).statusCode).toBe(404);
    expect((await scim('DELETE', `/Users/${b.user.id}`, tokenA)).statusCode).toBe(404);
    expect(await repos().memberships.get(b.tenant.id, b.user.id)).toEqual({ role: 'owner' });
  });
});
