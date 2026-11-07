import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialDomainError } from '@workflow/workflow';
import { type RequestInit, Response } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpClient, requestOAuth2Token } from '../src';
import { fetchWithCredentialDomains, type SendRequest } from '../src/http/credential-redirects';

const redirect = (status: number, location?: string) =>
  new Response(null, { status, headers: location ? { location } : {} });
const ok = () => new Response('done', { status: 200 });

/** a send function that answers from a script and records what it was asked */
function scripted(replies: Response[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const send: SendRequest = vi.fn(async (url, init) => {
    calls.push({ url: url.toString(), init });
    const next = replies.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  return { send, calls };
}

const headersOf = (init: RequestInit) => new Headers(init.headers as Array<[string, string]>);
const base = (extra: Partial<RequestInit> = {}): RequestInit => ({
  method: 'GET',
  headers: [['user-agent', 'test']],
  redirect: 'follow',
  ...extra,
});

describe('fetchWithCredentialDomains', () => {
  it('refuses the first URL with zero requests', async () => {
    const { send, calls } = scripted([ok()]);
    await expect(
      fetchWithCredentialDomains(new URL('https://evil.test/x'), base(), ['api.example.com'], send),
    ).rejects.toBeInstanceOf(CredentialDomainError);
    expect(calls).toHaveLength(0);
  });

  it('sends every hop with redirect: manual and returns the final response', async () => {
    const { send, calls } = scripted([
      redirect(302, 'https://b.example.com/two'),
      redirect(302, '/three'),
      ok(),
    ]);
    const res = await fetchWithCredentialDomains(
      new URL('https://a.example.com/one'),
      base(),
      ['a.example.com', 'b.example.com'],
      send,
    );
    expect(await res.text()).toBe('done');
    expect(calls.map((c) => c.url)).toEqual([
      'https://a.example.com/one',
      'https://b.example.com/two',
      'https://b.example.com/three',
    ]);
    expect(calls.every((c) => c.init.redirect === 'manual')).toBe(true);
  });

  it('refuses a hop outside the list before it is requested', async () => {
    const { send, calls } = scripted([redirect(302, 'https://evil.test/collect'), ok()]);
    await expect(
      fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), ['a.example.com'], send),
    ).rejects.toThrow(/Domain not allowed: .* evil\.test/);
    expect(calls).toHaveLength(1);
  });

  it('re-checks a wildcard list on every hop (the bare domain is not a subdomain)', async () => {
    const { send, calls } = scripted([redirect(301, 'https://example.com/'), ok()]);
    await expect(
      fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), ['*.example.com'], send),
    ).rejects.toBeInstanceOf(CredentialDomainError);
    expect(calls).toHaveLength(1);
  });

  it.each([301, 302, 303])('%i turns a POST into a GET without a body', async (status) => {
    const { send, calls } = scripted([redirect(status, '/next'), ok()]);
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base({
        method: 'POST',
        body: 'payload',
        headers: [
          ['content-type', 'text/plain'],
          ['content-length', '7'],
          ['x-keep', '1'],
        ],
      }),
      ['a.example.com'],
      send,
    );
    expect(calls[1].init.method).toBe('GET');
    expect(calls[1].init.body).toBeUndefined();
    const headers = headersOf(calls[1].init);
    expect(headers.get('content-type')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('x-keep')).toBe('1');
  });

  it.each([307, 308])('%i keeps the method and the body', async (status) => {
    const { send, calls } = scripted([redirect(status, '/next'), ok()]);
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base({ method: 'POST', body: 'payload', headers: [['content-type', 'text/plain']] }),
      ['a.example.com'],
      send,
    );
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.body).toBe('payload');
    expect(headersOf(calls[1].init).get('content-type')).toBe('text/plain');
  });

  it('303 keeps HEAD and 301/302 keep PUT', async () => {
    const head = scripted([redirect(303, '/next'), ok()]);
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base({ method: 'HEAD' }),
      ['a.example.com'],
      head.send,
    );
    expect(head.calls[1].init.method).toBe('HEAD');
    const put = scripted([redirect(302, '/next'), ok()]);
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base({ method: 'PUT', body: 'x' }),
      ['a.example.com'],
      put.send,
    );
    expect(put.calls[1].init.method).toBe('PUT');
    expect(put.calls[1].init.body).toBe('x');
  });

  it('drops Authorization (and cookies) on a cross-origin hop, keeps them on the same origin', async () => {
    const sameOrigin = scripted([redirect(302, '/next'), ok()]);
    const init = base({
      headers: [
        ['authorization', 'Bearer T'],
        ['cookie', 'a=b'],
        ['x-api-key', 'K'],
      ],
    });
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      init,
      ['*.example.com', 'a.example.com'],
      sameOrigin.send,
    );
    expect(headersOf(sameOrigin.calls[1].init).get('authorization')).toBe('Bearer T');

    const cross = scripted([redirect(302, 'https://b.example.com/'), ok()]);
    await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      init,
      ['*.example.com', 'a.example.com'],
      cross.send,
    );
    const headers = headersOf(cross.calls[1].init);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    // the credential's other headers stay: the list says this host may receive the credential
    expect(headers.get('x-api-key')).toBe('K');

    // a different port or scheme is another origin
    const port = scripted([redirect(302, 'https://a.example.com:8443/'), ok()]);
    await fetchWithCredentialDomains(new URL('https://a.example.com/'), init, ['a.example.com'], port.send);
    expect(headersOf(port.calls[1].init).get('authorization')).toBeNull();
  });

  it('stops after 20 hops, or after maxRedirects', async () => {
    const endless = () => Array.from({ length: 40 }, () => redirect(302, '/again'));
    const twenty = scripted(endless());
    await expect(
      fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), ['a.example.com'], twenty.send),
    ).rejects.toThrow(/redirect/i);
    expect(twenty.calls).toHaveLength(21);

    const three = scripted(endless());
    await expect(
      fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), ['a.example.com'], three.send, {
        maxRedirects: 3,
      }),
    ).rejects.toThrow(/redirect/i);
    expect(three.calls).toHaveLength(4);
  });

  it('returns a redirect as it is when the request does not follow redirects, after the first check', async () => {
    const { send, calls } = scripted([redirect(302, 'https://evil.test/')]);
    const res = await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base({ redirect: 'manual' }),
      ['a.example.com'],
      send,
    );
    expect(res.status).toBe(302);
    expect(calls).toHaveLength(1);
    await expect(
      fetchWithCredentialDomains(
        new URL('https://evil.test/'),
        base({ redirect: 'manual' }),
        ['a.example.com'],
        send,
      ),
    ).rejects.toBeInstanceOf(CredentialDomainError);
  });

  it('returns a 3xx without a Location (or a 304) as the response', async () => {
    const { send } = scripted([redirect(300), redirect(304, '/x')]);
    const list = ['a.example.com'];
    const first = await fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), list, send);
    expect(first.status).toBe(300);
    const second = await fetchWithCredentialDomains(new URL('https://a.example.com/'), base(), list, send);
    expect(second.status).toBe(304);
  });

  it('refuses a Location that is not a URL, without echoing it', async () => {
    const { send } = scripted([redirect(302, 'http://[bad/secret')]);
    const error = await fetchWithCredentialDomains(
      new URL('https://a.example.com/'),
      base(),
      ['a.example.com'],
      send,
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('HttpClient with allowedDomains against real servers', () => {
  const hits = { origin: 0, target: 0, other: 0 };
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  let origin: http.Server;
  let target: http.Server;
  let other: http.Server;
  let originPort = 0;
  let targetPort = 0;
  let otherPort = 0;

  const listen = (server: http.Server, host: string) =>
    new Promise<number>((resolve) =>
      server.listen(0, host, () => resolve((server.address() as AddressInfo).port)),
    );
  const close = (server: http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      hits.target++;
      seen.push(req.headers);
      res.end('TARGET');
    });
    other = http.createServer((_req, res) => {
      hits.other++;
      res.end('OTHER');
    });
    targetPort = await listen(target, '127.0.0.2');
    otherPort = await listen(other, '127.0.0.3');
    origin = http.createServer((req, res) => {
      hits.origin++;
      const to: Record<string, string> = {
        '/to-target': `http://127.0.0.2:${targetPort}/in`,
        '/to-other': `http://127.0.0.3:${otherPort}/in`,
        '/via-target': `http://127.0.0.2:${targetPort}/in`,
      };
      if (to[req.url ?? '']) {
        res.writeHead(302, { location: to[req.url ?? ''] });
        res.end();
      } else if (req.url === '/token-307') {
        res.writeHead(307, { location: `http://127.0.0.3:${otherPort}/in` });
        res.end();
      } else res.end('ORIGIN');
    });
    originPort = await listen(origin, '127.0.0.1');
  });
  afterAll(async () => {
    await Promise.all([close(origin), close(target), close(other)]);
  });

  const client = () => new HttpClient({ ssrf: { allow: ['127.0.0.1', '127.0.0.2', '127.0.0.3'] } });
  const reset = () => {
    hits.target = 0;
    hits.other = 0;
    seen.length = 0;
  };

  it('refuses a first URL outside the list with zero requests at that server', async () => {
    reset();
    const c = client();
    try {
      await expect(
        c.request({ url: `http://127.0.0.2:${targetPort}/in`, allowedDomains: ['127.0.0.1'] }),
      ).rejects.toBeInstanceOf(CredentialDomainError);
      expect(hits.target).toBe(0);
    } finally {
      await c.close();
    }
  });

  it('refuses a redirect to another domain with zero requests at the blocked server', async () => {
    reset();
    const c = client();
    try {
      await expect(
        c.request({
          url: `http://127.0.0.1:${originPort}/to-other`,
          allowedDomains: ['127.0.0.1', '127.0.0.2'],
        }),
      ).rejects.toThrow(/Domain not allowed: .* 127\.0\.0\.3/);
      expect(hits.other).toBe(0);
    } finally {
      await c.close();
    }
  });

  it('follows a redirect to a listed domain and drops Authorization on the way', async () => {
    reset();
    const c = client();
    try {
      const body = await c.request({
        url: `http://127.0.0.1:${originPort}/to-target`,
        headers: { authorization: 'Bearer SECRET' },
        allowedDomains: ['127.0.0.1', '127.0.0.2'],
      });
      expect(body).toBe('TARGET');
      expect(seen[0].authorization).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  it("keeps today's path without a list: the redirect is followed and the header travels as fetch decides", async () => {
    reset();
    const c = client();
    try {
      expect(await c.request({ url: `http://127.0.0.1:${originPort}/to-other` })).toBe('OTHER');
      expect(hits.other).toBe(1);
    } finally {
      await c.close();
    }
  });

  it('returns the 302 itself when followRedirects is off, never visiting the other server', async () => {
    reset();
    const c = client();
    try {
      const res = (await c.request({
        url: `http://127.0.0.1:${originPort}/to-other`,
        allowedDomains: ['127.0.0.1'],
        followRedirects: false,
        returnFullResponse: true,
      })) as { statusCode: number };
      expect(res.statusCode).toBe(302);
      expect(hits.other).toBe(0);
    } finally {
      await c.close();
    }
  });

  it('sends the refresh token and the secret to no other host when a token URL answers 307', async () => {
    const c = client();
    try {
      for (const domains of [
        {},
        { allowedHttpRequestDomains: 'domains', allowedDomains: '127.0.0.1,127.0.0.3' },
      ]) {
        reset();
        await expect(
          requestOAuth2Token(
            c,
            {
              accessTokenUrl: `http://127.0.0.1:${originPort}/token-307`,
              clientId: 'id',
              clientSecret: 'secret',
              authentication: 'body',
              ...domains,
            },
            { type: 'refresh_token', refreshToken: 'REFRESH' },
          ),
        ).rejects.toThrow('did not contain an access_token');
        expect(hits.other).toBe(0);
      }
    } finally {
      await c.close();
    }
  });

  it('still applies the SSRF policy to a hop that is on the list', async () => {
    reset();
    // 127.0.0.3 is on the credential list but not allowed by the SSRF policy
    const c = new HttpClient({ ssrf: { allow: ['127.0.0.1', '127.0.0.2'] } });
    try {
      await expect(
        c.request({
          url: `http://127.0.0.1:${originPort}/to-other`,
          allowedDomains: ['127.0.0.1', '127.0.0.3'],
        }),
      ).rejects.toThrow(/blocked/i);
      expect(hits.other).toBe(0);
    } finally {
      await c.close();
    }
  });
});
