/**
 * P6-19 (L3): change email. The password (or, with MFA on, a code) is the proof; the confirm link goes to the
 * NEW address, its token travels in a POST body and works once; the old address gets a completed mail; the
 * address is checked unique again at confirm; n8n's four texts; a fenced (SSO) session, a SCIM managed
 * account and a server without mail are refused. Mail goes to the SMTP fake.
 */
import { totp } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpServer } from './fakes/smtp';
import {
  createTestServer,
  ORIGIN,
  sessionFor,
  signup,
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
  noMail = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' }, { reset: false });
});
afterAll(async () => {
  await noMail.close();
  await server.close();
  await smtp.close();
});

let ipCounter = 0;
const nextIp = () => `10.71.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const anon = () => new TestClient(server.app, ORIGIN, nextIp());
let mailCounter = 0;
const freshEmail = () => `new-${Date.now()}-${++mailCounter}@example.com`;

async function owner() {
  const o = await signup(server.app, { projects: 'real', remoteAddress: nextIp() });
  return { ...o, password: 'Passw0rd!' };
}

function text(raw: string): string {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const mailTo = (email: string) =>
  waitFor(async () => smtp.messages.find((m) => m.to.join(' ').includes(email)), {
    message: `a mail to ${email}`,
  });

async function confirmToken(email: string): Promise<string> {
  const message = await mailTo(email);
  const match = /\/confirm-email-change\?token=([\w-]+)/.exec(text(message.data));
  if (!match) throw new Error('no confirm link in the mail');
  return match[1];
}

const change = (client: TestClient, body: Record<string, unknown>) =>
  client.post('/rest/auth/change-email', body);
const login = (email: string, password: string) =>
  new TestClient(server.app, ORIGIN, nextIp()).post('/rest/auth/login', { email, password });

const STEP_MS = 30_000;
const codeAt = (secret: string, steps: number) =>
  totp({ secret, timestampMs: Date.now() + steps * STEP_MS }).token;

describe('request and confirm', () => {
  it('mails the new address; the address changes only on confirm; the old address gets a completed mail', async () => {
    const o = await owner();
    const email = freshEmail();
    expect((await change(o.client, { email, currentPassword: o.password })).statusCode).toBe(200);
    const token = await confirmToken(email);
    expect((await server.ctx.repos.users.get(o.user.id))?.email).toBe(o.user.email.toLowerCase());
    expect((await login(o.user.email, o.password)).statusCode).toBe(200);
    smtp.messages.length = 0;

    const done = await anon().post('/rest/auth/confirm-email-change', { token });
    expect(done.statusCode).toBe(200);
    expect((await server.ctx.repos.users.get(o.user.id))?.email).toBe(email);
    expect((await login(email, o.password)).statusCode).toBe(200);
    expect((await login(o.user.email, o.password)).statusCode).toBe(401);
    const completed = await mailTo(o.user.email);
    expect(text(completed.data)).toContain(email);
    const audit = await server.ctx.repos.audit.list(o.tenant.id, 50);
    expect(audit.some((row) => row.action === 'auth.email_changed')).toBe(true);

    const again = await anon().post('/rest/auth/confirm-email-change', { token });
    expect(again.statusCode).toBe(400);
  });

  it('takes the email in lower case and the token only in the body', async () => {
    const o = await owner();
    const email = freshEmail();
    await change(o.client, { email: ` ${email.toUpperCase()} `, currentPassword: o.password });
    const token = await confirmToken(email);
    expect((await anon().get(`/rest/auth/confirm-email-change?token=${token}`)).statusCode).toBe(404);
    expect((await anon().post('/rest/auth/confirm-email-change', {})).statusCode).toBe(400);
    expect((await anon().post('/rest/auth/confirm-email-change', { token: 'nope' })).statusCode).toBe(400);
    expect((await anon().post('/rest/auth/confirm-email-change', { token })).statusCode).toBe(200);
    expect((await server.ctx.repos.users.get(o.user.id))?.email).toBe(email);
  });

  it('uses n8n texts for a missing or wrong proof, the same address and a taken address', async () => {
    const o = await owner();
    const other = await owner();
    const email = freshEmail();
    const noProof = await change(o.client, { email });
    expect(noProof.statusCode).toBe(400);
    expect(noProof.json().error.message).toBe('Current password is required to change email');
    const wrong = await change(o.client, { email, currentPassword: 'wrong-password' });
    expect(wrong.statusCode).toBe(400);
    const same = await change(o.client, { email: o.user.email.toUpperCase(), currentPassword: o.password });
    expect(same.statusCode).toBe(400);
    expect(same.json().error.message).toBe('The new email address matches the current one');
    const taken = await change(o.client, { email: other.user.email, currentPassword: o.password });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe('This email address is already in use');
    expect((await change(o.client, { email: 'not-an-email', currentPassword: o.password })).statusCode).toBe(
      400,
    );
    expect((await change(anon(), { email, currentPassword: o.password })).statusCode).toBe(401);
  });

  it('checks the address is free again at confirm, and a new request replaces the old link', async () => {
    const o = await owner();
    const email = freshEmail();
    await change(o.client, { email, currentPassword: o.password });
    const token = await confirmToken(email);
    // somebody signs up with that address meanwhile
    const taker = await signup(server.app, { email, projects: 'real', remoteAddress: nextIp() });
    const res = await anon().post('/rest/auth/confirm-email-change', { token });
    expect(res.statusCode).toBe(409);
    expect((await server.ctx.repos.users.get(o.user.id))?.email).toBe(o.user.email.toLowerCase());
    expect(taker.user.email).toBe(email);

    smtp.messages.length = 0;
    const first = freshEmail();
    await change(o.client, { email: first, currentPassword: o.password });
    const firstToken = await confirmToken(first);
    const second = freshEmail();
    await change(o.client, { email: second, currentPassword: o.password });
    const secondToken = await confirmToken(second);
    expect((await anon().post('/rest/auth/confirm-email-change', { token: firstToken })).statusCode).toBe(
      400,
    );
    expect((await anon().post('/rest/auth/confirm-email-change', { token: secondToken })).statusCode).toBe(
      200,
    );
  });

  it('with MFA on, the code is the proof', async () => {
    const o = await owner();
    const setup = await o.client.data<{ secret: string }>(o.client.get('/rest/auth/mfa/setup'));
    await o.client.post('/rest/auth/mfa/enable', { mfaCode: codeAt(setup.secret, -6) });
    const email = freshEmail();
    const none = await change(o.client, { email, currentPassword: o.password });
    expect(none.statusCode).toBe(400);
    expect(none.json().error.message).toBe('Two-factor code is required to change email');
    expect((await change(o.client, { email, mfaCode: '000000' })).statusCode).toBe(400);
    expect((await change(o.client, { email, mfaCode: codeAt(setup.secret, 2) })).statusCode).toBe(200);
    await confirmToken(email);
  });

  it('is refused for a fenced session, for a managed account and without mail', async () => {
    const o = await owner();
    const email = freshEmail();
    const saml = await sessionFor(server, o.tenant.id, o.user.id, { authMethod: 'oidc', mfaVerified: true });
    const fenced = await change(saml.client, { email, currentPassword: o.password });
    expect(fenced.statusCode).toBe(403);
    expect(fenced.json().error.code).toBe('sso_session_fenced');

    await server.ctx.repos.users.setManagedBy(o.user.id, o.tenant.id);
    const managed = await change(o.client, { email, currentPassword: o.password });
    expect(managed.statusCode).toBe(403);
    expect(managed.json().error.code).toBe('account_managed');
    await server.ctx.repos.users.setManagedBy(o.user.id, null);

    const bare = await signup(noMail.app, { projects: 'real', remoteAddress: nextIp() });
    const none = await change(bare.client, { email, currentPassword: 'Passw0rd!' });
    expect(none.statusCode).toBe(500);
    expect(none.json().error.code).toBe('mail_not_configured');
    expect(smtp.messages.some((m) => m.to.join(' ').includes(email))).toBe(false);
  });

  it('limits the proof guesses to 10 a minute per user', async () => {
    const o = await owner();
    const email = freshEmail();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await change(o.client, { email, currentPassword: 'wrong' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
