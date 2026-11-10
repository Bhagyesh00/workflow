/**
 * P6-18 (L2): two-factor sign-in. RFC 6238 vectors through `totp`; setup makes a new secret and new codes on
 * each call until enabled; the secret is stored encrypted and the recovery codes hashed; a code works once
 * (`last_step`); sign-in needs a code once MFA is on; a recovery code works once; disable needs exactly one of
 * code or recovery code; a fenced session cannot set up or disable; `MFA_ENABLED` off refuses setup; the
 * `mfa:disable` command clears the row; no secret or code in any answer or log line.
 */
import { createHash } from 'node:crypto';
import { totp } from '@workflow/nodes-base';
import type { FastifyRequest } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MFA_DISABLE_USAGE, mfaDisableCommand } from '../src/commands/mfa-disable';
import type { ServerContext } from '../src/context';
import type { TenantRow } from '../src/db/schema';
import { base32Encode, hashRecoveryCode } from '../src/services/mfa';
import { assertMfaSatisfied, isMfaEnforced } from '../src/services/mfa-gate';
import {
  createTestServer,
  ORIGIN,
  realMember,
  sessionFor,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

let server: TestServer;
let off: TestServer;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  off = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000', MFA_ENABLED: 'false' }, { reset: false });
});
afterAll(async () => {
  await off.close();
  await server.close();
});

const STEP_MS = 30_000;
const codeAt = (secret: string, steps: number) =>
  totp({ secret, timestampMs: Date.now() + steps * STEP_MS }).token;

/** a 6 digit text that is no code of the secret within 12 steps either side of now */
function wrongCode(secret: string): string {
  const valid = new Set<string>();
  for (let s = -12; s <= 12; s++) valid.add(codeAt(secret, s));
  for (let n = 100000; ; n++) if (!valid.has(String(n))) return String(n);
}

