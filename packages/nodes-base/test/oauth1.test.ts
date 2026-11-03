import { createHmac } from 'node:crypto';
import type { DataObject } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { oAuth1Api } from '../src/credentials/oauth1.credentials';
import { oauth1BaseString, parseOAuthResponse, signOAuth1Request } from '../src/utils/oauth1';
import { runNode } from './harness';
import { json, localHttp, startHttpServer } from './servers';

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

describe('OAuth1 signer against the spec examples', () => {
  it('builds the RFC 5849 section 3.4.1 base string', () => {
    const base = oauth1BaseString({
      method: 'POST',
      url: 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      bodyFields: [
        ['c2', ''],
        ['a3', '2 q'],
      ],
      oauth: {
        oauth_consumer_key: '9djdj82h48djs9d2',
        oauth_token: 'kkk9d7dh3k39sjv7',
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: '137131201',
        oauth_nonce: '7d8f3e4a',
      },
    });
    // copied from RFC 5849 section 3.4.1.1 (checked against the RFC text, 2026-11-03)
    expect(base).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q' +
        '%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_' +
        'key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m' +
        'ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk' +
        '9d7dh3k39sjv7',
    );
  });

  it('signs the RFC request through signOAuth1Request (query and form body both signed)', () => {
    const out = signOAuth1Request(
      {
        url: 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
        method: 'POST',
        bodyType: 'form-urlencoded',
        body: { c2: '', a3: '2 q' },
      },
      {
        consumerKey: '9djdj82h48djs9d2',
        consumerSecret: 'j49sk3j29djd',
        token: 'kkk9d7dh3k39sjv7',
        tokenSecret: 'dh893hdasih9',
        nonce: '7d8f3e4a',
        timestamp: 137131201,
      },
    );
    const base = oauth1BaseString({
      method: 'POST',
      url: 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b',
      bodyFields: [
        ['c2', ''],
        ['a3', '2 q'],
      ],
      oauth: {
        oauth_consumer_key: '9djdj82h48djs9d2',
        oauth_token: 'kkk9d7dh3k39sjv7',
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: '137131201',
        oauth_nonce: '7d8f3e4a',
        oauth_version: '1.0',
      },
    });
    // version is signed too, so recompute with it
    const sig = createHmac('sha1', `${enc('j49sk3j29djd')}&${enc('dh893hdasih9')}`)
      .update(base)
      .digest('base64');
    expect(String(out.headers?.Authorization)).toContain(`oauth_signature="${enc(sig)}"`);
  });

  it('drops the default port and lower-cases the host in the base string URI (RFC 3.4.1.2)', () => {
    const uri = (url: string) =>
      oauth1BaseString({ method: 'get', url, bodyFields: [], oauth: {} }).split('&')[1];
    expect(uri('HTTP://EXAMPLE.COM:80/r%20v/X?id=123')).toBe('http%3A%2F%2Fexample.com%2Fr%2520v%2FX');
    expect(uri('https://www.example.net:8080/?q=1')).toBe('https%3A%2F%2Fwww.example.net%3A8080%2F');
    expect(uri('https://a.example.com:443')).toBe('https%3A%2F%2Fa.example.com%2F');
  });

  it('reproduces the Twitter documentation signature', () => {
    const request = signOAuth1Request(
      {
        url: 'https://api.twitter.com/1/statuses/update.json?include_entities=true',
        method: 'POST',
        bodyType: 'form-urlencoded',
        body: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
      },
      {
        consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
        consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
        token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
        tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
        nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
        timestamp: 1318622958,
      },
    );
    const header = String(request.headers?.Authorization);
    expect(header).toContain('oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D"');
    expect(header).toContain('oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"');
    expect(header).toContain('oauth_version="1.0"');
  });

  it('signs with SHA-256 and SHA-512 over the same base string', () => {
    for (const [method, algo] of [
      ['HMAC-SHA256', 'sha256'],
      ['HMAC-SHA512', 'sha512'],
    ] as const) {
      const url = 'https://h.example/p?a=1';
      const header = String(
        signOAuth1Request(
          { url, method: 'GET' },
          {
            consumerKey: 'ck',
            consumerSecret: 'cs&x',
            token: 'tk',
            tokenSecret: 'ts',
            signatureMethod: method,
            nonce: 'n1',
            timestamp: 1,
          },
        ).headers?.Authorization,
      );
      const base = oauth1BaseString({
        method: 'GET',
        url,
        bodyFields: [],
        oauth: {
          oauth_consumer_key: 'ck',
          oauth_token: 'tk',
          oauth_signature_method: method,
          oauth_timestamp: '1',
          oauth_nonce: 'n1',
          oauth_version: '1.0',
        },
      });
      const expected = createHmac(algo, `${enc('cs&x')}&${enc('ts')}`)
        .update(base)
        .digest('base64');
      expect(header).toContain(`oauth_signature="${enc(expected)}"`);
      expect(header).toContain(`oauth_signature_method="${method}"`);
    }
  });

  it('merges qs into the URL, keeps user headers, sends the callback in the header', () => {
    const out = signOAuth1Request(
      {
        url: 'https://h.example/p',
        qs: { b: '2 3', a: ['x', 'y'] },
        headers: { 'X-Mine': '1', authorization: 'old' },
      },
      {
        consumerKey: 'ck',
        consumerSecret: 'cs',
        callback: 'https://app/cb?state=s',
        nonce: 'n',
        timestamp: 5,
      },
    );
    expect(out.qs).toBeUndefined();
    expect(out.url).toBe('https://h.example/p?b=2+3&a=x&a=y');
    expect(out.headers?.['X-Mine']).toBe('1');
    expect(Object.keys(out.headers ?? {}).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
    expect(String(out.headers?.Authorization)).toContain(`oauth_callback="${enc('https://app/cb?state=s')}"`);
    expect(String(out.headers?.Authorization)).not.toContain('oauth_token=');
  });

  it('parses a token response', () => {
    expect(
      parseOAuthResponse('oauth_token=a%2Bb&oauth_token_secret=s&oauth_callback_confirmed=true'),
    ).toEqual({ oauth_token: 'a+b', oauth_token_secret: 's', oauth_callback_confirmed: 'true' });
  });
});

