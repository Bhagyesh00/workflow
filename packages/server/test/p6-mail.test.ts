/**
 * P6-17 (L1) the workspace mailer: `isConfigured` follows EMAIL_MODE and SMTP_HOST; a mail reaches the SMTP
 * fake (test/fakes/smtp.ts, no real mailbox); the transport goes through the SSRF guard (a private host is
 * refused unless the policy allows it); every value is HTML escaped; a `UM_EMAIL_TEMPLATES_*` file replaces
 * its template; a log line never holds a link; the service account token comes through `ctx.http` and the
 * wire shows XOAUTH2.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HttpClient } from '@workflow/core';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceDeps } from '../src/context';
import { renderMail } from '../src/services/mail-templates';
import { Mailer } from '../src/services/mailer';
import { startSmtpServer } from './fakes/smtp';
import { createTestServer, type TestServer } from './helpers';

type Smtp = Awaited<ReturnType<typeof startSmtpServer>>;

let smtp: Smtp;
let tmp: string;
const servers: TestServer[] = [];

beforeAll(async () => {
  smtp = await startSmtpServer();
  tmp = await mkdtemp(path.join(tmpdir(), 'wf-mail-'));
});
afterAll(async () => {
  await smtp.close();
  await rm(tmp, { recursive: true, force: true });
});
afterEach(async () => {
  smtp.messages.length = 0;
  while (servers.length) await servers.pop()?.close();
});

const loopback = () =>
  new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1', 'localhost'], deny: [] } });
const strict = () => new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } });

async function start(env: Record<string, string> = {}, client: HttpClient = loopback()) {
  const server = await createTestServer(
    {
      EMAIL_MODE: 'smtp',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SSL: 'false',
      SMTP_STARTTLS: 'false',
      SMTP_SENDER: 'Workflow <noreply@example.com>',
      ...env,
    },
    { http: client },
  );
  servers.push(server);
  return server;
}

/** the body of a captured mail with quoted-printable folding and escapes undone */
function body(raw: string): string {
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const invite = (over: Record<string, string> = {}) => ({
  workspaceName: 'Acme',
  inviterName: 'Ann',
  role: 'member',
  inviteUrl: 'http://localhost:5678/invitation/tok-abc',
  ...over,
});

describe('Mailer.isConfigured', () => {
  it('is true with EMAIL_MODE smtp and a host, false without a host or with mode off', async () => {
    const on = await start();
    expect(on.ctx.mailer.isConfigured()).toBe(true);
    const noHost = await start({ SMTP_HOST: '' });
    expect(noHost.ctx.mailer.isConfigured()).toBe(false);
    const off = await start({ EMAIL_MODE: '' });
    expect(off.ctx.mailer.isConfigured()).toBe(false);
  });

  it('sends nothing and answers sent:false while mail is not set up', async () => {
    const server = await start({ SMTP_HOST: '' });
    expect(await server.ctx.mailer.sendInvite('a@example.com', invite())).toEqual({ sent: false });
    expect(smtp.messages).toHaveLength(0);
  });
});

describe('sending', () => {
  it('a mail reaches the SMTP server with the sender, the recipient, the link and the word workspace', async () => {
    const server = await start();
    expect(await server.ctx.mailer.sendInvite('new.user@example.com', invite())).toEqual({ sent: true });
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.from).toContain('noreply@example.com');
    expect(message?.to.join(' ')).toContain('new.user@example.com');
    const text = body(message?.data ?? '');
    expect(text).toContain('http://localhost:5678/invitation/tok-abc');
    expect(text).toContain('workspace Acme');
    expect(text).not.toMatch(/instance|n8n/i);
  });

  it('every kind of mail renders and sends once', async () => {
    const server = await start();
    const { mailer } = server.ctx;
    const u = 'http://localhost:5678/x';
    await mailer.sendPasswordReset('a@example.com', { name: 'A', resetUrl: u, expiresInMinutes: 20 });
    await mailer.sendEmailChangeRequested('a@example.com', {
      name: 'A',
      newEmail: 'b@example.com',
      confirmUrl: u,
    });
    await mailer.sendEmailChangeCompleted('a@example.com', { name: 'A', newEmail: 'b@example.com' });
    await mailer.sendApiKeyRevoked('a@example.com', {
      workspaceName: 'Acme',
      keyLabel: 'ci',
      revokedBy: 'Ann',
    });
    await mailer.sendMcpClientRevoked('a@example.com', {
      workspaceName: 'Acme',
      clientName: 'Desk',
      revokedBy: 'Ann',
    });
    await mailer.sendWorkflowShared('a@example.com', {
      workspaceName: 'Acme',
      actorName: 'Ann',
      workflowName: 'Flow',
      workflowUrl: u,
    });
    await mailer.sendCredentialShared('a@example.com', {
      workspaceName: 'Acme',
      actorName: 'Ann',
      credentialName: 'Key',
      credentialsUrl: u,
    });
    await mailer.sendProjectShared('a@example.com', {
      workspaceName: 'Acme',
      actorName: 'Ann',
      projectName: 'Proj',
      role: 'editor',
      projectUrl: u,
    });
    await mailer.sendFirstProductionFailure('a@example.com', {
      workspaceName: 'Acme',
      workflowName: 'Flow',
      workflowUrl: u,
    });
    expect(smtp.messages).toHaveLength(9);
    const joined = smtp.messages.map((m) => body(m.data)).join('\n');
    expect(joined).toContain('20 minutes');
    expect(joined).toContain('b@example.com');
    expect(joined).not.toMatch(/instance|n8n/i);
  });

  it('a private SMTP host is refused unless the policy allows it', async () => {
    const refused = await start({}, strict());
    await expect(refused.ctx.mailer.sendInvite('a@example.com', invite())).rejects.toThrow(
      /Couldn't send the mail/,
    );
    expect(smtp.messages).toHaveLength(0);

    const allowed = await start(
      {},
      new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
    );
    expect(await allowed.ctx.mailer.sendInvite('a@example.com', invite())).toEqual({ sent: true });
    expect(smtp.messages).toHaveLength(1);
  });

  it('plain login sends AUTH with the user and password', async () => {
    const server = await start({ SMTP_USER: 'mailer', SMTP_PASS: 'pw-1' });
    await server.ctx.mailer.sendInvite('a@example.com', invite());
    expect(smtp.messages[0]?.auth).toBe('\u0000mailer\u0000pw-1');
  });

  it('an unreachable server throws a clean error', async () => {
    const server = await start({ SMTP_PORT: '1' });
    await expect(server.ctx.mailer.sendInvite('a@example.com', invite())).rejects.toThrow(
      /Couldn't send the mail/,
    );
  });
});

