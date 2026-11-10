/**
 * P6-01 (L6): the SSO foundation. Password sign-in under SAML, OIDC and LDAP (owner and the manual login
 * flag), the sign-in method and its rules, the public sign-in options, invitations under SSO, another
 * workspace's settings, row-level security, `signIn`'s account rules (Q-A2, each branch), the JIT user's
 * personal project and `safeSsoRedirect`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TenantRow } from '../src/db/schema';
import { SSO_INVITES_BLOCKED_MESSAGE, SSO_SIGN_IN_ERRORS, type SsoProfile } from '../src/services/sso/login';
import { safeSsoRedirect } from '../src/services/sso/redirect';
import {
  createTestServer,
  flushRedis,
  ORIGIN,
  realMember,
  signup,
  ssoOn,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
let address = 0;
/** signup allows 20 an hour per IP: every caller gets its own */
const nextAddress = () => {
  address++;
  return `10.61.${Math.floor(address / 250)}.${(address % 250) + 1}`;
};

const SAML_CONFIG = {
  samlMetadata: '<EntityDescriptor/>',
  saml: { loginLabel: 'Okta', emailVerifiedRequired: false },
};
const OIDC_CONFIG = {
  oidc: { clientId: 'client-1', discoveryEndpoint: 'https://idp.test/.well-known/openid-configuration' },
};
const LDAP_CONFIG = { ldap: { connectionUrl: 'ldap.test', loginLabel: 'Directory' } };

beforeAll(async () => {
  await flushRedis();
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '100' });
});

afterAll(async () => {
  await server?.close();
});

const owner = () => signup(server.app, { remoteAddress: nextAddress() });
const memberOf = (o: { client: TestClient }) => realMember(o, { remoteAddress: nextAddress() });

function login(email: string, workspace?: string) {
  const client = new TestClient(server.app, ORIGIN, nextAddress());
  return client.post('/rest/auth/login', {
    email,
    password: 'Passw0rd!',
    ...(workspace ? { workspace } : {}),
  });
}

async function tenantRow(id: string): Promise<TenantRow> {
  return (await server.ctx.repos.tenants.get(id))!;
}

function profile(email: string, overrides: Partial<SsoProfile> = {}): SsoProfile {
  return {
    providerType: 'oidc',
    providerId: `sub-${randomUUID()}`,
    email,
    emailVerified: true,
    claims: {},
    ...overrides,
  };
}

const newEmail = () => `sso-${randomUUID().slice(0, 8)}@example.com`;

async function failure(
  promise: Promise<unknown>,
): Promise<{ statusCode?: number; code?: string; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; code?: string; message?: string };
  }
  throw new Error('expected a refusal');
}

async function auditActions(
  tenantId: string,
): Promise<Array<{ action: string; metadata: Record<string, unknown> }>> {
  const { rows } = await server.ctx.database.pool.query(
    'select action, metadata from audit_log where tenant_id = $1 order by id',
    [tenantId],
  );
  return rows;
}