describe('HTTP Request with an OAuth1 credential', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;
  const CK = 'consumer';
  const CS = 'csecret';
  const TK = 'tok';
  const TS = 'tsecret';
  beforeAll(async () => {
    server = await startHttpServer((req, res) => {
      // the server recomputes the signature from what it received, with its own arithmetic
      const header = String(req.headers.authorization ?? '');
      const f: Record<string, string> = {};
      for (const m of header.slice(6).matchAll(/(\w+)="([^"]*)"/g)) f[m[1]] = decodeURIComponent(m[2]);
      const params: Array<[string, string]> = [];
      const u = new URL(req.url, 'http://x');
      for (const [k, v] of u.searchParams) params.push([k, v]);
      if ((req.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) {
        for (const [k, v] of new URLSearchParams(req.body.toString())) params.push([k, v]);
      }
      for (const [k, v] of Object.entries(f)) if (k !== 'oauth_signature') params.push([k, v]);
      const norm = params
        .map(([k, v]) => [enc(k), enc(v)])
        .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const base = `${req.method}&${enc(`${server.url}${u.pathname}`)}&${enc(norm)}`;
      const sig = createHmac('sha1', `${enc(CS)}&${enc(TS)}`)
        .update(base)
        .digest('base64');
      const ok = f.oauth_signature === sig && f.oauth_token === TK && f.oauth_consumer_key === CK;
      return json(res, { ok, mine: req.headers['x-mine'] ?? null }, ok ? 200 : 401);
    });
  });
  afterAll(async () => server.close());

  const run = (params: DataObject, creds: DataObject) =>
    runNode(
      'core.httpRequest',
      { authentication: 'genericCredentialType', genericAuthType: 'oAuth1Api', ...params },
      [{ json: {} }],
      { services: { http: localHttp() }, creds: { oAuth1Api: creds } },
    );
  const connected = {
    consumerKey: CK,
    consumerSecret: CS,
    signatureMethod: 'HMAC-SHA1',
    oauthTokenData: { oauth_token: TK, oauth_token_secret: TS },
  };

  it('sends a signature the server can verify, with query parameters and user headers', async () => {
    const out = await run(
      {
        url: `${server.url}/things?x=1`,
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'y', value: 'a b' }] },
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Mine', value: 'yes' }] },
      },
      connected,
    );
    expect(out.outputs[0][0]).toMatchObject({ ok: true, mine: 'yes' });
  });

  it('signs a form body', async () => {
    const out = await run(
      {
        url: `${server.url}/post`,
        method: 'POST',
        sendBody: true,
        contentType: 'form-urlencoded',
        bodyParameters: { parameters: [{ name: 'status', value: 'Hi + there!' }] },
      },
      connected,
    );
    expect(out.outputs[0][0]).toMatchObject({ ok: true });
  });

  it('signs exactly the form pairs the client sends: null, nested objects, arrays, and no body on GET', async () => {
    const http = localHttp();
    const keys = { consumerKey: CK, consumerSecret: CS, token: TK, tokenSecret: TS };
    const requests = [
      {
        url: `${server.url}/post`,
        method: 'POST' as const,
        bodyType: 'form-urlencoded' as const,
        body: { a: null, b: { c: 1 }, d: [1, 2], e: undefined, f: 'x y' },
      },
      {
        url: `${server.url}/get`,
        method: 'GET' as const,
        bodyType: 'form-urlencoded' as const,
        body: { a: '1' },
      },
    ];
    for (const request of requests) {
      const answer = (await http.request(signOAuth1Request(request, keys))) as DataObject;
      expect(answer, request.method).toMatchObject({ ok: true });
    }
  });

  it('says the credential is not connected when there is no token data', async () => {
    const out = await run({ url: `${server.url}/things` }, { ...connected, oauthTokenData: {} });
    expect(out.status).toBe('error');
    expect(String(out.error?.message)).toMatch(/not connected/i);
  });
});

describe('oAuth1Api credential', () => {
  it('has the n8n fields and a hidden token store', () => {
    const names = oAuth1Api.properties.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'authUrl',
        'accessTokenUrl',
        'requestTokenUrl',
        'consumerKey',
        'consumerSecret',
        'signatureMethod',
        'oauthTokenData',
      ]),
    );
    expect(oAuth1Api.properties.find((p) => p.name === 'oauthTokenData')?.type).toBe('hidden');
    expect(oAuth1Api.properties.find((p) => p.name === 'consumerSecret')?.typeOptions).toMatchObject({
      password: true,
    });
  });
});
