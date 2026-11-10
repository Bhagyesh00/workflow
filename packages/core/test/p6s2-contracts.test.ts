/** Phase 6 S2 contract step, C0a: `HttpClient.asFetch`, `doNotInherit`, and the OAuth2 token decrypt hook. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CredentialGateHelper,
  CredentialType,
  DataObject,
  HttpRequestOptions,
} from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CredentialTypes,
  type ExecutionServices,
  HttpClient,
  type OAuth2Data,
  type OAuthTokenDecrypt,
  oauth2Request,
  requestOAuth2Token,
  SsrfBlockedError,
} from '../src';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('HttpClient.asFetch', () => {
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${port}/target` });
      res.end();
    } else if (req.url === '/echo') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, body, ua: req.headers['user-agent'] }));
      });
    } else res.end('target');
  });

  beforeAll(async () => {
    port = await listen(server);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('refuses a private host with the SsrfBlockedError', async () => {
    const client = new HttpClient();
    try {
      await expect(client.asFetch()(`http://127.0.0.1:${port}/echo`)).rejects.toThrow(SsrfBlockedError);
    } finally {
      await client.close();
    }
  });

  it('returns a redirect to the caller and does not follow it', async () => {
    // `allow: ['localhost']` stands in for a public host that passes the policy
    const client = new HttpClient({ ssrf: { allow: ['localhost'] } });
    try {
      const response = await client.asFetch()(`http://localhost:${port}/redirect`);
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`http://localhost:${port}/target`);
      expect(response.url).toBe(`http://localhost:${port}/redirect`);
    } finally {
      await client.close();
    }
  });

  it('sends the method, body and headers of a call, and of a Request', async () => {
    const client = new HttpClient({ ssrf: { allow: ['localhost'] } });
    try {
      const guarded = client.asFetch();
      const plain = await guarded(`http://localhost:${port}/echo`, { method: 'POST', body: 'a=1' });
      expect(await plain.json()).toEqual({ method: 'POST', body: 'a=1', ua: 'workflow-platform/0.1' });
      const request = new Request(`http://localhost:${port}/echo`, {
        method: 'PUT',
        body: 'b=2',
        headers: { 'user-agent': 'library/1' },
      });
      expect(await (await guarded(request)).json()).toEqual({ method: 'PUT', body: 'b=2', ua: 'library/1' });
    } finally {
      await client.close();
    }
  });
});

describe('doNotInherit', () => {
  const field = (name: string, extra: Partial<CredentialType['properties'][number]> = {}) => ({
    displayName: name,
    name,
    type: 'string' as const,
    default: '',
    ...extra,
  });
  const parent: CredentialType = {
    name: 'parentApi',
    displayName: 'Parent',
    properties: [field('shared'), field('ownOnly', { doNotInherit: true })],
  };
  const child: CredentialType = {
    name: 'childApi',
    displayName: 'Child',
    extends: ['parentApi'],
    properties: [field('childField')],
  };
  const grandchild: CredentialType = {
    name: 'grandchildApi',
    displayName: 'Grandchild',
    extends: ['childApi'],
    properties: [],
  };

  it('keeps the property on the parent and drops it for every child type', () => {
    const types = new CredentialTypes([parent, child, grandchild]);
    expect(types.getResolved('parentApi')?.properties.map((p) => p.name)).toEqual(['shared', 'ownOnly']);
    expect(types.getResolved('childApi')?.properties.map((p) => p.name)).toEqual(['shared', 'childField']);
    expect(types.getResolved('grandchildApi')?.properties.map((p) => p.name)).toEqual([
      'shared',
      'childField',
    ]);
  });
});

describe('OAuth2 token decrypt hook', () => {
  /** an HttpClient whose token endpoint answers `{ sealed }` and whose API answers `{ ok: true }` */
  function fakeHttp() {
    const sent: HttpRequestOptions[] = [];
    const request = vi.fn(async (options: HttpRequestOptions) => {
      sent.push(options);
      return options.url.endsWith('/token') ? { sealed: 'tok-new', expires_in: 3600 } : { ok: true };
    });
    return { client: { request } as unknown as HttpClient, sent };
  }
  const decrypt = vi.fn<OAuthTokenDecrypt>(async (token) => ({
    access_token: token.sealed,
    refresh_token: 'r2',
  }));
  const base = (extra: Partial<OAuth2Data> = {}): OAuth2Data => ({
    grantType: 'authorizationCode',
    clientId: 'id',
    clientSecret: 'secret',
    accessTokenUrl: 'https://idp.example.com/token',
    ...extra,
  });
  const api: HttpRequestOptions = { url: 'https://api.example.com/me' };

  it('runs on the token answer before the access_token check', async () => {
    const http = fakeHttp();
    decrypt.mockClear();
    const token = await requestOAuth2Token(
      http.client,
      base(),
      { type: 'client_credentials' },
      undefined,
      decrypt,
    );
    expect(token.access_token).toBe('tok-new');
    expect(decrypt).toHaveBeenCalledWith({ sealed: 'tok-new', expires_in: 3600 }, base());
    // without the hook the sealed answer has no access_token
    await expect(requestOAuth2Token(http.client, base(), { type: 'client_credentials' })).rejects.toThrow(
      'did not contain an access_token',
    );
  });

  it('runs on a refresh in oauth2Request', async () => {
    const http = fakeHttp();
    const saved: OAuth2Data[] = [];
    decrypt.mockClear();
    const data = base({
      oauthTokenData: { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1 },
    });
    const answer = await oauth2Request(
      http.client,
      data,
      api,
      async (d) => void saved.push(d),
      undefined,
      decrypt,
    );
    expect(answer).toEqual({ ok: true });
    expect(decrypt).toHaveBeenCalledOnce();
    expect(saved[0]?.oauthTokenData?.access_token).toBe('tok-new');
    expect(http.sent.at(-1)?.headers).toMatchObject({ authorization: 'Bearer tok-new' });
  });

  it('runs on client credentials in oauth2Request', async () => {
    const http = fakeHttp();
    decrypt.mockClear();
    const data = base({ grantType: 'clientCredentials' });
    await oauth2Request(http.client, data, api, async () => {}, undefined, decrypt);
    expect(decrypt).toHaveBeenCalledOnce();
    expect(http.sent.at(-1)?.headers).toMatchObject({ authorization: 'Bearer tok-new' });
  });

  it('lets its throw reach the caller and sends no API call', async () => {
    const http = fakeHttp();
    const refuse: OAuthTokenDecrypt = async () => {
      throw new Error('plain token refused');
    };
    const data = base({ grantType: 'clientCredentials' });
    await expect(oauth2Request(http.client, data, api, async () => {}, undefined, refuse)).rejects.toThrow(
      'plain token refused',
    );
    expect(http.sent.every((o) => o.url.endsWith('/token'))).toBe(true);
  });

  it('leaves the token answer as it is when no hook is set', async () => {
    const plain = { request: vi.fn(async () => ({ access_token: 'plain' })) } as unknown as HttpClient;
    const token = await requestOAuth2Token(plain, base(), { type: 'client_credentials' });
    expect(token.access_token).toBe('plain');
  });

  it('types the services seams', () => {
    expectTypeOf<ExecutionServices['oauthTokenDecrypt']>().toEqualTypeOf<
      ((token: DataObject, data: DataObject) => Promise<DataObject>) | undefined
    >();
    expectTypeOf<ExecutionServices['credentialGate']>().toEqualTypeOf<CredentialGateHelper | undefined>();
  });
});
