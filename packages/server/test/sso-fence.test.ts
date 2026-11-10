/**
 * P6-01 (L6): the session fence. A session that signed in with SAML, OIDC or LDAP stays in its workspace:
 * the switch, the MCP consent (details and approve) and the form code refuse another workspace with 403
 * `sso_session_fenced`. A password session enters a SAML or OIDC workspace only as owner or with the manual
 * login flag (403 `sso_required`). A session that `signIn` makes is stored with its method; a SAML or OIDC
 * one with `mfa_verified = true`, an LDAP one only when the MFA step passed (the MFA gate itself is L2's
 * test). A session that did not pass the MFA step cannot enter a workspace that enforces MFA (switch,
 * consent, form code: 401 `mfa_enrollment_required`), and an invitation accepted by an account with MFA on
 * needs its code.
 */
import { randomUUID } from 'node:crypto';
import { totp } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/services/auth';
import { MCP_OAUTH_FLOW_KIND } from '../src/services/mcp/oauth/authorize';
import {
  createTestServer,
  flushRedis,
  ORIGIN,
  realMember,
  sessionFor,
  signup,
  ssoOn,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
let address = 0;
const nextAddress = () => {
  address++;
  return `10.62.${Math.floor(address / 250)}.${(address % 250) + 1}`;
};

const SAML_CONFIG = { samlMetadata: '<EntityDescriptor/>' };
const OIDC_CONFIG = {
  oidc: { clientId: 'client-1', discoveryEndpoint: 'https://idp.test/.well-known/openid-configuration' },
};
const LDAP_CONFIG = {
  ldap: {
    connectionUrl: 'ldap.test',
    baseDn: 'dc=example,dc=test',
    emailAttribute: 'mail',
    loginIdAttribute: 'uid',
    ldapIdAttribute: 'entryUUID',
  },
};

beforeAll(async () => {
  await flushRedis();
  server = await createTestServer();
});

afterAll(async () => {
  await server?.close();
});

const owner = () => signup(server.app, { remoteAddress: nextAddress() });

/** a member of `a` (by invitation) who is also a member of `b` */
async function twoWorkspaces() {
  const a = await owner();
  const b = await owner();
  const m = await realMember(a, { remoteAddress: nextAddress() });
  await server.ctx.repos.memberships.add(b.tenant.id, m.user.id, 'member');
  return { a, b, m };
}

async function failure(promise: Promise<unknown>): Promise<{ statusCode?: number; code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; code?: string };
  }
  throw new Error('expected a refusal');
}

/** an MCP consent flow token of `tenantId` (its client is unknown, so a call past the fence answers 400) */
function flowOf(tenantId: string): string {
  return server.ctx.formTokens.sign(
    {
      kind: MCP_OAUTH_FLOW_KIND,
      tenantId,
      clientId: randomUUID(),
      redirectIndex: 0,
      codeChallenge: 'a'.repeat(43),
      resource: 'https://example.test/mcp',
      scopes: ['workflow:read'],
    },
    300,
  );
}

