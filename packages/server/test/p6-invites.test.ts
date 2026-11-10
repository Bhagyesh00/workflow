/**
 * P6-20 (L4) invitations: many at once, the single-object body keeps its answer, mail through the SMTP fake
 * (no real mailbox), links hidden under INVITE_LINKS_EMAIL_ONLY, re-inviting a pending person, resend and copy
 * link rotate the token (the old link dies), the grant ceiling, SSO refusing invites, other workspaces' ids.
 */
import { randomUUID } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/http/errors';
import { startSmtpServer } from './fakes/smtp';
import {
  createTestServer,
  ORIGIN,
  realMember,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
} from './helpers';

const MISSING_SCOPE = 'User is missing a scope required to perform this action';

type Smtp = Awaited<ReturnType<typeof startSmtpServer>>;

let smtp: Smtp;
const servers: TestServer[] = [];

beforeAll(async () => {
  smtp = await startSmtpServer();
});
afterAll(async () => {
  await smtp.close();
});
afterEach(async () => {
  smtp.messages.length = 0;
  vi.restoreAllMocks();
  while (servers.length) await servers.pop()?.close();
});

const loopback = () =>
  new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } });

/** a server; `mail` points it at the SMTP fake (or at a closed port) */
async function start(env: Record<string, string> = {}, mail: boolean | 'closed' = false) {
  const port = mail === 'closed' ? await closedPort() : smtp.port;
  const server = await createTestServer(
    mail
      ? {
          EMAIL_MODE: 'smtp',
          SMTP_HOST: '127.0.0.1',
          SMTP_PORT: String(port),
          SMTP_SSL: 'false',
          SMTP_STARTTLS: 'false',
          SMTP_SENDER: 'Workflow <noreply@example.com>',
          ...env,
        }
      : env,
    { startMain: false, http: loopback() },
  );
  servers.push(server);
  await resetDatabase(server.ctx);
  return server;
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let ipCounter = 0;
const ws = (server: TestServer) =>
  signup(server.app, { remoteAddress: `10.66.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` });

const addr = () => `inv-${randomUUID().slice(0, 8)}@example.com`;
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

/** accepts with a token on a fresh client; the status says whether the link still works */
async function accept(server: TestServer, token: string) {
  const client = new TestClient(server.app, ORIGIN);
  return client.post(`/rest/invitations/${token}/accept`, { name: 'Newcomer', password: 'Passw0rd!' });
}

/** the text of a captured mail with quoted-printable folding undone */
const mailText = (raw: string) =>
  raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

describe('POST /members/invite with a list', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await start();
  });

  it('an admin invites three at once and gets one answer per row, links included while no mail is set up', async () => {
    const owner = await ws(server);
    const emails = [addr(), addr(), addr()];
    const rows = await owner.client.data<any[]>(
      owner.client.post(
        '/rest/members/invite',
        emails.map((email, i) => ({ email, role: i === 2 ? 'admin' : 'member' })),
      ),
    );
    expect(rows).toHaveLength(3);
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({
        email: emails[i],
        role: i === 2 ? 'admin' : 'member',
        emailSent: false,
        error: '',
        id: expect.any(String),
        inviteAcceptUrl: expect.stringMatching(/\/invitation\/.+/),
      });
    }
    const pending = await server.ctx.repos.invitations.listPending(owner.tenant.id);
    expect(pending.map((p) => p.email).sort()).toEqual([...emails].sort());
    // every link is its own, and each works
    const tokens = rows.map((r) => tokenOf(r.inviteAcceptUrl));
    expect(new Set(tokens).size).toBe(3);
    expect((await accept(server, tokens[0])).statusCode).toBe(200);
    const audit = await server.ctx.repos.audit.list(owner.tenant.id, 50);
    expect(audit.filter((a: { action: string }) => a.action === 'member.invited')).toHaveLength(3);
  });

  it('a row that fails answers its own error and the others still go', async () => {
    const owner = await ws(server);
    const member = await realMember(owner);
    const good = addr();
    const rows = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [
        { email: member.email, role: 'member' },
        { email: good, role: 'member' },
        { email: addr(), role: 'no-such-role' },
      ]),
    );
    expect(rows[0]).toMatchObject({
      id: null,
      emailSent: false,
      error: 'This user is already a member of the workspace',
    });
    expect(rows[0].inviteAcceptUrl).toBeUndefined();
    expect(rows[1]).toMatchObject({ email: good, error: '', inviteAcceptUrl: expect.any(String) });
    expect(rows[2]).toMatchObject({ id: null, error: 'Unknown role "no-such-role"' });
    expect((await server.ctx.repos.invitations.listPending(owner.tenant.id)).map((p) => p.email)).toEqual([
      good,
    ]);
  });

  it('a bad email or an empty list is a 400 before anything is made', async () => {
    const owner = await ws(server);
    expect(
      (
        await owner.client.post('/rest/members/invite', [
          { email: addr(), role: 'member' },
          { email: 'nope', role: 'member' },
        ])
      ).statusCode,
    ).toBe(400);
    expect((await owner.client.post('/rest/members/invite', [])).statusCode).toBe(400);
    expect(await server.ctx.repos.invitations.listPending(owner.tenant.id)).toEqual([]);
  });

  it('a custom role holding user:create cannot invite a wider role through the list either', async () => {
    const owner = await ws(server);
    await server.ctx.repos.roles.create(owner.tenant.id, {
      slug: 'global:people',
      displayName: 'People',
      roleType: 'global',
      scopes: ['user:list', 'user:create'],
    });
    const hr = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${hr.user.id}`, { role: 'global:people' }));
    const wide = addr();
    const fine = addr();
    const rows = await hr.client.data<any[]>(
      hr.client.post('/rest/members/invite', [
        { email: wide, role: 'admin' },
        { email: fine, role: 'member' },
      ]),
    );
    expect(rows[0]).toMatchObject({
      id: null,
      error: "Couldn't invite the member: the role gives scopes you don't have",
    });
    expect(rows[1].error).toBe('');
    const mails = (await server.ctx.repos.invitations.listPending(owner.tenant.id)).map((p) => p.email);
    expect(mails).toEqual([fine]);
  });

  it('only an owner invites an owner; a member without user:create is refused', async () => {
    const owner = await ws(server);
    const admin = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${admin.user.id}`, { role: 'admin' }));
    const rows = await admin.client.data<any[]>(
      admin.client.post('/rest/members/invite', [{ email: addr(), role: 'owner' }]),
    );
    expect(rows[0]).toMatchObject({ id: null, error: 'Only owners can invite owners' });
    const plain = await realMember(owner);
    const denied = await plain.client.post('/rest/members/invite', [{ email: addr(), role: 'member' }]);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);
  });
});

