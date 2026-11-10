/**
 * P6-19 (L3): forgot and reset password, change password, profile and the admin's reset link. Tokens are
 * hashed, last 20 minutes and work once; forgot password answers the same for an unknown email (status,
 * body and timing) and mails only a real user, after the reply; limits are 3 a minute per email and 20 in 5
 * minutes per IP; a reset ends every session; an SSO session cannot change the account; an SSO-only user
 * is refused and a user with SSO in one workspace and a password in another is not; an admin copies a
 * link, and an owner's or that of an account in another workspace is refused; no log line holds a token.
 * Mail goes to the SMTP fake.
 */
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { totp } from '@workflow/nodes-base';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userTokens } from '../src/db/schema';
import { createLogger, redactUrl } from '../src/logger';
import { OTHER_WORKSPACES_RESET_MESSAGE } from '../src/services/password';
import { startSmtpServer } from './fakes/smtp';
import {
  createTestServer,
  memberAs,
  ORIGIN,
  realMember,
  sessionFor,
  signup,
  ssoOn,
  TestClient,
  type TestServer,
  waitFor,
} from './helpers';

let server: TestServer;
let noMail: TestServer;
let smtp: Awaited<ReturnType<typeof startSmtpServer>>;

beforeAll(async () => {
  smtp = await startSmtpServer();
  server = await createTestServer({
    LOGIN_RATE_LIMIT_MAX: '1000',
    EMAIL_MODE: 'smtp',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SSL: 'false',
    SMTP_STARTTLS: 'false',
    SMTP_SENDER: 'Workflow <noreply@example.com>',
  });
  server.ctx.passwords.jitterMs = { min: 0, max: 0 };
  noMail = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { reset: false });
});
afterAll(async () => {
  await noMail.close();
  await server.close();
  await smtp.close();
});