describe('password sign-in under SSO', () => {
  it('with SSO on, a password sign-in is refused and the owner still gets in', async () => {
    const o = await owner();
    const m = await memberOf(o);
    expect((await login(m.email)).statusCode).toBe(200);
    await ssoOn(server, o.tenant.id, 'saml', SAML_CONFIG);
    const refused = await login(m.email);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'sso_required' });
    const ownerLogin = await login(o.user.email);
    expect(ownerLogin.statusCode).toBe(200);
    expect(ownerLogin.json().data.tenant.id).toBe(o.tenant.id);
  });

  it('a member an admin allows signs in with a password; the flag needs user:update', async () => {
    const o = await owner();
    const m = await memberOf(o);
    await ssoOn(server, o.tenant.id, 'oidc', OIDC_CONFIG);
    expect((await login(m.email)).statusCode).toBe(403);
    const url = `/rest/members/${m.user.id}/sso-settings`;
    expect((await m.client.patch(url, { allowSsoManualLogin: true })).statusCode).toBe(403);
    const allowed = await o.client.data(o.client.patch(url, { allowSsoManualLogin: true }));
    expect(allowed).toMatchObject({
      userId: m.user.id,
      email: m.email,
      allowSsoManualLogin: true,
      status: 'active',
    });
    expect((await login(m.email)).statusCode).toBe(200);
    await o.client.data(o.client.patch(url, { allowSsoManualLogin: false }));
    expect((await login(m.email)).statusCode).toBe(403);
    expect((await o.client.patch(url, {})).statusCode).toBe(400);
    expect(
      (await o.client.patch(`/rest/members/${randomUUID()}/sso-settings`, { allowSsoManualLogin: true }))
        .statusCode,
    ).toBe(404);
  });

  it('an LDAP workspace lets only owners in by email', async () => {
    const o = await owner();
    const m = await memberOf(o);
    await ssoOn(server, o.tenant.id, 'ldap', LDAP_CONFIG);
    expect((await login(m.email)).json().error).toMatchObject({ code: 'sso_required' });
    expect((await login(o.user.email)).statusCode).toBe(200);
  });

  it('a user in two workspaces signs in to the one the password may enter, and cannot switch into the other', async () => {
    const a = await owner();
    const b = await owner();
    const m = await memberOf(a);
    await server.ctx.repos.memberships.add(b.tenant.id, m.user.id, 'member');
    await ssoOn(server, a.tenant.id, 'saml', SAML_CONFIG);
    const first = await login(m.email);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.tenant.id).toBe(b.tenant.id);
    // naming the SSO workspace refuses, so the page shows its SSO instead of opening the other one
    expect((await login(m.email, a.tenant.slug)).json().error).toMatchObject({ code: 'sso_required' });
    const client = new TestClient(server.app, ORIGIN, nextAddress());
    await client.data(client.post('/rest/auth/login', { email: m.email, password: 'Passw0rd!' }));
    const switched = await client.post('/rest/auth/switch-tenant', { tenantId: a.tenant.id });
    expect(switched.statusCode).toBe(403);
    expect(switched.json().error).toMatchObject({ code: 'sso_required' });
    await server.ctx.repos.memberships.setAllowSsoManualLogin(a.tenant.id, m.user.id, true);
    expect((await client.post('/rest/auth/switch-tenant', { tenantId: a.tenant.id })).statusCode).toBe(200);
  });

  it('passwordAllowedSomewhere answers yes, no or ldap', async () => {
    const saml = await owner();
    const m = await memberOf(saml);
    const ldap = await owner();
    const l = await memberOf(ldap);
    const { ssoLogin } = server.ctx;
    expect(await ssoLogin.passwordAllowedSomewhere(m.user.id)).toBe('yes');
    await ssoOn(server, saml.tenant.id, 'saml', SAML_CONFIG);
    await ssoOn(server, ldap.tenant.id, 'ldap', LDAP_CONFIG);
    expect(await ssoLogin.passwordAllowedSomewhere(m.user.id)).toBe('no');
    expect(await ssoLogin.passwordAllowedSomewhere(l.user.id)).toBe('ldap');
    expect(await ssoLogin.passwordAllowedSomewhere(saml.user.id)).toBe('yes');
    await server.ctx.repos.memberships.setAllowSsoManualLogin(saml.tenant.id, m.user.id, true);
    expect(await ssoLogin.passwordAllowedSomewhere(m.user.id)).toBe('yes');
  });
});

describe('invitations under SSO', () => {
  it('an invitation in an SSO workspace is refused by password; invites are blocked unless SCIM is on', async () => {
    const o = await owner();
    const email = newEmail();
    const invite = await o.client.data<{ token: string }>(
      o.client.post('/rest/members/invite', { email, role: 'member' }),
    );
    await ssoOn(server, o.tenant.id, 'saml', SAML_CONFIG);
    const accept = await new TestClient(server.app).post(`/rest/invitations/${invite.token}/accept`, {
      name: 'Invitee',
      password: 'Passw0rd!',
    });
    expect(accept.statusCode).toBe(403);
    expect(accept.json().error).toMatchObject({ code: 'sso_required' });
    expect(await server.ctx.repos.users.getByEmail(email)).toBeUndefined();

    const blocked = await o.client.post('/rest/members/invite', { email: newEmail(), role: 'member' });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatchObject({
      code: 'sso_invites_blocked',
      message: SSO_INVITES_BLOCKED_MESSAGE,
    });
    await server.ctx.repos.tenants.update(o.tenant.id, { settings: { scim: { enabled: true } } });
    expect(
      (await o.client.post('/rest/members/invite', { email: newEmail(), role: 'member' })).statusCode,
    ).toBe(200);
  });

  it('LDAP keeps invitations', async () => {
    const o = await owner();
    await ssoOn(server, o.tenant.id, 'ldap', LDAP_CONFIG);
    expect(
      (await o.client.post('/rest/members/invite', { email: newEmail(), role: 'member' })).statusCode,
    ).toBe(200);
  });
});

