/**
 * P6-17 (L1): `createSmtpTransport` takes `creds.accessToken` (a service account token the caller fetched on
 * a guarded client). The login is XOAUTH2 with the user and the token, the connection still goes only to the
 * checked addresses, and a credential without a token keeps the plain login.
 */
import { HttpClient } from '@workflow/core';
import { describe, expect, it } from 'vitest';
import { createSmtpTransport } from '../src/utils/smtp-transport';
import { startSmtpServer } from './servers';

const guarded = () => {
  const client = new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } });
  return { helpers: { resolveAllowedHost: (host: string) => client.resolveAllowedHost(host) } };
};

const mail = { from: 'a@example.com', to: 'b@example.com', subject: 's', text: 't' };

describe('createSmtpTransport with an access token', () => {
  it('logs in with XOAUTH2, the user and the token', async () => {
    const smtp = await startSmtpServer();
    const transport = await createSmtpTransport(guarded(), {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      user: 'sender@example.com',
      accessToken: 'ya29.token-1',
    });
    try {
      await transport.sendMail(mail);
      expect(smtp.messages).toHaveLength(1);
      expect(smtp.messages[0]!.auth).toBe(
        'user=sender@example.com\u0001auth=Bearer ya29.token-1\u0001\u0001',
      );
    } finally {
      transport.close();
      await smtp.close();
    }
  });

  it('the token wins over a password and the plain login stays without a token', async () => {
    const smtp = await startSmtpServer();
    const withBoth = await createSmtpTransport(guarded(), {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      user: 'u',
      password: 'pw',
      accessToken: 'tok',
    });
    const plain = await createSmtpTransport(guarded(), {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      user: 'u',
      password: 'pw',
    });
    try {
      await withBoth.sendMail(mail);
      await plain.sendMail(mail);
      expect(smtp.messages[0]!.auth).toContain('Bearer tok');
      expect(smtp.messages[1]!.auth).toBe('\u0000u\u0000pw');
    } finally {
      withBoth.close();
      plain.close();
      await smtp.close();
    }
  });

  it('a private host is still refused by the guard when a token is set', async () => {
    const client = new HttpClient({ ssrf: { enabled: true, allow: [], deny: [] } });
    await expect(
      createSmtpTransport(
        { helpers: { resolveAllowedHost: (host) => client.resolveAllowedHost(host) } },
        { host: '127.0.0.1', port: 2525, secure: false, user: 'u', accessToken: 'tok' },
      ),
    ).rejects.toThrow();
  });
});