let ipCounter = 0;
/** each caller comes from its own address: signup and the IP limits are per address */
const nextIp = () => `10.70.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const anon = () => new TestClient(server.app, ORIGIN, nextIp());
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function owner() {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  return { ...o, password: 'Passw0rd!' };
}

/** the text of a captured mail with quoted-printable folding and escapes undone */
function text(raw: string): string {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** the reset token in the mail sent to `email` */
async function tokenMailedTo(email: string): Promise<string> {
  const found = await waitFor(
    async () => {
      for (const m of smtp.messages) {
        if (!m.to.join(' ').includes(email)) continue;
        const match = /\/reset-password\?token=([\w-]+)/.exec(text(m.data));
        if (match) return match[1];
      }
      return undefined;
    },
    { message: `a reset mail to ${email}` },
  );
  return found;
}

const forgot = (email: string, client: TestClient = anon()) =>
  client.post('/rest/auth/forgot-password', { email });
const reset = (token: string, password: string, extra: Record<string, unknown> = {}) =>
  anon().post('/rest/auth/reset-password', { token, password, ...extra });
const login = (email: string, password: string) =>
  new TestClient(server.app, ORIGIN, nextIp()).post('/rest/auth/login', { email, password });

const STEP_MS = 30_000;
const codeAt = (secret: string, steps: number) =>
  totp({ secret, timestampMs: Date.now() + steps * STEP_MS }).token;

async function enableMfa(client: TestClient): Promise<string> {
  const setup = await client.data<{ secret: string }>(client.get('/rest/auth/mfa/setup'));
  const res = await client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) });
  expect(res.statusCode).toBe(200);
  return setup.secret;
}

const SAML = { samlMetadata: '<EntityDescriptor/>' };

describe('reset link', () => {
  it('works once, sets the new password and ends every session', async () => {
    const o = await owner();
    const second = new TestClient(server.app, ORIGIN, nextIp());
    const first = await second.post('/rest/auth/login', { email: o.user.email, password: o.password });
    expect(first.statusCode).toBe(200);
    expect((await forgot(o.user.email)).statusCode).toBe(200);
    const token = await tokenMailedTo(o.user.email);

    expect((await reset(token, 'NewPassw0rd!')).statusCode).toBe(200);
    expect((await o.client.get('/rest/auth/me')).statusCode).toBe(401);
    expect((await second.get('/rest/auth/me')).statusCode).toBe(401);
    expect((await login(o.user.email, o.password)).statusCode).toBe(401);
    expect((await login(o.user.email, 'NewPassw0rd!')).statusCode).toBe(200);

    const again = await reset(token, 'Another1Passw0rd');
    expect(again.statusCode).toBe(400);
    expect(again.json().error.message).toMatch(/invalid or has expired/);
    expect((await login(o.user.email, 'NewPassw0rd!')).statusCode).toBe(200);
    const audit = await server.ctx.repos.audit.list(o.tenant.id, 50);
    expect(audit.some((row) => row.action === 'auth.password_reset')).toBe(true);
  });

  it('stores only the hash of the token, for 20 minutes', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    const rows = await server.ctx.database.db
      .select()
      .from(userTokens)
      .where(eq(userTokens.userId, o.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'password_reset', tokenHash: sha(token) });
    expect(JSON.stringify(rows)).not.toContain(token);
    const life = rows[0].expiresAt.getTime() - Date.now();
    expect(life).toBeGreaterThan(18 * 60_000);
    expect(life).toBeLessThanOrEqual(20 * 60_000);
  });

  it('a new request replaces the old link', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const first = await tokenMailedTo(o.user.email);
    smtp.messages.length = 0;
    await forgot(o.user.email);
    const second = await tokenMailedTo(o.user.email);
    expect(second).not.toBe(first);
    expect((await reset(first, 'NewPassw0rd!')).statusCode).toBe(400);
    expect((await reset(second, 'NewPassw0rd!')).statusCode).toBe(200);
  });

  it('is refused after 20 minutes', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    await server.ctx.database.db
      .update(userTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(userTokens.tokenHash, sha(token)));
    expect((await anon().post('/rest/auth/reset-token/resolve', { token })).statusCode).toBe(400);
    expect((await reset(token, 'NewPassw0rd!')).statusCode).toBe(400);
    expect((await login(o.user.email, o.password)).statusCode).toBe(200);
  });

  it('resolves the token from a POST body (no token route) and says whether an MFA code is asked', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    expect((await anon().get(`/rest/auth/reset-token/${token}`)).statusCode).toBe(404);
    const info = await anon().post('/rest/auth/reset-token/resolve', { token });
    expect(info.json()).toEqual({ data: { mfaEnabled: false } });
    expect((await anon().post('/rest/auth/reset-token/resolve', { token: 'nope' })).statusCode).toBe(400);
    expect((await anon().post('/rest/auth/reset-token/resolve', {})).statusCode).toBe(400);
  });

  it('keeps the password rule and does not use the token on a weak password', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    expect((await reset(token, 'short')).statusCode).toBe(400);
    expect((await reset(token, 'NewPassw0rd!')).statusCode).toBe(200);
  });

  it('two requests with one token: one wins', async () => {
    const o = await owner();
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    const results = await Promise.all([
      reset(token, 'FirstPassw0rd!'),
      reset(token, 'SecondPassw0rd!'),
      reset(token, 'ThirdPassw0rd!'),
    ]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });

  it('asks for the MFA code when MFA is on, and keeps the token on a wrong code', async () => {
    const o = await owner();
    const secret = await enableMfa(o.client);
    await forgot(o.user.email);
    const token = await tokenMailedTo(o.user.email);
    const info = await anon().post('/rest/auth/reset-token/resolve', { token });
    expect(info.json().data.mfaEnabled).toBe(true);

    const missing = await reset(token, 'NewPassw0rd!');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toBe('If MFA enabled, mfaCode is required.');
    const wrong = await reset(token, 'NewPassw0rd!', { mfaCode: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.message).toBe('Invalid MFA token.');
    expect((await login(o.user.email, 'NewPassw0rd!')).statusCode).toBe(401);

    expect((await reset(token, 'NewPassw0rd!', { mfaCode: codeAt(secret, 1) })).statusCode).toBe(200);
  });
});

describe('forgot password', () => {
  it('answers the same for an unknown email, and mails only a real user', async () => {
    const o = await owner();
    smtp.messages.length = 0;
    const real = await forgot(o.user.email.toUpperCase());
    const unknown = await forgot(`nobody-${Date.now()}@example.com`);
    expect(real.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(real.statusCode);
    expect(unknown.body).toBe(real.body);
    expect(real.json()).toEqual({ data: { ok: true } });
    await tokenMailedTo(o.user.email);
    await new Promise((r) => setTimeout(r, 200));
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].to.join(' ')).toContain(o.user.email);
  });

  it('holds every answer for the jitter, known email or not', async () => {
    const o = await owner();
    server.ctx.passwords.jitterMs = { min: 300, max: 400 };
    try {
      const started = Date.now();
      const real = await forgot(o.user.email);
      const realMs = Date.now() - started;
      const second = Date.now();
      const unknown = await forgot(`nobody-${Date.now()}@example.com`);
      const unknownMs = Date.now() - second;
      expect(real.statusCode).toBe(200);
      expect(unknown.statusCode).toBe(200);
      expect(realMs).toBeGreaterThanOrEqual(290);
      expect(unknownMs).toBeGreaterThanOrEqual(290);
      expect(Math.abs(realMs - unknownMs)).toBeLessThan(250);
      await tokenMailedTo(o.user.email);
    } finally {
      server.ctx.passwords.jitterMs = { min: 0, max: 0 };
    }
  });

  it('still mails the link when the client leaves during the wait', async () => {
    const o = await owner();
    server.ctx.passwords.jitterMs = { min: 400, max: 400 };
    try {
      await server.app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = server.app.server.address() as AddressInfo;
      const body = JSON.stringify({ email: o.user.email });
      await new Promise<void>((resolve) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/rest/auth/forgot-password',
          headers: {
            'content-type': 'application/json',
            origin: ORIGIN,
            'content-length': Buffer.byteLength(body),
          },
        });
        req.on('error', () => resolve());
        req.on('close', () => resolve());
        req.end(body);
        // the client goes away before the answer
        setTimeout(() => req.destroy(), 100);
      });
      await tokenMailedTo(o.user.email);
    } finally {
      server.ctx.passwords.jitterMs = { min: 0, max: 0 };
    }
  });

  it('is refused without mail, with n8n text', async () => {
    const o = await signup(noMail.app, { projects: 'real', remoteAddress: nextIp() });
    const res = await new TestClient(noMail.app, ORIGIN, nextIp()).post('/rest/auth/forgot-password', {
      email: o.user.email,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toBe(
      'Email sending must be set up in order to request a password reset email',
    );
    const rows = await noMail.ctx.database.db
      .select()
      .from(userTokens)
      .where(eq(userTokens.userId, o.user.id));
    expect(rows).toHaveLength(0);
  });

  it('allows 3 a minute per email and 20 in 5 minutes per IP', async () => {
    const email = `limit-${Date.now()}@example.com`;
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await forgot(email)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);

    const ip = anon();
    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      results.push((await forgot(`ip-${i}-${Date.now()}@example.com`, ip)).statusCode);
    }
    expect(results.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(results[20]).toBe(429);
  });

  it('refuses an SSO-only and an LDAP-only user; SSO in one workspace and a password in another is allowed', async () => {
    const a = await owner();
    const b = await owner();
    const m = await realMember(a, { remoteAddress: nextIp() });
    await ssoOn(server, a.tenant.id, 'saml', SAML);
    smtp.messages.length = 0;

    const sso = await forgot(m.email);
    expect(sso.statusCode).toBe(403);
    expect(sso.json().error.code).toBe('sso_required');
    await new Promise((r) => setTimeout(r, 100));
    expect(smtp.messages).toHaveLength(0);

    await server.ctx.repos.memberships.add(b.tenant.id, m.user.id, 'member');
    expect((await forgot(m.email)).statusCode).toBe(200);
    await tokenMailedTo(m.email);

    const c = await owner();
    const l = await realMember(c, { remoteAddress: nextIp() });
    await ssoOn(server, c.tenant.id, 'ldap', {
      ldap: { connectionUrl: 'ldap.test', loginLabel: 'Directory' },
    });
    const ldap = await forgot(l.email);
    expect(ldap.statusCode).toBe(403);
    expect(ldap.json().error.code).toBe('ldap_user');
  });

  it('refuses a reset token of a user who has since become SSO-only', async () => {
    const a = await owner();
    const m = await realMember(a, { remoteAddress: nextIp() });
    await forgot(m.email);
    const token = await tokenMailedTo(m.email);
    await ssoOn(server, a.tenant.id, 'saml', SAML);
    expect((await reset(token, 'NewPassw0rd!')).statusCode).toBe(403);
  });
});

describe('PATCH /auth/me/password and /auth/me', () => {
  const change = (client: TestClient, body: Record<string, unknown>) =>
    client.patch('/rest/auth/me/password', body);

  it('changes the password with the current one, ends other sessions and keeps this one', async () => {
    const o = await owner();
    const other = new TestClient(server.app, ORIGIN, nextIp());
    await other.post('/rest/auth/login', { email: o.user.email, password: o.password });

    const wrong = await change(o.client, { currentPassword: 'wrong', newPassword: 'NewPassw0rd!' });
    expect(wrong.statusCode).toBe(400);
    const weak = await change(o.client, { currentPassword: o.password, newPassword: 'short' });
    expect(weak.statusCode).toBe(400);

    const ok = await change(o.client, { currentPassword: o.password, newPassword: 'NewPassw0rd!' });
    expect(ok.statusCode).toBe(200);
    expect((await o.client.get('/rest/auth/me')).statusCode).toBe(200);
    expect((await other.get('/rest/auth/me')).statusCode).toBe(401);
    expect((await login(o.user.email, o.password)).statusCode).toBe(401);
    expect((await login(o.user.email, 'NewPassw0rd!')).statusCode).toBe(200);
    const audit = await server.ctx.repos.audit.list(o.tenant.id, 50);
    expect(audit.some((row) => row.action === 'auth.password_changed')).toBe(true);
  });

  it('needs the MFA code when MFA is on', async () => {
    const o = await owner();
    const secret = await enableMfa(o.client);
    const body = { currentPassword: o.password, newPassword: 'NewPassw0rd!' };
    expect((await change(o.client, body)).statusCode).toBe(400);
    expect((await change(o.client, { ...body, mfaCode: '000000' })).statusCode).toBe(400);
    expect((await change(o.client, { ...body, mfaCode: codeAt(secret, 2) })).statusCode).toBe(200);
  });

  it('refuses a fenced (SSO) session on the password; the name only when the person has another workspace', async () => {
    const o = await owner();
    const saml = await sessionFor(server, o.tenant.id, o.user.id, { authMethod: 'saml', mfaVerified: true });
    const pw = await change(saml.client, { currentPassword: o.password, newPassword: 'NewPassw0rd!' });
    expect(pw.statusCode).toBe(403);
    expect(pw.json().error.code).toBe('sso_session_fenced');
    // one workspace only: the SAML session may set the name (onboarding)
    const named = await saml.client.patch('/rest/auth/me', { name: 'Named' });
    expect(named.statusCode).toBe(200);
    expect((await server.ctx.repos.users.get(o.user.id))?.name).toBe('Named');
    expect((await login(o.user.email, o.password)).statusCode).toBe(200);

    // a person with a second workspace: the name is global, so the fenced session is refused
    const two = await owner();
    const other = await owner();
    await server.ctx.repos.memberships.add(other.tenant.id, two.user.id, 'member');
    const fenced = await sessionFor(server, two.tenant.id, two.user.id, {
      authMethod: 'saml',
      mfaVerified: true,
    });
    const name = await fenced.client.patch('/rest/auth/me', { name: 'Changed' });
    expect(name.statusCode).toBe(403);
    expect(name.json().error.code).toBe('sso_session_fenced');
    expect((await server.ctx.repos.users.get(two.user.id))?.name).not.toBe('Changed');
  });

  it('changes the name; a SCIM managed account is refused; no session is 401', async () => {
    const o = await owner();
    const res = await o.client.patch('/rest/auth/me', { name: '  New Name  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: o.user.id, name: 'New Name' });
    expect((await o.client.patch('/rest/auth/me', { name: '' })).statusCode).toBe(400);
    expect((await anon().patch('/rest/auth/me', { name: 'x' })).statusCode).toBe(401);

    await server.ctx.repos.users.setManagedBy(o.user.id, o.tenant.id);
    const managed = await o.client.patch('/rest/auth/me', { name: 'Again' });
    expect(managed.statusCode).toBe(403);
    expect(managed.json().error.code).toBe('account_managed');
    await server.ctx.repos.users.setManagedBy(o.user.id, null);
  });
});

describe('admin reset link', () => {
  it('an admin copies a member link that works once; an owner is refused; a member cannot', async () => {
    const o = await owner();
    const m = await realMember(o, { remoteAddress: nextIp() });
    const res = await o.client.data<{ link: string }>(
      o.client.get(`/rest/members/${m.user.id}/password-reset-link`),
    );
    expect(res.link.startsWith('http://localhost:5678/reset-password?token=')).toBe(true);
    expect((await m.client.get(`/rest/members/${o.user.id}/password-reset-link`)).statusCode).toBe(403);
    const token = new URL(res.link).searchParams.get('token') ?? '';
    expect((await reset(token, 'NewPassw0rd!')).statusCode).toBe(200);
    expect((await reset(token, 'Another1Passw0rd')).statusCode).toBe(400);
    expect((await login(m.email, 'NewPassw0rd!')).statusCode).toBe(200);

    expect((await o.client.get(`/rest/members/${o.user.id}/password-reset-link`)).statusCode).toBe(403);
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await o.client.get(`/rest/members/${missing}/password-reset-link`)).statusCode).toBe(404);
    const stranger = await owner();
    const other = await stranger.client.get(`/rest/members/${m.user.id}/password-reset-link`);
    expect(other.statusCode).toBe(404);
  });

  it('refuses the link of an account that also belongs to another workspace, as a member or its owner', async () => {
    const a = await owner();
    const admin = await memberAs(a, 'admin', { remoteAddress: nextIp() });
    const victim = await realMember(a, { remoteAddress: nextIp() });
    const b = await owner();
    const linkOf = (client: TestClient) => client.get(`/rest/members/${victim.user.id}/password-reset-link`);
    const tokens = async () =>
      (await server.ctx.database.db.select().from(userTokens).where(eq(userTokens.userId, victim.user.id)))
        .length;

    for (const role of ['member', 'owner'] as const) {
      await server.ctx.repos.memberships.add(b.tenant.id, victim.user.id, role);
      for (const caller of [a, admin]) {
        const res = await linkOf(caller.client);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.message).toBe(OTHER_WORKSPACES_RESET_MESSAGE);
        expect(res.body).not.toContain('token=');
      }
      expect(await tokens()).toBe(0);
      await server.ctx.repos.memberships.remove(b.tenant.id, victim.user.id);
    }
    // back to one workspace: the admin's link works again
    expect((await linkOf(admin.client)).statusCode).toBe(200);
  });
});

describe('logs', () => {
  it('redactUrl drops the query of the reset and email change links, the OIDC callback and the SAML ACS', () => {
    expect(redactUrl('/reset-password?token=secret-token')).toBe('/reset-password');
    expect(redactUrl('/confirm-email-change?token=secret-token&x=1')).toBe('/confirm-email-change');
    expect(redactUrl('/rest/auth/reset-password?token=secret-token')).toBe('/rest/auth/reset-password');
    expect(redactUrl('/sso/oidc/acme/callback?code=c1&state=s1')).toBe('/sso/oidc/acme/callback');
    expect(redactUrl('/sso/saml/acme/acs?SAMLResponse=abc&RelayState=r')).toBe('/sso/saml/acme/acs');
    expect(redactUrl('/%72eset-password?token=secret-token')).toBe('/%72eset-password');
    expect(redactUrl('/webhook/abc/hook?code=one-time&x=1')).toBe('/webhook/abc/hook?code=[redacted]&x=1');
    expect(redactUrl('/webhook-test/abc/hook?code=one-time')).toBe('/webhook-test/abc/hook?code=[redacted]');
    expect(redactUrl('/webhook/abc/hook?x=1')).toBe('/webhook/abc/hook?x=1');
    expect(redactUrl('/rest/oauth2-credential/callback?state=s')).toBe(
      '/rest/oauth2-credential/callback?state=s',
    );
  });

  it("the server logger's request lines drop the reset, email change, OIDC callback and SAML ACS queries", async () => {
    const lines: string[] = [];
    const logger = createLogger(
      'info',
      {},
      new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    // Fastify's own 'incoming request' line, written through the app's logger as app.ts builds it
    const app = Fastify({ loggerInstance: logger as unknown as FastifyBaseLogger });
    app.all('/*', async () => ({ ok: true }));
    const SECRET = 'abc123secret';
    const urls = [
      `/reset-password?token=${SECRET}`,
      `/confirm-email-change?token=${SECRET}`,
      `/rest/sso/oidc/acme/callback?code=${SECRET}&state=${SECRET}`,
      `/rest/sso/saml/acme/acs?SAMLResponse=${SECRET}&RelayState=${SECRET}`,
    ];
    try {
      for (const url of urls) expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
    const incoming = lines.filter((line) => line.includes('incoming request'));
    expect(incoming).toHaveLength(urls.length);
    for (const path of ['/reset-password"', '/confirm-email-change"', '/callback"', '/acs"']) {
      expect(incoming.some((line) => line.includes(path))).toBe(true);
    }
    expect(lines.join('')).not.toContain(SECRET);
  });
});
