/**
 * P6-18 (L2): a workspace that enforces two-factor sign-in (`tenants.settings.mfa.enforced`). The admin must
 * have MFA on first; then a session that did not pass the MFA step answers 401 `mfa_enrollment_required` on
 * every route but `/rest/auth/*` and GET `/rest/settings`; the enforcer is not locked out; a user in two
 * workspaces is blocked only in the enforcing one; an SSO session (`mfa_verified`) passes; the owner's
 * password sign-in into an SSO workspace with MFA on needs the code.
 */
import { totp } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestServer,
  ORIGIN,
  realMember,
  sessionFor,
  signup,
  ssoOn,
  TestClient,
  type TestMember,
  type TestServer,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});

const STEP_MS = 30_000;
const codeAt = (secret: string, steps: number) =>
  totp({ secret, timestampMs: Date.now() + steps * STEP_MS }).token;

let ipCounter = 0;
const nextIp = () => `10.61.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function owner() {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  return { ...o, password: 'Passw0rd!' };
}

/** sets MFA up on `client` and enables it with a code from the past; later sign-ins use steps -1 .. 2 */
async function enableMfa(client: TestClient) {
  const setup = await client.data<{ secret: string; recoveryCodes: string[] }>(
    client.get('/rest/auth/mfa/setup'),
  );
  const res = await client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) });
  expect(res.statusCode).toBe(200);
  return setup;
}

async function enforce(client: TestClient, value = true) {
  return client.post('/rest/settings/mfa-enforce', { enforce: value });
}

/** an owner with MFA on and the workspace enforcing it, plus a member with no MFA */
async function enforcedWorkspace() {
  const o = await owner();
  const setup = await enableMfa(o.client);
  expect((await enforce(o.client)).statusCode).toBe(200);
  const member = await realMember(o);
  return { o, setup, member };
}

const NOT_ENROLLED = { code: 'mfa_enrollment_required' };

describe('POST /settings/mfa-enforce', () => {
  it('is refused until the admin has MFA on; then it turns on and off', async () => {
    const o = await owner();
    const refused = await enforce(o.client);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain('workspace');
    expect(refused.json().error.message).not.toMatch(/instance/i);
    expect((await o.client.data(o.client.get('/rest/settings'))).mfa).toEqual({ enforced: false });
    await enableMfa(o.client);
    expect(await o.client.data(enforce(o.client))).toEqual({ enforced: true });
    expect((await o.client.data(o.client.get('/rest/settings'))).mfa).toEqual({ enforced: true });
    expect(await o.client.data(enforce(o.client, false))).toEqual({ enforced: false });
    expect((await o.client.data(o.client.get('/rest/settings'))).mfa).toEqual({ enforced: false });
  });

  it('keeps the other settings, and a settings patch cannot write it', async () => {
    const o = await owner();
    await enableMfa(o.client);
    await o.client.data(o.client.patch('/rest/settings', { timezone: 'Europe/Paris' }));
    await enforce(o.client);
    const settings = await o.client.data(o.client.get('/rest/settings'));
    expect(settings.timezone).toBe('Europe/Paris');
    expect(settings.mfa.enforced).toBe(true);
    await o.client.patch('/rest/settings', { mfa: { enforced: false } });
    expect((await o.client.data(o.client.get('/rest/settings'))).mfa.enforced).toBe(true);
  });

  it('needs the user:enforceMfa scope: a member gets 403, an unauthenticated call 401', async () => {
    const o = await owner();
    await enableMfa(o.client);
    const member = await realMember(o);
    const res = await enforce(member.client);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe('User is missing a scope required to perform this action');
    expect((await enforce(new TestClient(server.app, ORIGIN))).statusCode).toBe(401);
  });

  it('a body without a boolean is 400', async () => {
    const o = await owner();
    await enableMfa(o.client);
    expect((await o.client.post('/rest/settings/mfa-enforce', { enforce: 'yes' })).statusCode).toBe(400);
  });
});

describe('the gate', () => {
  it('blocks a session without MFA until set up, except /rest/auth/* and GET /rest/settings', async () => {
    const { member } = await enforcedWorkspace();
    const blocked = await member.client.get('/rest/workflows');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toMatchObject(NOT_ENROLLED);
    expect((await member.client.get('/rest/projects')).statusCode).toBe(401);
    expect((await member.client.post('/rest/workflows', { name: 'x' })).statusCode).toBe(401);
    // the person can still set MFA up
    expect((await member.client.get('/rest/auth/me')).statusCode).toBe(200);
    expect((await member.client.get('/rest/settings')).statusCode).toBe(200);
    expect((await member.client.get('/rest/auth/mfa/setup')).statusCode).toBe(200);
    // the enforce switch itself is behind the gate
    expect((await enforce(member.client, false)).statusCode).toBe(401);
    expect((await member.client.patch('/rest/settings', { timezone: 'UTC' })).statusCode).toBe(401);
  });

  it('the member sets MFA up and the same session loads', async () => {
    const { member } = await enforcedWorkspace();
    expect((await member.client.get('/rest/workflows')).statusCode).toBe(401);
    await enableMfa(member.client);
    expect((await member.client.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('the enforcer is not locked out: their session loads, and so does a new sign-in with a code', async () => {
    const { o, setup } = await enforcedWorkspace();
    expect((await o.client.get('/rest/workflows')).statusCode).toBe(200);
    const c = new TestClient(server.app, ORIGIN);
    const nope = await c.post('/rest/auth/login', { email: o.user.email, password: o.password });
    expect(nope.json().error.code).toBe('mfa_required');
    const ok = await c.post('/rest/auth/login', {
      email: o.user.email,
      password: o.password,
      mfaCode: codeAt(setup.secret, 1),
    });
    expect(ok.statusCode).toBe(200);
    expect((await c.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('a session of an enrolled user that began before the enforcement is let in by POST /auth/mfa/verify', async () => {
    const o = await owner();
    const m: TestMember = await realMember(o);
    const setup = await enableMfa(m.client);
    // a second, unverified session of the same member
    const later = await sessionFor(server, o.tenant.id, m.user.id);
    expect((await later.client.get('/rest/workflows')).statusCode).toBe(200);
    // the owner enforces (the owner needs MFA first)
    await enableMfa(o.client);
    expect((await enforce(o.client)).statusCode).toBe(200);
    const blocked = await later.client.get('/rest/workflows');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toMatchObject(NOT_ENROLLED);
    const bad = await later.client.post('/rest/auth/mfa/verify', { mfaCode: '000000' });
    expect(bad.statusCode).toBe(401);
    expect((await later.client.get('/rest/workflows')).statusCode).toBe(401);
    const ok = await later.client.post('/rest/auth/mfa/verify', { mfaCode: codeAt(setup.secret, 1) });
    expect(ok.statusCode).toBe(200);
    expect((await later.client.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('turning it off lets the blocked member in again', async () => {
    const { o, member } = await enforcedWorkspace();
    expect((await member.client.get('/rest/workflows')).statusCode).toBe(401);
    expect((await enforce(o.client, false)).statusCode).toBe(200);
    expect((await member.client.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('a user in two workspaces is blocked only in the enforcing one', async () => {
    const { member } = await enforcedWorkspace();
    const other = await owner();
    await server.ctx.repos.memberships.add(other.tenant.id, member.user.id, 'member');
    const inOther = await sessionFor(server, other.tenant.id, member.user.id);
    const inEnforcing = await sessionFor(server, member.tenant.id, member.user.id);
    expect((await inOther.client.get('/rest/workflows')).statusCode).toBe(200);
    const blocked = await inEnforcing.client.get('/rest/workflows');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toMatchObject(NOT_ENROLLED);
  });

  it('a workspace that does not enforce is not affected by another that does', async () => {
    await enforcedWorkspace();
    const free = await owner();
    expect((await free.client.get('/rest/workflows')).statusCode).toBe(200);
  });

  it('an SSO session (mfa_verified) loads in the enforcing workspace', async () => {
    const { o } = await enforcedWorkspace();
    for (const authMethod of ['saml', 'oidc'] as const) {
      const s = await sessionFor(server, o.tenant.id, o.user.id, { authMethod, mfaVerified: true });
      const res = await s.client.get('/rest/workflows');
      expect(res.statusCode).toBe(200);
    }
    // the same user on a password session that never passed the step is blocked
    const password = await sessionFor(server, o.tenant.id, o.user.id, { mfaVerified: false });
    expect((await password.client.get('/rest/workflows')).statusCode).toBe(401);
  });

  it('an API key is not a session: the gate does not apply to it', async () => {
    const { o } = await enforcedWorkspace();
    const key = await server.ctx.auth.createApiKey(o.tenant.id, o.user.id, 'k', []);
    const res = await server.app.inject({ url: '/api/v1/workflows', headers: { 'x-api-key': key.key } });
    expect(res.statusCode).toBe(200);
  });
});

describe('the owner into an SSO workspace', () => {
  it('password sign-in with MFA on needs the code, then signs in verified', async () => {
    const o = await owner();
    const setup = await enableMfa(o.client);
    await ssoOn(server, o.tenant.id, 'saml');
    const c = new TestClient(server.app, ORIGIN);
    const body = { email: o.user.email, password: o.password };
    const none = await c.post('/rest/auth/login', body);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('mfa_required');
    expect(c.cookie).toBeUndefined();
    const ok = await c.post('/rest/auth/login', { ...body, mfaCode: codeAt(setup.secret, 1) });
    expect(ok.statusCode).toBe(200);
    const me = await c.data(c.get('/rest/auth/me'));
    expect(me.mfaEnabled).toBe(true);
  });
});