describe('POST /members/invite with one object', () => {
  it('answers as before: id, email, role, expiresAt, the one-time token and the accept URL', async () => {
    const server = await start();
    const owner = await ws(server);
    const email = addr();
    const data = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email, role: 'member' }),
    );
    expect(data).toMatchObject({
      email,
      role: 'member',
      id: expect.any(String),
      expiresAt: expect.any(String),
      token: expect.any(String),
      inviteUrl: expect.stringContaining(`/invitation/${data.token}`),
    });
    expect((await accept(server, data.token)).statusCode).toBe(200);
  });

  it('keeps its statuses: 403 for a wider role, 409 for a member, 400 for an unknown role', async () => {
    const server = await start();
    const owner = await ws(server);
    const member = await realMember(owner);
    const dup = await owner.client.post('/rest/members/invite', { email: member.email, role: 'member' });
    expect(dup.statusCode).toBe(409);
    const unknown = await owner.client.post('/rest/members/invite', { email: addr(), role: 'nobody' });
    expect(unknown.statusCode).toBe(400);
    const admin = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${admin.user.id}`, { role: 'admin' }));
    const toOwner = await admin.client.post('/rest/members/invite', { email: addr(), role: 'owner' });
    expect(toOwner.statusCode).toBe(403);
    expect(toOwner.json().error.message).toBe('Only owners can invite owners');
  });
});

describe('mail', () => {
  it('with mail set up the invitation is mailed to the invitee with the link, and the link is still answered', async () => {
    const server = await start({}, true);
    const owner = await ws(server);
    const email = addr();
    const [row] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email, role: 'member' }]),
    );
    expect(row).toMatchObject({ emailSent: true, error: '', inviteAcceptUrl: expect.any(String) });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0].to.join(' ')).toContain(email);
    expect(mailText(smtp.messages[0].data)).toContain(row.inviteAcceptUrl);
  });

  it('INVITE_LINKS_EMAIL_ONLY hides the link once the mail went out, in both bodies', async () => {
    const server = await start({ INVITE_LINKS_EMAIL_ONLY: 'true' }, true);
    const owner = await ws(server);
    const [row] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email: addr(), role: 'member' }]),
    );
    expect(row.emailSent).toBe(true);
    expect(row.inviteAcceptUrl).toBeUndefined();
    const single = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    expect(single.token).toBeUndefined();
    expect(single.inviteUrl).toBeUndefined();
    expect(smtp.messages).toHaveLength(2);
    // the mailed link works
    const url = /https?:\/\/[^\s"'<>]+\/invitation\/[\w-]+/.exec(mailText(smtp.messages[0].data))?.[0];
    expect(url).toBeTruthy();
    expect((await accept(server, tokenOf(url!))).statusCode).toBe(200);
  });

  it('mail that fails shows the link and says why, even under INVITE_LINKS_EMAIL_ONLY', async () => {
    const server = await start({ INVITE_LINKS_EMAIL_ONLY: 'true' }, 'closed');
    const owner = await ws(server);
    const [row] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email: addr(), role: 'member' }]),
    );
    expect(row.emailSent).toBe(false);
    expect(row.error).toMatch(/^Couldn't send the invitation email/);
    expect(row.inviteAcceptUrl).toMatch(/\/invitation\//);
  });

  it('mail off returns the URL and emailSent false', async () => {
    const server = await start({ INVITE_LINKS_EMAIL_ONLY: 'true' });
    const owner = await ws(server);
    const [row] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email: addr(), role: 'member' }]),
    );
    expect(row).toMatchObject({ emailSent: false, error: '', inviteAcceptUrl: expect.any(String) });
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('re-inviting, resend and copy link', () => {
  it('inviting a pending person again sends again with a new token; the old link dies', async () => {
    const server = await start({}, true);
    const owner = await ws(server);
    const email = addr();
    const [first] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email, role: 'member' }]),
    );
    const [second] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email, role: 'member' }]),
    );
    expect(second.id).toBe(first.id);
    expect(second.emailSent).toBe(true);
    expect(smtp.messages).toHaveLength(2);
    expect(await server.ctx.repos.invitations.listPending(owner.tenant.id)).toHaveLength(1);
    expect((await accept(server, tokenOf(first.inviteAcceptUrl))).statusCode).toBe(404);
    expect((await accept(server, tokenOf(second.inviteAcceptUrl))).statusCode).toBe(200);
  });

  it('inviting a pending person with another role replaces the invitation', async () => {
    const server = await start();
    const owner = await ws(server);
    const email = addr();
    const [first] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email, role: 'member' }]),
    );
    const [second] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email, role: 'admin' }]),
    );
    const pending = await server.ctx.repos.invitations.listPending(owner.tenant.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: second.id, role: 'admin' });
    expect((await accept(server, tokenOf(first.inviteAcceptUrl))).statusCode).toBe(404);
  });

  it('resend gives a new token and expiry, mails it, and the old link stops working', async () => {
    const server = await start({}, true);
    const owner = await ws(server);
    const email = addr();
    const first = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email, role: 'member' }),
    );
    smtp.messages.length = 0;
    const before = await server.ctx.repos.invitations.get(owner.tenant.id, first.id);
    await new Promise((r) => setTimeout(r, 20));
    const row = await owner.client.data<any>(owner.client.post(`/rest/invitations/${first.id}/resend`));
    expect(row).toMatchObject({ id: first.id, email, role: 'member', emailSent: true, error: '' });
    expect(row.inviteAcceptUrl).not.toContain(first.token);
    expect(smtp.messages).toHaveLength(1);
    const after = await server.ctx.repos.invitations.get(owner.tenant.id, first.id);
    expect(after!.tokenHash).not.toBe(before!.tokenHash);
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    expect((await accept(server, first.token)).statusCode).toBe(404);
    expect((await accept(server, tokenOf(row.inviteAcceptUrl))).statusCode).toBe(200);
    const audit = await server.ctx.repos.audit.list(owner.tenant.id, 50);
    expect(audit.some((a: { action: string }) => a.action === 'invitation.resent')).toBe(true);
  });

  it('resend renews an expired invitation', async () => {
    const server = await start();
    const owner = await ws(server);
    const first = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    await server.ctx.database.pool.query(
      "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1",
      [first.id],
    );
    expect((await accept(server, first.token)).statusCode).toBe(404);
    const row = await owner.client.data<any>(owner.client.post(`/rest/invitations/${first.id}/resend`));
    expect(row.emailSent).toBe(false);
    expect((await accept(server, tokenOf(row.inviteAcceptUrl))).statusCode).toBe(200);
  });

  it('copy link answers a link, rotates the token, and the old link dies', async () => {
    const server = await start();
    const owner = await ws(server);
    const first = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    const { link } = await owner.client.data<{ link: string }>(
      owner.client.post(`/rest/invitations/${first.id}/link`),
    );
    expect(link).toMatch(/\/invitation\/.+/);
    expect(link).not.toContain(first.token);
    expect((await accept(server, first.token)).statusCode).toBe(404);
    expect((await accept(server, tokenOf(link))).statusCode).toBe(200);
  });

  it('copy link needs user:generateInviteLink and resend needs user:create', async () => {
    const server = await start();
    const owner = await ws(server);
    const first = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    await server.ctx.repos.roles.create(owner.tenant.id, {
      slug: 'global:mailer',
      displayName: 'Mailer',
      roleType: 'global',
      scopes: ['user:list', 'user:create'],
    });
    const hr = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${hr.user.id}`, { role: 'global:mailer' }));
    const link = await hr.client.post(`/rest/invitations/${first.id}/link`);
    expect(link.statusCode).toBe(403);
    expect(link.json().error.message).toBe(MISSING_SCOPE);
    expect((await hr.client.post(`/rest/invitations/${first.id}/resend`)).statusCode).toBe(200);
    const plain = await realMember(owner);
    const denied = await plain.client.post(`/rest/invitations/${first.id}/resend`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe(MISSING_SCOPE);
  });

  it('a caller cannot hand out a link or a resend for a role wider than its own', async () => {
    const server = await start();
    const owner = await ws(server);
    const [admin] = await owner.client.data<any[]>(
      owner.client.post('/rest/members/invite', [{ email: addr(), role: 'admin' }]),
    );
    await server.ctx.repos.roles.create(owner.tenant.id, {
      slug: 'global:linker',
      displayName: 'Linker',
      roleType: 'global',
      scopes: ['user:list', 'user:create', 'user:generateInviteLink'],
    });
    const hr = await realMember(owner);
    await owner.client.data(owner.client.patch(`/rest/members/${hr.user.id}`, { role: 'global:linker' }));
    for (const path of ['link', 'resend']) {
      const res = await hr.client.post(`/rest/invitations/${admin.id}/${path}`);
      expect(res.statusCode, path).toBe(403);
    }
    const after = await server.ctx.repos.invitations.get(owner.tenant.id, admin.id);
    expect(after).toBeTruthy();
  });

  it("another workspace's invitation, an accepted one and a bad id are 404 or 400", async () => {
    const server = await start();
    const a = await ws(server);
    const b = await ws(server);
    const theirs = await b.client.data<any>(
      b.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    for (const path of ['resend', 'link']) {
      expect((await a.client.post(`/rest/invitations/${theirs.id}/${path}`)).statusCode, path).toBe(404);
    }
    // theirs is untouched: the token still works
    const done = await a.client.data<any>(
      a.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    expect((await accept(server, done.token)).statusCode).toBe(200);
    expect((await a.client.post(`/rest/invitations/${done.id}/resend`)).statusCode).toBe(404);
    expect((await a.client.post(`/rest/invitations/${randomUUID()}/link`)).statusCode).toBe(404);
    expect((await a.client.post('/rest/invitations/not-an-id/resend')).statusCode).toBe(400);
    expect((await accept(server, theirs.token)).statusCode).toBe(200);
  });
});