describe('the sign-in method', () => {
  it('moves between SAML and OIDC only through email and needs a saved config', async () => {
    const o = await owner();
    const m = await memberOf(o);
    expect(await o.client.data(o.client.get('/rest/sso/method'))).toEqual({ method: 'email' });
    const missing = await o.client.put('/rest/sso/method', { method: 'saml' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: 'sso_config_missing' });
    await ssoOn(server, o.tenant.id, 'email', { ...SAML_CONFIG, ...OIDC_CONFIG });
    expect(await o.client.data(o.client.put('/rest/sso/method', { method: 'saml' }))).toEqual({
      method: 'saml',
    });
    const direct = await o.client.put('/rest/sso/method', { method: 'oidc' });
    expect(direct.statusCode).toBe(400);
    expect(direct.json().error).toMatchObject({ code: 'sso_switch_through_email' });
    expect((await o.client.put('/rest/sso/method', { method: 'ldap' })).statusCode).toBe(400);
    expect(await o.client.data(o.client.put('/rest/sso/method', { method: 'email' }))).toEqual({
      method: 'email',
    });
    expect(await o.client.data(o.client.put('/rest/sso/method', { method: 'oidc' }))).toEqual({
      method: 'oidc',
    });
    expect(await server.ctx.ssoSettings.isSsoActive(o.tenant.id)).toBe(true);
    expect((await o.client.put('/rest/sso/method', { method: 'kerberos' })).statusCode).toBe(400);
    expect((await m.client.put('/rest/sso/method', { method: 'email' })).statusCode).toBe(403);
    expect((await m.client.get('/rest/sso/method')).statusCode).toBe(403);
    const changes = (await auditActions(o.tenant.id)).filter((a) => a.action === 'sso.method_changed');
    expect(changes.map((a) => a.metadata)).toEqual([
      { from: 'email', to: 'saml' },
      { from: 'saml', to: 'email' },
      { from: 'email', to: 'oidc' },
    ]);
  });

  it('turning SSO off turns SCIM off and keeps the rest of its settings', async () => {
    const o = await owner();
    await server.ctx.repos.tenants.update(o.tenant.id, {
      settings: { scim: { enabled: true, onDelete: 'disable' }, other: 1 },
    });
    await ssoOn(server, o.tenant.id, 'saml', SAML_CONFIG);
    await o.client.data(o.client.put('/rest/sso/method', { method: 'email' }));
    expect((await tenantRow(o.tenant.id)).settings).toEqual({
      scim: { enabled: false, onDelete: 'disable' },
      other: 1,
    });
    // without SCIM settings nothing is written
    const plain = await owner();
    await ssoOn(server, plain.tenant.id, 'oidc', OIDC_CONFIG);
    await plain.client.data(plain.client.put('/rest/sso/method', { method: 'email' }));
    expect((await tenantRow(plain.tenant.id)).settings).toEqual({});
  });

  it('saveSection writes one section and refuses a value that is not an object', async () => {
    const o = await owner();
    await server.ctx.ssoSettings.saveSection(o.tenant.id, 'provisioning', {
      scopesProvisionInstanceRole: true,
    });
    expect((await server.ctx.ssoSettings.get(o.tenant.id))?.provisioning).toEqual({
      scopesProvisionInstanceRole: true,
    });
    expect(await server.ctx.ssoSettings.activeMethod(o.tenant.id)).toBe('email');
    expect((await failure(server.ctx.ssoSettings.saveSection(o.tenant.id, 'saml', 'x'))).statusCode).toBe(
      400,
    );
  });
});

