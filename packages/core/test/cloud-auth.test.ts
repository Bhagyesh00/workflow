/**
 * P5-19 the cloud auth helpers: SigV4 against AWS's published vectors, the Google JWT bearer grant, the
 * client credentials request, the token answer, the token cache, and the helpers on the real builders.
 */
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CredentialDomainError,
  ExecutionCancelledError,
  ExecutionTimeoutError,
  type HttpRequestOptions,
} from '@workflow/workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  amzDate,
  clientCredentialsRequest,
  createCredentialHelpers,
  GOOGLE_TOKEN_URL,
  googleJwtAssertion,
  HttpClient,
  jwtBearerRequest,
  parseAccessToken,
  signAwsRequest,
  signingKey,
  TokenCache,
} from '../src';

const KEY = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const DATE = new Date('2015-08-30T12:36:00Z');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const publicKey = createPublicKey(privateKey);

function decodeJwt(jwt: string) {
  const [head, claims, signature] = jwt.split('.') as [string, string, string];
  return {
    head: JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
    valid: createVerify('RSA-SHA256')
      .update(`${head}.${claims}`)
      .verify(publicKey, Buffer.from(signature, 'base64url')),
  };
}

function fakeHttp(answer: unknown) {
  const requests: HttpRequestOptions[] = [];
  const http = {
    request: async (options: HttpRequestOptions) => {
      requests.push(options);
      return answer;
    },
  } as unknown as HttpClient;
  return { http, requests };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signature version 4 in core', () => {
  it('holds the vectors of the AWS documentation', () => {
    expect(signingKey(KEY.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
    expect(amzDate(DATE)).toBe('20150830T123600Z');
    const out = signAwsRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      region: 'us-east-1',
      service: 'service',
      date: DATE,
      ...KEY,
    });
    expect(out.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('encodes a path segment a second time, so a model id encoded once stays one segment', () => {
    const out = signAwsRequest({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude%3A1/converse',
      body: '{}',
      region: 'us-east-1',
      service: 'bedrock',
      date: DATE,
      ...KEY,
    });
    expect(out.canonicalRequest.split('\n')[1]).toBe('/model/anthropic.claude%253A1/converse');
  });
});

describe('googleJwtAssertion', () => {
  const NOW = new Date('2026-01-02T03:04:05Z');
  const seconds = Math.floor(NOW.getTime() / 1000);

  it('signs RS256 claims for the Google token URL', () => {
    const jwt = decodeJwt(googleJwtAssertion({ email: 'sa@p.iam', privateKey, scopes: ['one', 'two'] }, NOW));
    expect(jwt.valid).toBe(true);
    expect(jwt.head).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.claims).toEqual({
      iss: 'sa@p.iam',
      scope: 'one two',
      aud: GOOGLE_TOKEN_URL,
      iat: seconds,
      exp: seconds + 3600,
    });
  });

  it('names the subject and the token URL when given', () => {
    const { claims } = decodeJwt(
      googleJwtAssertion(
        { email: 'sa@p.iam', privateKey, scopes: ['one'], subject: 'me@x.test', tokenUrl: 'https://t.test/x' },
        NOW,
      ),
    );
    expect(claims.sub).toBe('me@x.test');
    expect(claims.aud).toBe('https://t.test/x');
  });

  it('takes a key whose new lines were pasted as \\n', () => {
    const pasted = privateKey.replace(/\n/g, '\\n');
    expect(decodeJwt(googleJwtAssertion({ email: 'e', privateKey: pasted, scopes: [] })).valid).toBe(true);
  });

  it('refuses a bad key with a text that holds none of it', () => {
    let message = '';
    try {
      googleJwtAssertion({ email: 'e', privateKey: 'SEEDED-NOT-A-KEY', scopes: [] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('The service account private key is not valid');
  });

  it('builds the form-encoded token request', () => {
    expect(jwtBearerRequest('a.b.c', GOOGLE_TOKEN_URL)).toMatchObject({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      bodyType: 'form-urlencoded',
      followRedirects: false,
      timeout: 30_000,
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: 'a.b.c' },
    });
  });
});

describe('clientCredentialsRequest', () => {
  const input = { tokenUrl: 'https://login.test/t', clientId: 'id', clientSecret: 'sec' };

  it('puts the client in the form by default, as Azure takes it', () => {
    const request = clientCredentialsRequest({ ...input, scope: 'https://s/.default' });
    expect(request).toMatchObject({
      url: input.tokenUrl,
      method: 'POST',
      bodyType: 'form-urlencoded',
      followRedirects: false,
      timeout: 30_000,
    });
    expect(request.body).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id',
      client_secret: 'sec',
      scope: 'https://s/.default',
    });
    expect(request.auth).toBeUndefined();
  });

  it('uses basic auth in header mode and never puts the secret in the form', () => {
    const request = clientCredentialsRequest({ ...input, authentication: 'header', resource: 'https://r' });
    expect(request.auth).toEqual({ username: 'id', password: 'sec' });
    expect(request.body).toEqual({ grant_type: 'client_credentials', resource: 'https://r' });
  });
});

describe('parseAccessToken', () => {
  it('reads the token and its lifetime, in seconds', () => {
    expect(parseAccessToken({ access_token: 'a', expires_in: 120 })).toEqual({
      token: 'a',
      expiresInSeconds: 120,
    });
    expect(parseAccessToken({ access_token: 'a', expires_in: '120' }).expiresInSeconds).toBe(120);
    expect(parseAccessToken({ access_token: 'a' }).expiresInSeconds).toBe(3600);
    expect(parseAccessToken('{"access_token":"a","expires_in":5}').expiresInSeconds).toBe(5);
  });

  it('refuses an answer with no token, and never quotes it', () => {
    for (const body of [{ error: 'SEEDED-SECRET' }, 'SEEDED-SECRET', null, 7, { access_token: '' }]) {
      let message = '';
      try {
        parseAccessToken(body);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe('The token answer holds no access token');
    }
  });
});

describe('TokenCache', () => {
  const token = (value: string, expiresInSeconds = 3600) => ({ token: value, expiresInSeconds });

  it('fetches once per secret and scope', async () => {
    const cache = new TokenCache();
    const fetch = vi.fn(async () => token('a'));
    expect(await cache.get('s', 'scope', fetch)).toBe('a');
    expect(await cache.get('s', 'scope', fetch)).toBe('a');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never gives one secret the token of another, nor one scope the token of another', async () => {
    const cache = new TokenCache();
    expect(await cache.get('s1', 'scope', async () => token('a'))).toBe('a');
    expect(await cache.get('s2', 'scope', async () => token('b'))).toBe('b');
    expect(await cache.get('s1', 'other', async () => token('c'))).toBe('c');
    expect(await cache.get('s1', 'scope', async () => token('z'))).toBe('a');
  });

  it('keeps secret and scope apart: moving text between them is another key', async () => {
    const cache = new TokenCache();
    expect(await cache.get('ab', 'c', async () => token('a'))).toBe('a');
    expect(await cache.get('a', 'bc', async () => token('b'))).toBe('b');
  });

  it('fetches again 60 s before the token expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const cache = new TokenCache();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return token(`t${calls}`, 120);
    };
    expect(await cache.get('s', 'x', fetch)).toBe('t1');
    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
    expect(await cache.get('s', 'x', fetch)).toBe('t1');
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    expect(await cache.get('s', 'x', fetch)).toBe('t2');
    expect(calls).toBe(2);
  });

  it('holds 1000 entries, the oldest goes first', async () => {
    const cache = new TokenCache();
    for (let i = 0; i <= 1000; i += 1) await cache.get(`s${i}`, 'x', async () => token(`t${i}`));
    expect(await cache.get('s1000', 'x', async () => token('new'))).toBe('t1000');
    expect(await cache.get('s1', 'x', async () => token('new'))).toBe('t1');
    expect(await cache.get('s0', 'x', async () => token('new'))).toBe('new');
  });

  it('keys by sha256: neither the secret nor the scope is held in the key', async () => {
    const cache = new TokenCache();
    await cache.get('SEEDED-SECRET', 'SEEDED-SCOPE', async () => token('a'));
    const keys = [...(cache as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not keep a failed fetch, and one fetch serves callers that wait together', async () => {
    const cache = new TokenCache();
    await expect(
      cache.get('s', 'x', async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    const fetch = vi.fn(async () => token('a'));
    const both = await Promise.all([cache.get('s', 'x', fetch), cache.get('s', 'x', fetch)]);
    expect(both).toEqual(['a', 'a']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a waiter fetches for itself when the run that owns the fetch is stopped', async () => {
    const reasons = [
      new ExecutionCancelledError('Execution was stopped'),
      new ExecutionTimeoutError(5),
      new DOMException('This operation was aborted', 'AbortError'),
    ];
    for (const reason of reasons) {
      const cache = new TokenCache();
      let stop = (_reason: unknown) => {};
      const owner = cache.get(
        's',
        'x',
        () =>
          new Promise((_resolve, reject) => {
            stop = reject;
          }),
      );
      const own = vi.fn(async () => token('own'));
      const waiters = [cache.get('s', 'x', own), cache.get('s', 'x', own)];
      stop(reason);
      await expect(owner).rejects.toBe(reason);
      expect(await Promise.all(waiters)).toEqual(['own', 'own']);
      expect(own).toHaveBeenCalledTimes(1);
    }
  });

  it('a run that nobody stopped gets its token when the run that owns the fetch is stopped', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      req.resume();
      // the first call hangs until the run that made it is stopped
      if (calls === 1) return;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'second' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });
    try {
      const tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
      const stopped = new AbortController();
      const asRun = (signal?: AbortSignal) => {
        const helpers = createCredentialHelpers(client, undefined, signal);
        return helpers.cachedToken('stop-secret', 'stop-scope', () =>
          helpers.clientCredentialsToken({ tokenUrl, clientId: 'i', clientSecret: 's' }),
        );
      };
      const first = asRun(stopped.signal);
      const second = asRun();
      await vi.waitFor(() => expect(calls).toBe(1));
      const reason = new ExecutionCancelledError('Execution was stopped');
      stopped.abort(reason);
      await expect(first).rejects.toBe(reason);
      await expect(second).resolves.toBe('second');
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('a waiter shares a real failure of the fetch, with no second call', async () => {
    const cache = new TokenCache();
    let fail = (_reason: unknown) => {};
    const owner = cache.get(
      's',
      'x',
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const own = vi.fn(async () => token('own'));
    const waiter = cache.get('s', 'x', own);
    fail(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(owner).rejects.toThrow('timed out');
    await expect(waiter).rejects.toThrow('timed out');
    expect(own).not.toHaveBeenCalled();
  });
});

describe('createCredentialHelpers on the real builders', () => {
  it('mints a client credentials token through the guarded client', async () => {
    const { http, requests } = fakeHttp({ access_token: 'tok', expires_in: 60 });
    const helpers = createCredentialHelpers(http, ['login.test']);
    const answer = await helpers.clientCredentialsToken({
      tokenUrl: 'https://login.test/t',
      clientId: 'i',
      clientSecret: 's',
    });
    expect(answer).toEqual({ token: 'tok', expiresInSeconds: 60 });
    expect(requests[0]?.allowedDomains).toEqual(['login.test']);
  });

  it('mints a Google token at the fixed URL', async () => {
    const { http, requests } = fakeHttp({ access_token: 'tok' });
    const helpers = createCredentialHelpers(http, undefined);
    await helpers.jwtBearerToken({ email: 'e', privateKey, scopes: ['s'] });
    expect(requests[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(decodeJwt(String((requests[0]?.body as { assertion: string }).assertion)).valid).toBe(true);
  });

  it('refuses a token host outside the allowed domains before any call', async () => {
    const { http, requests } = fakeHttp({ access_token: 'tok' });
    const helpers = createCredentialHelpers(http, ['other.test']);
    await expect(helpers.jwtBearerToken({ email: 'e', privateKey, scopes: ['s'] })).rejects.toBeInstanceOf(
      CredentialDomainError,
    );
    expect(requests).toHaveLength(0);
  });
});