describe('the fence', () => {
  it('a SAML session cannot switch to another workspace; a password session can', async () => {
    const { a, b, m } = await twoWorkspaces();
    await ssoOn(server, a.tenant.id, 'saml', SAML_CONFIG);
    const saml = await sessionFor(server, a.tenant.id, m.user.id, { authMethod: 'saml', mfaVerified: true });
    const fenced = await saml.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id });
    expect(fenced.statusCode).toBe(403);
    expect(fenced.json().error).toMatchObject({ code: 'sso_session_fenced' });
    // its own workspace is no switch at all
    expect((await saml.client.post('/rest/auth/switch-tenant', { tenantId: a.tenant.id })).statusCode).toBe(
      200,
    );
    const password = await sessionFor(server, b.tenant.id, m.user.id);
    // into the SSO workspace a password session needs the flag
    const refused = await password.client.post('/rest/auth/switch-tenant', { tenantId: a.tenant.id });
    expect(refused.json().error).toMatchObject({ code: 'sso_required' });
    const back = await sessionFor(server, a.tenant.id, m.user.id);
    expect((await back.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id })).statusCode).toBe(
      200,
    );
    // an OIDC or LDAP session is fenced the same way
    for (const authMethod of ['oidc', 'ldap'] as const) {
      const other = await sessionFor(server, a.tenant.id, m.user.id, { authMethod });
      const res = await other.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id });
      expect(res.json().error).toMatchObject({ code: 'sso_session_fenced' });
    }
  });

  it('fences the MCP consent of another workspace (details and approve)', async () => {
    const { a, b, m } = await twoWorkspaces();
    const flow = flowOf(b.tenant.id);
    const saml = await sessionFor(server, a.tenant.id, m.user.id, { authMethod: 'saml' });
    const details = await saml.client.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`);
    expect(details.statusCode).toBe(403);
    expect(details.json().error).toMatchObject({ code: 'sso_session_fenced' });
    const approve = await saml.client.post('/rest/consent/approve', { flow, approved: true });
    expect(approve.json().error).toMatchObject({ code: 'sso_session_fenced' });
    // a password session passes the fence (and then meets the unknown client)
    const password = await sessionFor(server, a.tenant.id, m.user.id);
    expect(
      (await password.client.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`)).statusCode,
    ).toBe(400);
    // into a SAML workspace a password session of a member needs the flag; the owner passes
    await ssoOn(server, b.tenant.id, 'saml', SAML_CONFIG);
    const refused = await password.client.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ code: 'sso_required' });
    await server.ctx.repos.memberships.add(a.tenant.id, b.user.id, 'member');
    const ownerOfB = await sessionFor(server, a.tenant.id, b.user.id);
    expect(
      (await ownerOfB.client.get(`/rest/consent/details?flow=${encodeURIComponent(flow)}`)).statusCode,
    ).toBe(400);
  });

  it('fences the form code of another workspace', async () => {
    const { a, b, m } = await twoWorkspaces();
    const returnTo = `/form/${b.tenant.slug}/${randomUUID()}`;
    const oidc = await sessionFor(server, a.tenant.id, m.user.id, { authMethod: 'oidc' });
    expect(await failure(server.ctx.formAuth.issueCode(oidc.auth, returnTo))).toMatchObject({
      statusCode: 403,
      code: 'sso_session_fenced',
    });
    const res = await oidc.client.post('/rest/form-auth/code', { returnTo });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'sso_session_fenced' });
    // the session's own workspace still gets a code
    const own = await oidc.client.post('/rest/form-auth/code', { returnTo: `/form/${a.tenant.slug}/x` });
    expect(own.statusCode).toBe(200);
    // a password session gets one for the other workspace, until that workspace turns OIDC on
    const password = await sessionFor(server, a.tenant.id, m.user.id);
    expect(typeof (await server.ctx.formAuth.issueCode(password.auth, returnTo))).toBe('string');
    await ssoOn(server, b.tenant.id, 'oidc', OIDC_CONFIG);
    expect(await failure(server.ctx.formAuth.issueCode(password.auth, returnTo))).toMatchObject({
      code: 'sso_required',
    });
    await server.ctx.repos.memberships.setAllowSsoManualLogin(b.tenant.id, m.user.id, true);
    expect(typeof (await server.ctx.formAuth.issueCode(password.auth, returnTo))).toBe('string');
  });

  it('a session entering a workspace it is not a member of is the 404 of an unknown workspace', async () => {
    const { a, m } = await twoWorkspaces();
    const stranger = await owner();
    const password = await sessionFor(server, a.tenant.id, m.user.id);
    expect(
      await failure(server.ctx.ssoLogin.assertSessionEntry(password.auth, stranger.tenant.id)),
    ).toMatchObject({
      statusCode: 404,
    });
  });
});

describe('sessions that signIn makes', () => {
  it('a SAML and an OIDC sign-in store the method and mfa_verified = true', async () => {
    for (const method of ['saml', 'oidc'] as const) {
      const o = await owner();
      await ssoOn(server, o.tenant.id, method, method === 'saml' ? SAML_CONFIG : OIDC_CONFIG);
      const tenant = (await server.ctx.repos.tenants.get(o.tenant.id))!;
      const result = await server.ctx.ssoLogin.signIn(
        tenant,
        {
          providerType: method,
          providerId: `id-${randomUUID()}`,
          email: `${method}-${randomUUID().slice(0, 8)}@example.com`,
          claims: {},
        },
        { ip: '10.0.0.2', userAgent: 'vitest' },
        { authMethod: method },
      );
      const row = await server.ctx.repos.sessions.get(sha256(result.token));
      expect(row).toMatchObject({
        tenantId: o.tenant.id,
        userId: result.user.id,
        authMethod: method,
        mfaVerified: true,
      });
      const client = new TestClient(server.app);
      client.cookie = `wf_session=${result.token}`;
      const me = await client.data(client.get('/rest/auth/me'));
      expect(me).toMatchObject({ authMethod: method, ssoFenced: true });
    }
  });
});

