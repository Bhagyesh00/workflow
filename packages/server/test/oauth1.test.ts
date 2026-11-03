import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, TEST_REDIS, TestClient, type TestServer } from './helpers';

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; method: string; headers: IncomingMessage['headers']; body: string }> =
  [];

/** the provider's own check of a signed request (its own arithmetic, HMAC-SHA1) */
function oauthFields(header: string | undefined): Record<string, string> {
  const f: Record<string, string> = {};
  for (const m of (header ?? '').slice(6).matchAll(/(\w+)="([^"]*)"/g)) f[m[1]] = decodeURIComponent(m[2]);
  return f;
}
function signatureOk(
  req: { url: string; method: string; headers: IncomingMessage['headers']; body: string },
  tokenSecret: string,
) {
  const f = oauthFields(req.headers.authorization);
  const params: Array<[string, string]> = [];
  const u = new URL(req.url, remoteUrl);
  for (const [k, v] of u.searchParams) params.push([k, v]);
  if (String(req.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(req.body)) params.push([k, v]);
  }
  for (const [k, v] of Object.entries(f)) if (k !== 'oauth_signature') params.push([k, v]);
  const norm = params
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = `${req.method}&${enc(`${remoteUrl}${u.pathname}`)}&${enc(norm)}`;
  const sig = createHmac('sha1', `${enc('consumer-secret')}&${enc(tokenSecret)}`)
    .update(base)
    .digest('base64');
  return f.oauth_signature === sig && f.oauth_consumer_key === 'consumer-1';
}

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const entry = { url: req.url ?? '', method: req.method ?? 'GET', headers: req.headers, body };
      received.push(entry);
      if (req.url === '/request_token') {
        if (!signatureOk(entry, '')) return void res.writeHead(401).end('bad signature');
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
        res.end('oauth_token=rt-1&oauth_token_secret=rs-1&oauth_callback_confirmed=true');
        return;
      }
      if (req.url === '/access_token') {
        const f = oauthFields(req.headers.authorization);
        if (f.oauth_token !== 'rt-1' || !signatureOk(entry, 'rs-1')) {
          return void res.writeHead(401).end('bad signature');
        }
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
        res.end(`oauth_token=at-${f.oauth_verifier}&oauth_token_secret=as-1&user_id=7`);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
  remoteUrl = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await server.close();
  await new Promise((r) => remote.close(r));
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  received.length = 0;
});

async function makeCredential(client: TestClient) {
  return client.data(
    client.post('/rest/credentials', {
      name: 'OAuth1 provider',
      type: 'oAuth1Api',
      data: {
        requestTokenUrl: `${remoteUrl}/request_token`,
        authUrl: 'https://auth.example.com/authorize',
        accessTokenUrl: `${remoteUrl}/access_token`,
        consumerKey: 'consumer-1',
        consumerSecret: 'consumer-secret',
      },
    }),
  );
}

