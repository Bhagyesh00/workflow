/**
 * P6-02 (L13): /rest/scim/*: the config, the SSO rule for turning SCIM on, the token (shown once, rotated,
 * revoked), the deprovisioning policy and the transfer targets. All of it needs `scim:manage`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import {
  createTestServer,
  projectIn,
  realMember,
  resetDatabase,
  sessionFor,
  signup,
  ssoOn,
  type TestServer,
} from './helpers';

const MISSING_SCOPE = 'User is missing a scope required to perform this action';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const repos = () => server.ctx.repos;

let ipCounter = 0;
const ws = () =>
  signup(server.app, { remoteAddress: `10.132.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

describe('access', () => {
  it('needs a session (401) and scim:manage: a member gets 403, an admin passes', async () => {
    const owner = await ws();
    const member = await realMember(owner);
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/rest/scim/config'],
      ['PATCH', '/rest/scim/config', { enabled: false }],
      ['PUT', '/rest/scim/deprovisioning', { onDelete: 'disable', dataAction: 'transfer' }],
      ['POST', '/rest/scim/token'],
      ['DELETE', '/rest/scim/token'],
      ['GET', '/rest/scim/transfer-targets'],
    ];
    for (const [method, url, body] of calls) {
      const anonymous = await server.app.inject({
        method: method as 'GET',
        url,
        headers: { origin: 'http://localhost:5678', 'content-type': 'application/json' },
        payload: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      const res = await member.client.request(method as 'GET', url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.message).toBe(MISSING_SCOPE);
    }
    expect(await repos().scim.get(owner.tenant.id)).toBeUndefined();
    const admin = await realMember(owner);
    await repos().memberships.updateRole(owner.tenant.id, admin.user.id, 'admin');
    expect((await admin.client.get('/rest/scim/config')).statusCode).toBe(200);
  });
});

describe('config', () => {
  it('starts off, with no token, the defaults and the base URL', async () => {
    const owner = await ws();
    const config = await owner.client.data(owner.client.get('/rest/scim/config'));
    expect(config).toEqual({
      enabled: false,
      hasToken: false,
      tokenHint: null,
      baseUrl: `${server.ctx.config.baseUrl}/scim/v2`,
      onDelete: 'disable',
      dataAction: 'transfer',
      transferProjectId: null,
    });
  });

  it('turning SCIM on needs SAML or OIDC; off needs nothing', async () => {
    const owner = await ws();
    const refused = await owner.client.patch('/rest/scim/config', { enabled: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toBe(
      'Turn on SAML or OIDC single sign-on before you enable SCIM provisioning.',
    );
    expect((await owner.client.data(owner.client.get('/rest/scim/config'))).enabled).toBe(false);
    await ssoOn(server, owner.tenant.id, 'oidc');
    expect(
      (await owner.client.data(owner.client.patch('/rest/scim/config', { enabled: true }))).enabled,
    ).toBe(true);
    expect(
      (await owner.client.data(owner.client.patch('/rest/scim/config', { enabled: false }))).enabled,
    ).toBe(false);
    expect((await owner.client.patch('/rest/scim/config', { enabled: 'yes' })).statusCode).toBe(400);
    // a rest of the settings stays when the SCIM object is written
    const tenant = await repos().tenants.get(owner.tenant.id);
    expect(tenant?.settings).toMatchObject({ scim: { enabled: false } });
  });

  it('does not change the rest of the workspace settings', async () => {
    const owner = await ws();
    await ssoOn(server, owner.tenant.id, 'saml');
    await repos().tenants.updateSettings(owner.tenant.id, {
      firstProductionFailure: { at: '2026-01-01T00:00:00.000Z' },
    });
    await owner.client.patch('/rest/scim/config', { enabled: true });
    await owner.client.put('/rest/scim/deprovisioning', { onDelete: 'delete', dataAction: 'delete' });
    const tenant = await repos().tenants.get(owner.tenant.id);
    expect(tenant?.settings).toMatchObject({
      firstProductionFailure: { at: '2026-01-01T00:00:00.000Z' },
      scim: { enabled: true, onDelete: 'delete', dataAction: 'delete' },
    });
  });
});

describe('token', () => {
  it('mints wfs_scim_ plus 43 characters once, stores only the hash and the last four', async () => {
    const owner = await ws();
    const res = await owner.client.post('/rest/scim/token');
    expect(res.statusCode).toBe(201);
    const { token, baseUrl } = res.json().data;
    expect(token).toMatch(/^wfs_scim_[A-Za-z0-9_-]{43}$/);
    expect(baseUrl).toBe(`${server.ctx.config.baseUrl}/scim/v2`);
    const row = await repos().scim.get(owner.tenant.id);
    expect(row).toMatchObject({
      tokenHash: sha256(token),
      tokenHint: token.slice(-4),
      createdBy: owner.user.id,
    });
    const config = await owner.client.data(owner.client.get('/rest/scim/config'));
    expect(config).toMatchObject({ hasToken: true, tokenHint: token.slice(-4) });
    // the token never comes back, in the config or the audit log
    expect(JSON.stringify(config)).not.toContain(token);
    const audit = await repos().audit.list(owner.tenant.id, 50);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(audit.find((r) => r.action === 'scim.token_created')).toMatchObject({ userId: owner.user.id });
  });

  it('a new token replaces the old one: the old stops working, there is one per workspace', async () => {
    const owner = await ws();
    await ssoOn(server, owner.tenant.id, 'saml');
    await owner.client.patch('/rest/scim/config', { enabled: true });
    const first = (await owner.client.post('/rest/scim/token')).json().data.token as string;
    const second = (await owner.client.post('/rest/scim/token')).json().data.token as string;
    expect(second).not.toBe(first);
    const call = (token: string) =>
      server.app.inject({
        url: '/scim/v2/Users',
        remoteAddress: '10.202.0.1',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await call(first)).statusCode).toBe(401);
    expect((await call(second)).statusCode).toBe(200);
  });

  it("revokes: SCIM answers 401, the config says no token, another workspace's token is untouched", async () => {
    const a = await ws();
    const b = await ws();
    for (const owner of [a, b]) {
      await ssoOn(server, owner.tenant.id, 'saml');
      await owner.client.patch('/rest/scim/config', { enabled: true });
    }
    const tokenA = (await a.client.post('/rest/scim/token')).json().data.token as string;
    const tokenB = (await b.client.post('/rest/scim/token')).json().data.token as string;
    expect((await a.client.delete('/rest/scim/token')).json().data).toEqual({ ok: true });
    const call = (token: string) =>
      server.app.inject({
        url: '/scim/v2/Users',
        remoteAddress: '10.202.0.2',
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await call(tokenA)).statusCode).toBe(401);
    expect((await call(tokenB)).statusCode).toBe(200);
    expect(await a.client.data(a.client.get('/rest/scim/config'))).toMatchObject({
      hasToken: false,
      tokenHint: null,
    });
    expect((await repos().audit.list(a.tenant.id, 50)).some((r) => r.action === 'scim.token_revoked')).toBe(
      true,
    );
    // revoking again is a no-op
    expect((await a.client.delete('/rest/scim/token')).statusCode).toBe(200);
  });
});

describe('deprovisioning and transfer targets', () => {
  it('lists team projects and the personal projects of active members only', async () => {
    const owner = await ws();
    const team = await projectIn(server, owner.tenant.id, 'Receiving');
    const member = await realMember(owner);
    const gone = await realMember(owner);
    await repos().memberships.disable(owner.tenant.id, gone.user.id);
    const other = await ws();
    const foreign = await projectIn(server, other.tenant.id, 'Foreign team');

    const targets = await owner.client.data<Array<{ id: string; name: string; type: string }>>(
      owner.client.get('/rest/scim/transfer-targets'),
    );
    const ids = targets.map((t) => t.id);
    expect(ids).toContain(team.id);
    expect(targets.find((t) => t.id === team.id)).toMatchObject({ name: 'Receiving', type: 'team' });
    const personalOf = async (id: string) => (await repos().projects.getPersonal(owner.tenant.id, id))!.id;
    expect(ids).toContain(await personalOf(member.user.id));
    expect(ids).toContain(await personalOf(owner.user.id));
    expect(ids).not.toContain(await personalOf(gone.user.id));
    expect(ids).not.toContain(foreign.id);
    for (const t of targets) expect(['team', 'personal']).toContain(t.type);
  });

  it('saves the policy and the target; refuses another workspace, a disabled member and a bad value', async () => {
    const owner = await ws();
    const team = await projectIn(server, owner.tenant.id, 'Receiving');
    const saved = await owner.client.data(
      owner.client.put('/rest/scim/deprovisioning', {
        onDelete: 'delete',
        dataAction: 'transfer',
        transferProjectId: team.id,
      }),
    );
    expect(saved).toMatchObject({ onDelete: 'delete', dataAction: 'transfer', transferProjectId: team.id });
    expect(await owner.client.data(owner.client.get('/rest/scim/config'))).toMatchObject({
      onDelete: 'delete',
      dataAction: 'transfer',
      transferProjectId: team.id,
    });

    // delete the work: no target is kept
    const deleted = await owner.client.data(
      owner.client.put('/rest/scim/deprovisioning', {
        onDelete: 'delete',
        dataAction: 'delete',
        transferProjectId: team.id,
      }),
    );
    expect(deleted).toMatchObject({ dataAction: 'delete', transferProjectId: null });

    const other = await ws();
    const foreign = await projectIn(server, other.tenant.id, 'Foreign');
    const notFound = await owner.client.put('/rest/scim/deprovisioning', {
      onDelete: 'disable',
      dataAction: 'transfer',
      transferProjectId: foreign.id,
    });
    expect(notFound.statusCode).toBe(404);

    const gone = await realMember(owner);
    await repos().memberships.disable(owner.tenant.id, gone.user.id);
    const personal = (await repos().projects.getPersonal(owner.tenant.id, gone.user.id))!;
    const refused = await owner.client.put('/rest/scim/deprovisioning', {
      onDelete: 'disable',
      dataAction: 'transfer',
      transferProjectId: personal.id,
    });
    expect(refused.statusCode).toBe(400);
    for (const bad of [
      { onDelete: 'remove', dataAction: 'transfer' },
      { onDelete: 'delete', dataAction: 'move' },
      { onDelete: 'delete', dataAction: 'transfer', transferProjectId: 'not-a-uuid' },
    ]) {
      expect((await owner.client.put('/rest/scim/deprovisioning', bad)).statusCode).toBe(400);
    }
  });

  it('an owner session that signed in with SSO can still manage SCIM', async () => {
    const owner = await ws();
    const session = await sessionFor(server, owner.tenant.id, owner.user.id, { authMethod: 'saml' });
    expect((await session.client.get('/rest/scim/config')).statusCode).toBe(200);
  });
});