describe('MFA at the doors', () => {
  const codeAt = (secret: string, steps: number) =>
    totp({ secret, timestampMs: Date.now() + steps * 30_000 }).token;

  it('a session that did not pass the MFA step cannot enter a workspace that enforces MFA', async () => {
    const { a, b, m } = await twoWorkspaces();
    await server.ctx.repos.tenants.update(b.tenant.id, { settings: { mfa: { enforced: true } } });
    const flow = encodeURIComponent(flowOf(b.tenant.id));
    const returnTo = `/form/${b.tenant.slug}/${randomUUID()}`;
    const unverified = await sessionFor(server, a.tenant.id, m.user.id);
    const refused = { code: 'mfa_enrollment_required' };
    const switched = await unverified.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id });
    expect(switched.statusCode).toBe(401);
    expect(switched.json().error).toMatchObject(refused);
    const details = await unverified.client.get(`/rest/consent/details?flow=${flow}`);
    expect(details.statusCode).toBe(401);
    expect(details.json().error).toMatchObject(refused);
    const approve = await unverified.client.post('/rest/consent/approve', {
      flow: decodeURIComponent(flow),
      approved: true,
    });
    expect(approve.json().error).toMatchObject(refused);
    expect(await failure(server.ctx.formAuth.issueCode(unverified.auth, returnTo))).toMatchObject({
      statusCode: 401,
      ...refused,
    });
    const code = await unverified.client.post('/rest/form-auth/code', { returnTo });
    expect(code.statusCode).toBe(401);
    expect(code.json().error).toMatchObject(refused);
    // the session stays in its own workspace, which does not enforce MFA
    expect((await unverified.client.get('/rest/workflows')).statusCode).toBe(200);
    // a session that passed the step enters (and then meets the unknown MCP client)
    const verified = await sessionFor(server, a.tenant.id, m.user.id, { mfaVerified: true });
    expect(typeof (await server.ctx.formAuth.issueCode(verified.auth, returnTo))).toBe('string');
    expect((await verified.client.get(`/rest/consent/details?flow=${flow}`)).statusCode).toBe(400);
    expect(
      (await verified.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id })).statusCode,
    ).toBe(200);
  });

  it('with MFA_ENABLED off, a session that did not pass the MFA step enters a workspace that enforces MFA', async () => {
    const { a, b, m } = await twoWorkspaces();
    await server.ctx.repos.tenants.update(b.tenant.id, { settings: { mfa: { enforced: true } } });
    const off = await createTestServer({ MFA_ENABLED: 'false' }, { reset: false, startMain: false });
    try {
      const unverified = await sessionFor(off, a.tenant.id, m.user.id);
      const switched = await unverified.client.post('/rest/auth/switch-tenant', { tenantId: b.tenant.id });
      expect(switched.statusCode).toBe(200);
      expect((await unverified.client.get('/rest/workflows')).statusCode).toBe(200);
    } finally {
      await off.close();
    }
  });

  it('accepting an invitation with an account that has MFA on needs its code; the invitation waits', async () => {
    const victim = await owner();
    const setup = await victim.client.data<{ secret: string }>(victim.client.get('/rest/auth/mfa/setup'));
    const enabled = await victim.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) });
    expect(enabled.statusCode).toBe(200);
    const other = await owner();
    const invite = await other.client.data<{ token: string }>(
      other.client.post('/rest/members/invite', { email: victim.user.email, role: 'member' }),
    );
    const anonymous = new TestClient(server.app, ORIGIN, nextAddress());
    const accept = { name: 'Victim', password: 'Passw0rd!' };
    const none = await anonymous.post(`/rest/invitations/${invite.token}/accept`, accept);
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toMatchObject({ code: 'mfa_required' });
    expect(anonymous.cookie).toBeUndefined();
    expect(await server.ctx.repos.memberships.get(other.tenant.id, victim.user.id)).toBeFalsy();
    const wrong = server.ctx.auth.acceptInvitation(invite.token, { ...accept, mfaCode: '000000' }, {});
    expect(await failure(wrong)).toMatchObject({ statusCode: 401 });
    expect(await server.ctx.repos.memberships.get(other.tenant.id, victim.user.id)).toBeFalsy();
    // the accept route takes the code (the accept page sends it)
    const ok = await anonymous.post(`/rest/invitations/${invite.token}/accept`, {
      ...accept,
      mfaCode: codeAt(setup.secret, 1),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.tenant.id).toBe(other.tenant.id);
    const token = anonymous.cookie!.split('=')[1];
    expect(await server.ctx.repos.sessions.get(sha256(token))).toMatchObject({
      tenantId: other.tenant.id,
      userId: victim.user.id,
      authMethod: 'password',
      mfaVerified: true,
    });
  });
});

describe('an LDAP session', () => {
  it('is MFA-verified only when the MFA step passed', async () => {
    const o = await owner();
    await ssoOn(server, o.tenant.id, 'ldap', LDAP_CONFIG);
    const tenant = (await server.ctx.repos.tenants.get(o.tenant.id))!;
    const cases = [
      [{ authMethod: 'ldap' }, false],
      [{ authMethod: 'ldap', mfaVerified: false }, false],
      [{ authMethod: 'ldap', mfaVerified: true }, true],
    ] as const;
    for (const [options, mfaVerified] of cases) {
      const result = await server.ctx.ssoLogin.signIn(
        tenant,
        {
          providerType: 'ldap',
          providerId: `id-${randomUUID()}`,
          email: `ldap-${randomUUID().slice(0, 8)}@example.com`,
          claims: {},
        },
        { ip: '10.0.0.3', userAgent: 'vitest' },
        options,
      );
      expect(await server.ctx.repos.sessions.get(sha256(result.token))).toMatchObject({
        authMethod: 'ldap',
        mfaVerified,
      });
    }
  });
});