describe('OAuth1 sign-in flow', () => {
  it('runs request token, authorization and access token and stores the tokens encrypted', async () => {
    const { client, tenant } = await signup(server.app);
    const credential = await makeCredential(client);
    const { url } = await client.data(client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`));

    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe('https://auth.example.com/authorize');
    expect(authorize.searchParams.get('oauth_token')).toBe('rt-1');

    // the request-token call: signed with consumer secret only, oauth_callback in the header
    const first = received.find((r) => r.url === '/request_token')!;
    expect(first.method).toBe('POST');
    const fields = oauthFields(first.headers.authorization);
    expect(fields.oauth_consumer_key).toBe('consumer-1');
    expect(fields.oauth_callback).toMatch(/^http:\/\/localhost:5678\/rest\/oauth1\/callback\?state=/);
    const state = new URL(fields.oauth_callback).searchParams.get('state')!;
    // the request-token secret is not readable from the state
    expect(Buffer.from(state.split('.')[0], 'base64url').toString()).not.toContain('rs-1');

    const tampered = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(`${state.slice(0, -2)}xx`)}`,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.body).toContain('"status":"error"');

    const denied = await server.app.inject({
      url: `/rest/oauth1/callback?denied=rt-1&state=${encodeURIComponent(state)}`,
    });
    expect(denied.statusCode).toBe(400);
    expect(received.some((r) => r.url === '/access_token')).toBe(false);

    const callback = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(callback.headers['cross-origin-opener-policy']).toBe('unsafe-none');
    expect(callback.body).toContain('"status":"success"');
    expect(callback.body).toContain('new BroadcastChannel("wf-oauth2")');

    // the access-token call carries the verifier and was signed with the request-token secret
    const access = received.find((r) => r.url === '/access_token')!;
    expect(oauthFields(access.headers.authorization)).toMatchObject({
      oauth_token: 'rt-1',
      oauth_verifier: 'v1',
    });

    const row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    const data = server.ctx.credentials.decrypt(row!);
    expect(data.oauthTokenData).toMatchObject({ oauth_token: 'at-v1', oauth_token_secret: 'as-1' });
    expect(data.consumerSecret).toBe('consumer-secret');
    const api = await client.data(client.get(`/rest/credentials/${credential.id}`));
    expect(api.data.oauthTokenData).toBe('__REDACTED__');
    expect(api.data.consumerSecret).toBe('__REDACTED__');

    const audit = await server.ctx.database.pool.query(
      "select action from audit_log where action = 'credential.oauth1_connected'",
    );
    expect(audit.rows).toHaveLength(1);

    // the credential test reports the connection
    const test = await client.data(
      client.post('/rest/credentials/test', { id: credential.id, type: 'oAuth1Api', data: {} }),
    );
    expect(test).toMatchObject({ status: 'OK', message: 'The account is connected' });
  });

  it('reports a credential without tokens as not connected', async () => {
    const { client } = await signup(server.app);
    const credential = await makeCredential(client);
    const test = await client.data(
      client.post('/rest/credentials/test', { id: credential.id, type: 'oAuth1Api', data: {} }),
    );
    expect(test).toMatchObject({ status: 'Error', message: 'The account is not connected yet' });
  });

  it('is bound to the user who started it and to OAuth1 credentials', async () => {
    const { client } = await signup(server.app);
    const credential = await makeCredential(client);
    const invite = await client.data(
      client.post('/rest/members/invite', { email: 'ed@example.com', role: 'editor' }),
    );
    const editor = new TestClient(server.app);
    const joined = await editor.data(
      editor.post(`/rest/invitations/${invite.token}/accept`, { name: 'Ed', password: 'Passw0rd!' }),
    );
    const started = await editor.data(editor.get(`/rest/oauth1/authorize?credentialId=${credential.id}`));
    expect(new URL(started.url).searchParams.get('oauth_token')).toBe('rt-1');
    await client.data(client.patch(`/rest/members/${joined.user.id}`, { role: 'viewer' }));
    const state = new URL(
      oauthFields(received.filter((r) => r.url === '/request_token').at(-1)!.headers.authorization)
        .oauth_callback,
    ).searchParams.get('state')!;
    const revoked = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=zz&state=${encodeURIComponent(state)}`,
    });
    expect(revoked.statusCode).toBe(400);
    expect(revoked.body).toContain('no longer edit credentials');
    expect(received.some((r) => r.url === '/access_token')).toBe(false);

    // a viewer cannot start the flow
    expect((await editor.get(`/rest/oauth1/authorize?credentialId=${credential.id}`)).statusCode).toBe(403);
    // other credential types and OAuth2 state do not work here
    const notOauth = await client.data(
      client.post('/rest/credentials', { name: 'k', type: 'testApi', data: {} }),
    );
    expect((await client.get(`/rest/oauth1/authorize?credentialId=${notOauth.id}`)).statusCode).toBe(400);
  });

  it('refuses another request token, and a state works once', async () => {
    const { client } = await signup(server.app);
    const credential = await makeCredential(client);
    await client.data(client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`));
    const state = new URL(
      oauthFields(received.find((r) => r.url === '/request_token')!.headers.authorization).oauth_callback,
    ).searchParams.get('state')!;
    const wrong = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=other&oauth_verifier=v1&state=${encodeURIComponent(state)}`,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toContain('does not match');
    const again = await server.app.inject({
      url: `/rest/oauth1/callback?oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(state)}`,
    });
    expect(again.statusCode).toBe(400);
    expect(received.some((r) => r.url === '/access_token')).toBe(false);
  });

  it('refuses to run the request-token call to a blocked address', async () => {
    const { client } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'x',
        type: 'oAuth1Api',
        data: {
          requestTokenUrl: 'http://169.254.169.254/request_token',
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/access_token`,
          consumerKey: 'consumer-1',
          consumerSecret: 'consumer-secret',
        },
      }),
    );
    const res = await client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(received).toHaveLength(0);
  });

  it('applies the allowed domains to the token calls: outside the list or an empty list is a 400', async () => {
    const { client } = await signup(server.app);
    const make = async (allowedDomains: string) =>
      client.data(
        client.post('/rest/credentials', {
          name: `restricted ${allowedDomains || 'empty'}`,
          type: 'oAuth1Api',
          data: {
            requestTokenUrl: `${remoteUrl}/request_token`,
            authUrl: 'https://auth.example.com/authorize',
            accessTokenUrl: `${remoteUrl}/access_token`,
            consumerKey: 'consumer-1',
            consumerSecret: 'consumer-secret',
            allowedHttpRequestDomains: 'domains',
            allowedDomains,
          },
        }),
      );

    const outside = await make('api.example.com');
    const refused = await client.get(`/rest/oauth1/authorize?credentialId=${outside.id}`);
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('Domain not allowed');
    expect(received).toHaveLength(0);

    const empty = await make('');
    const noList = await client.get(`/rest/oauth1/authorize?credentialId=${empty.id}`);
    expect(noList.statusCode).toBe(400);
    expect(noList.body).toContain('No allowed domains specified');
    expect(received).toHaveLength(0);

    const listed = await make('127.0.0.1');
    const ok = await client.data(client.get(`/rest/oauth1/authorize?credentialId=${listed.id}`));
    expect(new URL(ok.url).searchParams.get('oauth_token')).toBe('rt-1');
  });

  it('reports a provider refusal with the status, not the raw client message', async () => {
    const { client } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'bad secret',
        type: 'oAuth1Api',
        data: {
          requestTokenUrl: `${remoteUrl}/request_token?api_key=hidden-value`,
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/access_token`,
          consumerKey: 'consumer-1',
          consumerSecret: 'wrong-secret',
        },
      }),
    );
    const res = await client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/The provider rejected the request [(]HTTP 40[14][)]/);
    expect(res.body).not.toContain('hidden-value');
  });

  it('marks OAuth1 types in the credential type list', async () => {
    const { client } = await signup(server.app);
    const types = await client.data(client.get('/rest/credential-types'));
    expect(types.find((t: { name: string }) => t.name === 'oAuth1Api')).toMatchObject({ isOAuth1: true });
    expect(types.find((t: { name: string }) => t.name === 'oAuth2Api')).toMatchObject({ isOAuth1: false });
  });
});

describe('OAuth1 pending token store in Redis', () => {
  it('keeps the request token encrypted for at most 10 minutes and hands it out once', async () => {
    const withRedis = await createTestServer({ REDIS_URL: TEST_REDIS }, { reset: false });
    try {
      const redis = withRedis.ctx.redis!;
      expect(redis).toBeDefined();
      const { client, tenant } = await signup(withRedis.app);
      const credential = await makeCredential(client);
      await client.data(client.get(`/rest/oauth1/authorize?credentialId=${credential.id}`));
      const state = new URL(
        oauthFields(received.find((r) => r.url === '/request_token')!.headers.authorization).oauth_callback,
      ).searchParams.get('state')!;
      const nonce = (JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString()) as { n: string }).n;
      const key = `${withRedis.ctx.config.queue.prefix}:oauth1:${tenant.id}:${nonce}`;

      const ttl = await redis.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600_000);
      const stored = (await redis.get(key))!;
      expect(stored).toContain('rt-1');
      expect(stored).not.toContain('rs-1');

      const callback = (query: string) => withRedis.app.inject({ url: `/rest/oauth1/callback?${query}` });
      const first = await callback(`oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(state)}`);
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('"status":"success"');
      expect(await redis.exists(key)).toBe(0);
      const second = await callback(`oauth_token=rt-1&oauth_verifier=v1&state=${encodeURIComponent(state)}`);
      expect(second.statusCode).toBe(400);
      expect(second.body).toContain('expired or was already used');
    } finally {
      await withRedis.close();
    }
  });
});