interface Setup {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

let ipCounter = 0;
/** signup allows 20 calls an hour per IP: each owner comes from its own address */
const nextIp = () => `10.60.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

async function owner() {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  return { ...o, password: 'Passw0rd!' };
}

/** sets MFA up and enables it with a code from the past (so sign-ins can use steps -1 .. 2 in order) */
async function enableMfa(o: Awaited<ReturnType<typeof owner>>) {
  const setup = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
  const res = await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) });
  expect(res.statusCode).toBe(200);
  return setup;
}

function loginClient() {
  return new TestClient(server.app, ORIGIN);
}

describe('totp (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the SHA-1 vectors of Appendix B', () => {
    const at = (seconds: number, digits: number) =>
      totp({ secret, digits, timestampMs: seconds * 1000 }).token;
    expect(at(59, 8)).toBe('94287082');
    expect(at(1111111109, 8)).toBe('07081804');
    expect(at(1234567890, 8)).toBe('89005924');
    expect(at(2000000000, 8)).toBe('69279037');
    expect(at(59, 6)).toBe('287082');
  });
});

describe('setup', () => {
  it('makes a new secret and new codes on each call; the URI names the brand and the email', async () => {
    const o = await owner();
    const first = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
    const second = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
    expect(first.secret).not.toBe(second.secret);
    expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(first.recoveryCodes).toHaveLength(10);
    expect(new Set(first.recoveryCodes).size).toBe(10);
    expect(first.recoveryCodes.some((c) => second.recoveryCodes.includes(c))).toBe(false);
    const url = new URL(second.otpauthUrl);
    expect(url.protocol).toBe('otpauth:');
    expect(url.hostname).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe(`/Workflow:${o.user.email}`);
    expect(url.searchParams.get('issuer')).toBe('Workflow');
    expect(url.searchParams.get('secret')).toBe(second.secret);
  });

  it('stores the secret encrypted and the recovery codes as SHA-256 hashes; the pending row is not enabled', async () => {
    const o = await owner();
    const setup = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
    const row = await server.ctx.repos.userMfa.get(o.user.id);
    expect(row?.enabledAt).toBeNull();
    expect(row?.secretEnc).not.toContain(setup.secret);
    expect(
      server.ctx.cipher.decrypt<string>(row?.secretEnc ?? '', { tenantId: 'user', credentialId: o.user.id }),
    ).toBe(setup.secret);
    // the binding is the user: another user id does not decrypt it
    expect(() =>
      server.ctx.cipher.decrypt(row?.secretEnc ?? '', { tenantId: 'user', credentialId: o.tenant.id }),
    ).toThrow();
    expect(row?.recoveryHashes).toEqual(
      setup.recoveryCodes.map((c) => createHash('sha256').update(c).digest('hex')),
    );
    expect(JSON.stringify(row)).not.toContain(setup.recoveryCodes[0]);
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(false);
  });

  it('is refused once MFA is on, and for a session that signed in with SSO', async () => {
    const o = await owner();
    await enableMfa(o);
    const again = await o.client.get('/rest/auth/mfa/setup');
    expect(again.statusCode).toBe(400);
    const other = await owner();
    const saml = await sessionFor(server, other.tenant.id, other.user.id, { authMethod: 'saml' });
    const fenced = await saml.client.get('/rest/auth/mfa/setup');
    expect(fenced.statusCode).toBe(403);
    expect(fenced.json().error.code).toBe('sso_session_fenced');
    expect(await server.ctx.repos.userMfa.get(other.user.id)).toBeUndefined();
  });

  it('is refused when MFA_ENABLED is off, and the settings say so', async () => {
    const o = await signup(off.app, { projects: 'real', remoteAddress: nextIp() });
    const res = await o.client.get('/rest/auth/mfa/setup');
    expect(res.statusCode).toBe(400);
    const settings = await o.client.data(o.client.get('/rest/settings'));
    expect(settings.features.mfa).toBe(false);
    expect((await o.client.post('/rest/auth/mfa/enable', { mfaCode: '123456' })).statusCode).toBe(400);
  });

  it('MFA_ENABLED off still asks an enrolled user for the code, and the session is verified', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password };
    const c = new TestClient(off.app, ORIGIN, nextIp());
    const none = await c.post('/rest/auth/login', body);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('mfa_required');
    expect(c.cookie).toBeUndefined();
    const ok = await c.post('/rest/auth/login', { ...body, mfaCode: codeAt(setup.secret, -1) });
    expect(ok.statusCode).toBe(200);
    expect(await off.ctx.repos.sessions.get(await sessionIdOf(c))).toMatchObject({ mfaVerified: true });
  });

  it('MFA_ENABLED off turns an enforcing workspace into a plain one, so nobody is locked out', async () => {
    const o = await owner();
    await enableMfa(o);
    expect((await o.client.post('/rest/settings/mfa-enforce', { enforce: true })).statusCode).toBe(200);
    const m = await realMember(o);
    expect((await m.client.get('/rest/workflows')).statusCode).toBe(401);
    // the same member and the owner on the server with MFA off, on sessions that never passed the step
    for (const userId of [m.user.id, o.user.id]) {
      const s = await sessionFor(off, o.tenant.id, userId, { mfaVerified: false });
      expect((await s.client.get('/rest/workflows')).statusCode).toBe(200);
    }
    const admin = await sessionFor(off, o.tenant.id, o.user.id, { mfaVerified: false });
    expect((await admin.client.post('/rest/settings/mfa-enforce', { enforce: false })).statusCode).toBe(200);
  });

  it('the gate reads the server switch: off, an enforcing workspace lets an unverified session through', async () => {
    const tenant = { settings: { mfa: { enforced: true } } } as unknown as TenantRow;
    const request = { url: '/rest/workflows', method: 'GET' } as FastifyRequest;
    const session = {
      id: 's',
      userId: 'u',
      tenantId: 't',
      authMethod: 'password' as const,
      mfaVerified: false,
    };
    expect(isMfaEnforced(tenant)).toBe(true);
    expect(isMfaEnforced(tenant, false)).toBe(false);
    await expect(assertMfaSatisfied(request, tenant, session, true)).rejects.toMatchObject({
      code: 'mfa_enrollment_required',
    });
    await expect(assertMfaSatisfied(request, tenant, session, false)).resolves.toBeUndefined();
  });

  it('needs a session', async () => {
    const res = await loginClient().get('/rest/auth/mfa/setup');
    expect(res.statusCode).toBe(401);
  });
});

describe('enable', () => {
  it('a wrong code and a missing setup answer the expired text; a right code turns MFA on and verifies the session', async () => {
    const o = await owner();
    const none = await o.client.post('/rest/auth/mfa/enable', { mfaCode: '123456' });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toBe('MFA code expired. Close the modal and enable MFA again');
    const setup = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
    const bad = await o.client.post('/rest/auth/mfa/enable', { mfaCode: wrongCode(setup.secret) });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('MFA code expired. Close the modal and enable MFA again');
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(false);
    const bodyCheck = await o.client.post('/rest/auth/mfa/enable', { mfaCode: 'abc' });
    expect(bodyCheck.statusCode).toBe(400);
    const ok = await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, 0) });
    expect(ok.statusCode).toBe(200);
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(true);
    const me = await o.client.data(o.client.get('/rest/auth/me'));
    expect(me.mfaEnabled).toBe(true);
    const session = await server.ctx.repos.sessions.get((await sessionIdOf(o.client)) as string);
    expect(session?.mfaVerified).toBe(true);
  });

  it('window 10: a code ten steps old is taken, eleven is not', async () => {
    const o = await owner();
    const setup = await o.client.data<Setup>(o.client.get('/rest/auth/mfa/setup'));
    const old = await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -12) });
    expect(old.statusCode).toBe(400);
    const ok = await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -9) });
    expect(ok.statusCode).toBe(200);
  });

  it('writes the audit line auth.mfa_enabled without a code', async () => {
    const o = await owner();
    await enableMfa(o);
    const rows = await server.ctx.repos.audit.list(o.tenant.id, 50);
    const actions = JSON.stringify(rows);
    expect(actions).toContain('auth.mfa_enabled');
  });
});

async function sessionIdOf(client: TestClient): Promise<string> {
  const token = client.cookie?.replace('wf_session=', '') ?? '';
  return createHash('sha256').update(token).digest('hex');
}

describe('sign-in', () => {
  it('needs a code once MFA is on: none is 401 mfa_required, a wrong one 401 invalid_mfa, a right one signs in', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password };
    const c1 = loginClient();
    const none = await c1.post('/rest/auth/login', body);
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('mfa_required');
    expect(c1.cookie).toBeUndefined();
    const wrong = await c1.post('/rest/auth/login', { ...body, mfaCode: wrongCode(setup.secret) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toMatchObject({
      code: 'invalid_mfa',
      message: 'Invalid mfa token or recovery code',
    });
    expect(c1.cookie).toBeUndefined();
    // a wrong password stays the plain answer, before any code is asked
    const badPassword = await c1.post('/rest/auth/login', { ...body, password: 'nope-nope-1' });
    expect(badPassword.json().error.code).toBe('invalid_credentials');
    const ok = await c1.post('/rest/auth/login', { ...body, mfaCode: codeAt(setup.secret, -1) });
    expect(ok.statusCode).toBe(200);
    const session = await server.ctx.repos.sessions.get(await sessionIdOf(c1));
    expect(session).toMatchObject({ authMethod: 'password', mfaVerified: true });
    const me = await c1.data(c1.get('/rest/auth/me'));
    expect(me.mfaEnabled).toBe(true);
  });

  it('a user without MFA signs in as before and the session is not verified', async () => {
    const o = await owner();
    const c = loginClient();
    const res = await c.post('/rest/auth/login', { email: o.user.email, password: o.password });
    expect(res.statusCode).toBe(200);
    const session = await server.ctx.repos.sessions.get(await sessionIdOf(c));
    expect(session?.mfaVerified).toBe(false);
  });

  it('refuses a replayed code, and an older one than the last used', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password };
    const code = codeAt(setup.secret, 1);
    expect((await loginClient().post('/rest/auth/login', { ...body, mfaCode: code })).statusCode).toBe(200);
    const replay = await loginClient().post('/rest/auth/login', { ...body, mfaCode: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_mfa');
    const older = await loginClient().post('/rest/auth/login', { ...body, mfaCode: codeAt(setup.secret, 0) });
    expect(older.statusCode).toBe(401);
    const newer = await loginClient().post('/rest/auth/login', { ...body, mfaCode: codeAt(setup.secret, 2) });
    expect(newer.statusCode).toBe(200);
  });

  it('two sign-ins with the same code at once: exactly one wins', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password, mfaCode: codeAt(setup.secret, 1) };
    const results = await Promise.all([1, 2, 3, 4].map(() => loginClient().post('/rest/auth/login', body)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(3);
  });

  it('a recovery code works once and is removed from the row', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password };
    const [first, second] = setup.recoveryCodes;
    expect(
      (await loginClient().post('/rest/auth/login', { ...body, mfaRecoveryCode: first })).statusCode,
    ).toBe(200);
    const row = await server.ctx.repos.userMfa.get(o.user.id);
    expect(row?.recoveryHashes).toHaveLength(9);
    expect(row?.recoveryHashes).not.toContain(hashRecoveryCode(first));
    const again = await loginClient().post('/rest/auth/login', { ...body, mfaRecoveryCode: first });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.message).toBe('Invalid mfa token or recovery code');
    // the other codes still work, with case and spaces ignored
    const other = await loginClient().post('/rest/auth/login', {
      ...body,
      mfaRecoveryCode: ` ${second.toUpperCase()} `,
    });
    expect(other.statusCode).toBe(200);
    const bogus = await loginClient().post('/rest/auth/login', { ...body, mfaRecoveryCode: 'not-a-code' });
    expect(bogus.statusCode).toBe(401);
  });

  it('a recovery code used twice at once: exactly one wins', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const body = { email: o.user.email, password: o.password, mfaRecoveryCode: setup.recoveryCodes[3] };
    const results = await Promise.all([1, 2, 3].map(() => loginClient().post('/rest/auth/login', body)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('a user in a workspace that does not enforce MFA still signs in with a code once MFA is on (global secret)', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const c = loginClient();
    const res = await c.post('/rest/auth/login', {
      email: o.user.email,
      password: o.password,
      mfaCode: codeAt(setup.secret, 0),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('verify and checkCode', () => {
  it('verify takes a code once and marks the session verified', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const code = codeAt(setup.secret, 1);
    expect((await o.client.post('/rest/auth/mfa/verify', { mfaCode: code })).statusCode).toBe(200);
    const replay = await o.client.post('/rest/auth/mfa/verify', { mfaCode: code });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_mfa');
    expect((await o.client.post('/rest/auth/mfa/verify', { mfaCode: 'x' })).statusCode).toBe(400);
  });

  it('verify is refused for a user without MFA', async () => {
    const o = await owner();
    const res = await o.client.post('/rest/auth/mfa/verify', { mfaCode: '123456' });
    expect(res.statusCode).toBe(401);
  });

  it('checkCode takes a code or a recovery code, once each, and false without MFA', async () => {
    const o = await owner();
    const user = (await server.ctx.repos.users.get(o.user.id))!;
    expect(await server.ctx.mfa.checkCode(user, '123456')).toBe(false);
    const setup = await enableMfa(o);
    const code = codeAt(setup.secret, 1);
    expect(await server.ctx.mfa.checkCode(user, code)).toBe(true);
    expect(await server.ctx.mfa.checkCode(user, code)).toBe(false);
    expect(await server.ctx.mfa.checkCode(user, setup.recoveryCodes[0])).toBe(true);
    expect(await server.ctx.mfa.checkCode(user, setup.recoveryCodes[0])).toBe(false);
    expect(await server.ctx.mfa.checkCode(user, wrongCode(setup.secret))).toBe(false);
  });
});

describe('disable', () => {
  it('needs exactly one of code or recovery code, and a right one', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const neither = await o.client.post('/rest/auth/mfa/disable', {});
    expect(neither.statusCode).toBe(400);
    const both = await o.client.post('/rest/auth/mfa/disable', {
      mfaCode: codeAt(setup.secret, 1),
      mfaRecoveryCode: setup.recoveryCodes[0],
    });
    expect(both.statusCode).toBe(400);
    const wrong = await o.client.post('/rest/auth/mfa/disable', { mfaCode: wrongCode(setup.secret) });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_mfa');
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(true);
    const ok = await o.client.post('/rest/auth/mfa/disable', { mfaCode: codeAt(setup.secret, 1) });
    expect(ok.statusCode).toBe(200);
    expect(await server.ctx.repos.userMfa.get(o.user.id)).toBeUndefined();
    // sign-in is a plain password sign-in again
    const c = loginClient();
    expect((await c.post('/rest/auth/login', { email: o.user.email, password: o.password })).statusCode).toBe(
      200,
    );
    const rows = JSON.stringify(await server.ctx.repos.audit.list(o.tenant.id, 50));
    expect(rows).toContain('auth.mfa_disabled');
  });

  it('a recovery code turns MFA off', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const ok = await o.client.post('/rest/auth/mfa/disable', { mfaRecoveryCode: setup.recoveryCodes[9] });
    expect(ok.statusCode).toBe(200);
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(false);
  });

  it('a user without MFA gets 400', async () => {
    const o = await owner();
    const res = await o.client.post('/rest/auth/mfa/disable', { mfaCode: '123456' });
    expect(res.statusCode).toBe(400);
  });

  it('a fenced session (SAML, OIDC, LDAP) cannot disable; the row stays', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    for (const authMethod of ['saml', 'oidc', 'ldap'] as const) {
      const s = await sessionFor(server, o.tenant.id, o.user.id, { authMethod, mfaVerified: true });
      const res = await s.client.post('/rest/auth/mfa/disable', { mfaRecoveryCode: setup.recoveryCodes[0] });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('sso_session_fenced');
      const en = await s.client.post('/rest/auth/mfa/enable', { mfaCode: '123456' });
      expect(en.statusCode).toBe(403);
    }
    expect(await server.ctx.repos.userMfa.isEnabled(o.user.id)).toBe(true);
    expect((await server.ctx.repos.userMfa.get(o.user.id))?.recoveryHashes).toHaveLength(10);
  });
});

describe('mfa:disable command', () => {
  it('clears the row of the address and says so; an unknown address changes nothing', async () => {
    const o = await owner();
    await enableMfa(o);
    const lines: string[] = [];
    const logger = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
    const ctx = { mfa: server.ctx.mfa, logger } as unknown as ServerContext;
    const before = await sessionFor(server, o.tenant.id, o.user.id, { mfaVerified: true });
    await mfaDisableCommand(ctx, ['--email', o.user.email.toUpperCase()]);
    expect(await server.ctx.repos.userMfa.get(o.user.id)).toBeUndefined();
    // the user's verified password sessions are verified no more
    expect((await server.ctx.repos.sessions.get(before.sessionId))?.mfaVerified).toBe(false);
    await mfaDisableCommand(ctx, [`--email=nobody-${o.user.id}@example.com`]);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(o.user.email);
    expect(lines.join('\n')).not.toContain(o.user.id);
  });

  it('needs --email', async () => {
    const ctx = { mfa: server.ctx.mfa, logger: pino({ level: 'silent' }) } as unknown as ServerContext;
    await expect(mfaDisableCommand(ctx, [])).rejects.toThrow(MFA_DISABLE_USAGE);
    await expect(mfaDisableCommand(ctx, ['--email'])).rejects.toThrow(MFA_DISABLE_USAGE);
  });
});

describe('secrets stay out', () => {
  it('no answer holds the secret, a recovery code or a hash after setup', async () => {
    const o = await owner();
    const setup = await enableMfa(o);
    const seen: string[] = [];
    const c = loginClient();
    seen.push((await c.post('/rest/auth/login', { email: o.user.email, password: o.password })).body);
    seen.push(
      (
        await c.post('/rest/auth/login', {
          email: o.user.email,
          password: o.password,
          mfaCode: wrongCode(setup.secret),
        })
      ).body,
    );
    seen.push((await o.client.get('/rest/auth/me')).body);
    seen.push((await o.client.get('/rest/settings')).body);
    seen.push((await o.client.get('/rest/auth/mfa/setup')).body);
    const joined = seen.join('\n');
    expect(joined).not.toContain(setup.secret);
    for (const code of setup.recoveryCodes) expect(joined).not.toContain(code);
    const row = await server.ctx.repos.userMfa.get(o.user.id);
    for (const hash of row?.recoveryHashes ?? []) expect(joined).not.toContain(hash);
  });
});