describe('when SSO refuses invitations', () => {
  it('an invite is refused when assertInviteAllowed throws: nothing is made, nothing is mailed', async () => {
    const server = await start({}, true);
    const owner = await ws(server);
    const kept = await owner.client.data<any>(
      owner.client.post('/rest/members/invite', { email: addr(), role: 'member' }),
    );
    smtp.messages.length = 0;
    const spy = vi
      .spyOn(server.ctx.ssoLogin, 'assertInviteAllowed')
      .mockRejectedValue(new ApiError(400, 'sso_invites_blocked', 'SSO manages the members'));
    for (const [path, body] of [
      ['/rest/members/invite', { email: addr(), role: 'member' }],
      ['/rest/members/invite', [{ email: addr(), role: 'member' }]],
      [`/rest/invitations/${kept.id}/resend`, undefined],
      [`/rest/invitations/${kept.id}/link`, undefined],
    ] as const) {
      const res = await owner.client.post(path, body);
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error.code).toBe('sso_invites_blocked');
    }
    expect(spy).toHaveBeenCalledWith(owner.tenant.id);
    expect(await server.ctx.repos.invitations.listPending(owner.tenant.id)).toHaveLength(1);
    expect(smtp.messages).toHaveLength(0);
    // the kept link was not rotated
    expect((await accept(server, kept.token)).statusCode).toBe(200);
  });
});