describe('templates', () => {
  it('escapes every HTML value', async () => {
    const server = await start();
    await server.ctx.mailer.sendInvite(
      'a@example.com',
      invite({
        workspaceName: '<script>alert(1)</script>',
        inviterName: 'A & "B"',
        inviteUrl: 'http://x/?a=1&b="2"',
      }),
    );
    const message = smtp.messages[0];
    const html = body(body(message?.data ?? '').split('Content-Type: text/html')[1] ?? '');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; &quot;B&quot;');
    expect(html).toContain('href="http://x/?a=1&amp;b=&quot;2&quot;"');
  });

  it('a subject is one line', async () => {
    const rendered = await renderMail('invite', invite({ inviterName: 'Ann\r\nBcc: x@example.com' }), {});
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it('a template file replaces its template and its values are escaped', async () => {
    const file = path.join(tmp, 'invite.html');
    await writeFile(
      file,
      '<p>Welcome {{ inviterName }} to {{workspaceName}}</p><a href="{{ inviteUrl }}">go</a>{{ nothing }}',
    );
    const server = await start({ UM_EMAIL_TEMPLATES_INVITE: file });
    await server.ctx.mailer.sendInvite('a@example.com', invite({ inviterName: '<b>Ann</b>' }));
    const html = body(smtp.messages[0]?.data ?? '');
    expect(html).toContain('<p>Welcome &lt;b&gt;Ann&lt;/b&gt; to Acme</p>');
    expect(html).toContain('href="http://localhost:5678/invitation/tok-abc"');
    expect(html).not.toContain('{{');
    // the other templates keep the built-in text
    await server.ctx.mailer.sendApiKeyRevoked('a@example.com', {
      workspaceName: 'Acme',
      keyLabel: 'ci',
      revokedBy: 'Ann',
    });
    expect(body(smtp.messages[1]?.data ?? '')).toContain('was revoked by Ann');
  });

  it('a missing template file falls back to the built-in text', async () => {
    const server = await start({ UM_EMAIL_TEMPLATES_INVITE: path.join(tmp, 'absent.html') });
    await server.ctx.mailer.sendInvite('a@example.com', invite());
    expect(body(smtp.messages[0]?.data ?? '')).toContain('You have been invited');
  });
});

describe('logs', () => {
  it('a log line holds no link, no token and no address', async () => {
    const server = await start();
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
    const { ctx } = server;
    const deps: ServiceDeps = {
      config: ctx.config,
      database: ctx.database,
      repos: ctx.repos,
      logger,
      context: () => ctx,
    };
    const mailer = new Mailer(deps);
    await mailer.sendInvite(
      'private.person@example.com',
      invite({ inviteUrl: 'http://localhost:5678/invitation/SECRET-TOKEN-1' }),
    );
    const failing = new Mailer({
      ...deps,
      config: { ...ctx.config, mail: { ...ctx.config.mail, smtp: { ...ctx.config.mail.smtp, port: 1 } } },
    });
    await failing
      .sendPasswordReset('private.person@example.com', {
        name: 'P',
        resetUrl: 'http://localhost:5678/reset/SECRET-TOKEN-2',
        expiresInMinutes: 20,
      })
      .catch(() => undefined);
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toContain('SECRET-TOKEN');
    expect(all).not.toContain('private.person');
  });
});

describe('service account', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let tokenServer: http.Server;
  let tokenUrl: string;
  const tokenCalls: string[] = [];

  beforeAll(async () => {
    tokenServer = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        tokenCalls.push(data);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'ya29.mail-token', expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    tokenUrl = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/token`;
  });
  afterAll(async () => {
    await new Promise((resolve) => tokenServer.close(resolve));
  });

  const accountEnv = {
    SMTP_USER: 'sender@example.com',
    SMTP_OAUTH_SERVICE_CLIENT: 'svc@project.iam.example.com',
    SMTP_OAUTH_PRIVATE_KEY: pem,
  };
  const mailerOf = (server: TestServer) => {
    const { ctx } = server;
    return new Mailer(
      {
        config: ctx.config,
        database: ctx.database,
        repos: ctx.repos,
        logger: ctx.logger,
        context: () => ctx,
      },
      { tokenUrl },
    );
  };

  it('the token goes to the token URL through ctx.http and the wire shows XOAUTH2 with it', async () => {
    tokenCalls.length = 0;
    const server = await start(accountEnv);
    const mailer = mailerOf(server);
    expect(await mailer.sendInvite('a@example.com', invite())).toEqual({ sent: true });
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0]);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = JSON.parse(
      Buffer.from((form.get('assertion') ?? '').split('.')[1] ?? '', 'base64url').toString(),
    );
    expect(claims.iss).toBe('svc@project.iam.example.com');
    expect(claims.sub).toBe('sender@example.com');
    expect(claims.aud).toBe(tokenUrl);
    expect(smtp.messages[0]?.auth).toBe(
      'user=sender@example.com\u0001auth=Bearer ya29.mail-token\u0001\u0001',
    );
    // the token is kept: a second mail does not ask again
    await mailer.sendInvite('b@example.com', invite());
    expect(tokenCalls).toHaveLength(1);
    expect(smtp.messages).toHaveLength(2);
  });

  it('the token call is guarded: a client that refuses the host sends no mail', async () => {
    tokenCalls.length = 0;
    const server = await start(
      { ...accountEnv, SMTP_OAUTH_SERVICE_CLIENT: 'other@project.iam.example.com' },
      strict(),
    );
    await expect(mailerOf(server).sendInvite('a@example.com', invite())).rejects.toThrow(
      /Couldn't send the mail/,
    );
    expect(tokenCalls).toHaveLength(0);
    expect(smtp.messages).toHaveLength(0);
  });
});