describe('GET /rest/auth/sso-options', () => {
  it('answers the method, the label and the redirect flag; an unknown workspace answers email', async () => {
    const anonymous = new TestClient(server.app, ORIGIN, nextAddress());
    const o = await owner();
    await ssoOn(server, o.tenant.id, 'saml', SAML_CONFIG);
    expect(await anonymous.data(anonymous.get(`/rest/auth/sso-options?workspace=${o.tenant.slug}`))).toEqual({
      method: 'saml',
      label: 'Okta',
      redirect: true,
    });
    const email = { method: 'email', label: null, redirect: false };
    expect(await anonymous.data(anonymous.get('/rest/auth/sso-options?workspace=no-such-space'))).toEqual(
      email,
    );
    expect(await anonymous.data(anonymous.get('/rest/auth/sso-options'))).toEqual(email);
    const config = server.ctx.config as { ssoRedirectLogin: boolean };
    config.ssoRedirectLogin = false;
    try {
      expect(
        (await anonymous.data(anonymous.get(`/rest/auth/sso-options?workspace=${o.tenant.slug}`))).redirect,
      ).toBe(false);
    } finally {
      config.ssoRedirectLogin = true;
    }
    const l = await owner();
    await ssoOn(server, l.tenant.id, 'ldap', LDAP_CONFIG);
    expect(await anonymous.data(anonymous.get(`/rest/auth/sso-options?workspace=${l.tenant.slug}`))).toEqual({
      method: 'ldap',
      label: 'Directory',
      redirect: false,
    });
  });

  it('is rate limited per IP', async () => {
    const anonymous = new TestClient(server.app, ORIGIN, nextAddress());
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await anonymous.get('/rest/auth/sso-options')).statusCode);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe('another workspace', () => {
  it("another workspace's method and members are out of reach", async () => {
    const a = await owner();
    const m = await memberOf(a);
    await ssoOn(server, a.tenant.id, 'saml', SAML_CONFIG);
    const b = await owner();
    expect(await b.client.data(b.client.get('/rest/sso/method'))).toEqual({ method: 'email' });
    const foreign = await b.client.patch(`/rest/members/${m.user.id}/sso-settings`, {
      allowSsoManualLogin: true,
    });
    expect(foreign.statusCode).toBe(404);
    const [rule] = await server.ctx.repos.sso.signInRules(m.user.id, a.tenant.id);
    expect(rule.allowSsoManualLogin).toBe(false);
    expect(await server.ctx.ssoSettings.activeMethod(b.tenant.id)).toBe('email');
  });

  it('both tables are under row-level security', async () => {
    const a = await owner();
    const b = await owner();
    await ssoOn(server, a.tenant.id, 'oidc', OIDC_CONFIG);
    await ssoOn(server, b.tenant.id, 'oidc', OIDC_CONFIG);
    await server.ctx.ssoLogin.signIn(
      await tenantRow(a.tenant.id),
      profile(a.user.email),
      {},
      { authMethod: 'oidc' },
    );
    await server.ctx.ssoLogin.signIn(
      await tenantRow(b.tenant.id),
      profile(b.user.email),
      {},
      { authMethod: 'oidc' },
    );
    const pool = server.ctx.database.pool;
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workflow_rls_probe') THEN
        CREATE ROLE workflow_rls_probe NOLOGIN;
      END IF;
    END $$`);
    await pool.query('GRANT SELECT ON tenant_auth_settings, auth_identities TO workflow_rls_probe');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE workflow_rls_probe');
      expect((await client.query('SELECT count(*)::int AS n FROM tenant_auth_settings')).rows[0].n).toBe(0);
      expect((await client.query('SELECT count(*)::int AS n FROM auth_identities')).rows[0].n).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [a.tenant.id]);
      expect((await client.query('SELECT tenant_id FROM tenant_auth_settings')).rows).toEqual([
        { tenant_id: a.tenant.id },
      ]);
      expect((await client.query('SELECT tenant_id, user_id FROM auth_identities')).rows).toEqual([
        { tenant_id: a.tenant.id, user_id: a.user.id },
      ]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('signIn (Q-A2)', () => {
  /** a workspace with OIDC on; members made before (invites are blocked under SSO) */
  async function oidcWorkspace(options: { members?: number; config?: Record<string, unknown> } = {}) {
    const o = await owner();
    const members = [];
    for (let i = 0; i < (options.members ?? 0); i++) members.push(await memberOf(o));
    await ssoOn(server, o.tenant.id, 'oidc', { ...OIDC_CONFIG, ...options.config });
    return { o, members, tenant: await tenantRow(o.tenant.id) };
  }
  const signIn = (tenant: TenantRow, p: SsoProfile) =>
    server.ctx.ssoLogin.signIn(tenant, p, { ip: '10.0.0.1' }, { authMethod: p.providerType as 'oidc' });

  it('refuses a method that is not the active one, before anything is written', async () => {
    const { tenant } = await oidcWorkspace();
    const email = newEmail();
    const wrong = await failure(signIn(tenant, profile(email, { providerType: 'saml' })));
    expect(wrong).toMatchObject({ statusCode: 403, code: 'sso_method_inactive' });
    const plain = await owner();
    const off = await failure(signIn(await tenantRow(plain.tenant.id), profile(email)));
    expect(off).toMatchObject({ statusCode: 403, code: 'sso_method_inactive' });
    expect(await server.ctx.repos.users.getByEmail(email)).toBeUndefined();
    const failed = (await auditActions(tenant.id)).filter((a) => a.action === 'auth.sso_login_failed');
    expect(failed.map((a) => a.metadata)).toEqual([{ method: 'saml', reason: 'sso_method_inactive' }]);
  });

  it('finds the identity by provider id; a differing email keeps the identity and the email', async () => {
    const { tenant, members } = await oidcWorkspace({ members: 1 });
    const [m] = members;
    const p = profile(m.email);
    const first = await signIn(tenant, p);
    expect(first).toMatchObject({ role: 'member' });
    expect(first.user.id).toBe(m.user.id);
    expect(await server.ctx.repos.sso.getIdentity(tenant.id, 'oidc', p.providerId)).toMatchObject({
      userId: m.user.id,
    });
    const moved = await signIn(tenant, { ...p, email: newEmail() });
    expect(moved.user.id).toBe(m.user.id);
    expect((await server.ctx.repos.users.get(m.user.id))?.email).toBe(m.email);
    const audit = (await auditActions(tenant.id)).filter((a) => a.action === 'auth.sso_login');
    expect(audit).toHaveLength(2);
  });

  it('links a current member only with a verified email; emailVerifiedRequired refuses an absent claim', async () => {
    const { tenant, members } = await oidcWorkspace({ members: 3 });
    const [one, two, three] = members;
    const unverified = await failure(signIn(tenant, profile(one.email, { emailVerified: false })));
    expect(unverified).toMatchObject({ statusCode: 403, code: 'sso_email_unverified' });
    expect(await server.ctx.repos.sso.signInRules(one.user.id, tenant.id)).toHaveLength(1);
    // absent is fine while the setting is off
    expect((await signIn(tenant, profile(two.email, { emailVerified: undefined }))).user.id).toBe(
      two.user.id,
    );
    await ssoOn(server, tenant.id, 'oidc', { oidc: { ...OIDC_CONFIG.oidc, emailVerifiedRequired: true } });
    const absent = await failure(signIn(tenant, profile(three.email, { emailVerified: undefined })));
    expect(absent).toMatchObject({ code: 'sso_email_unverified' });
    expect((await signIn(tenant, profile(three.email))).user.id).toBe(three.user.id);
  });

  it('a pending invitation links an existing account and gives a new email an account, JIT off or not', async () => {
    const o = await owner();
    const elsewhere = await owner();
    const fresh = newEmail();
    await o.client.data(
      o.client.post('/rest/members/invite', { email: elsewhere.user.email, role: 'admin' }),
    );
    await o.client.data(o.client.post('/rest/members/invite', { email: fresh, role: 'member' }));
    await ssoOn(server, o.tenant.id, 'oidc', { ...OIDC_CONFIG, jit: false });
    const tenant = await tenantRow(o.tenant.id);
    const joined = await signIn(tenant, profile(elsewhere.user.email));
    expect(joined).toMatchObject({ role: 'admin' });
    expect(joined.user.id).toBe(elsewhere.user.id);
    expect(await server.ctx.repos.projects.getPersonal(tenant.id, elsewhere.user.id)).toBeTruthy();
    const created = await signIn(tenant, profile(fresh, { firstName: 'New', lastName: 'Person' }));
    expect(created).toMatchObject({ role: 'member' });
    expect(created.user).toMatchObject({ email: fresh, name: 'New Person' });
    expect(await server.ctx.repos.invitations.listPending(tenant.id)).toEqual([]);
  });

  it('never links an account by email alone, and JIT off refuses a new email', async () => {
    const { tenant } = await oidcWorkspace();
    const other = await owner();
    const linked = await failure(signIn(tenant, profile(other.user.email)));
    expect(linked).toMatchObject({
      statusCode: 403,
      code: 'sso_invite_required',
      message: SSO_SIGN_IN_ERRORS.sso_invite_required,
    });
    expect(await server.ctx.repos.memberships.get(tenant.id, other.user.id)).toBeUndefined();
    await ssoOn(server, tenant.id, 'oidc', { jit: false });
    const email = newEmail();
    expect(await failure(signIn(tenant, profile(email)))).toMatchObject({ code: 'sso_user_unknown' });
    expect(await server.ctx.repos.users.getByEmail(email)).toBeUndefined();
  });

  it('a block from the provisioning denies before any account', async () => {
    const { tenant } = await oidcWorkspace();
    const email = newEmail();
    const spy = vi.spyOn(server.ctx.provisioning, 'resolve').mockResolvedValueOnce({ blocked: true });
    try {
      expect(await failure(signIn(tenant, profile(email, { claims: { group: 'none' } })))).toMatchObject({
        code: 'sso_access_blocked',
      });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: tenant.id }), { group: 'none' }, null);
    } finally {
      spy.mockRestore();
    }
    expect(await server.ctx.repos.users.getByEmail(email)).toBeUndefined();
  });

  it('a JIT user has one personal project and a workflow they create lands there', async () => {
    const { tenant } = await oidcWorkspace();
    const email = newEmail();
    const result = await signIn(tenant, profile(email));
    expect(result.role).toBe('member');
    const { rows } = await server.ctx.database.pool.query(
      `select id from projects where tenant_id = $1 and type = 'personal' and owner_user_id = $2`,
      [tenant.id, result.user.id],
    );
    expect(rows).toHaveLength(1);
    const client = new TestClient(server.app);
    client.cookie = `wf_session=${result.token}`;
    const created = await client.data<{ id: string }>(
      client.post('/rest/workflows', { name: 'Mine', nodes: [], connections: {} }),
    );
    expect((await server.ctx.repos.workflows.get(tenant.id, created.id))?.projectId).toBe(rows[0].id);
  });

  it('syncs the name only while no other workspace knows the person', async () => {
    const { tenant, members } = await oidcWorkspace({ members: 1 });
    const [m] = members;
    const p = profile(m.email, { firstName: 'Ada', lastName: 'Lovelace' });
    await signIn(tenant, p);
    expect((await server.ctx.repos.users.get(m.user.id))?.name).toBe('Ada Lovelace');
    const b = await owner();
    await server.ctx.repos.memberships.add(b.tenant.id, m.user.id, 'member');
    await signIn(tenant, { ...p, firstName: 'Grace', lastName: 'Hopper' });
    expect((await server.ctx.repos.users.get(m.user.id))?.name).toBe('Ada Lovelace');
  });

  it('a disabled member cannot sign in', async () => {
    const { tenant, members } = await oidcWorkspace({ members: 1 });
    const [m] = members;
    const p = profile(m.email);
    await signIn(tenant, p);
    await server.ctx.repos.memberships.disable(tenant.id, m.user.id);
    expect(await failure(signIn(tenant, p))).toMatchObject({ code: 'sso_user_disabled' });
    expect(await failure(signIn(tenant, profile(m.email)))).toMatchObject({ code: 'sso_user_disabled' });
  });

  it('refuses a profile with no email or provider id', async () => {
    const { tenant } = await oidcWorkspace();
    expect(await failure(signIn(tenant, profile('not-an-email')))).toMatchObject({
      statusCode: 400,
      code: 'sso_profile_invalid',
    });
    expect(await failure(signIn(tenant, profile(newEmail(), { providerId: '' })))).toMatchObject({
      code: 'sso_profile_invalid',
    });
  });
});

describe('safeSsoRedirect', () => {
  const base = 'https://app.example.com';
  it.each([
    ['/workflows?x=1#y', '/workflows?x=1#y'],
    ['https://app.example.com/home', 'https://app.example.com/home'],
    ['//evil.test/x', '/'],
    ['/\\evil.test', '/'],
    ['/a\tb', '/'],
    ['https://app.example.com.evil.test/x', '/'],
    ['https://evilapp.example.com/', '/'],
    ['https://user@app.example.com/', '/'],
    ['https://app.example.com:8443/', '/'],
    ['http://app.example.com/home', '/'],
    ['javascript:alert(1)', '/'],
    ['workflows', '/'],
    ['', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%s -> %s', (value, expected) => {
    expect(safeSsoRedirect(value, base)).toBe(expected);
  });

  it('plain http passes only when the base itself is http', () => {
    expect(safeSsoRedirect('http://localhost:5678/home', 'http://localhost:5678')).toBe(
      'http://localhost:5678/home',
    );
    expect(safeSsoRedirect('https://localhost:5678/home', 'http://localhost:5678')).toBe('/');
  });
});
