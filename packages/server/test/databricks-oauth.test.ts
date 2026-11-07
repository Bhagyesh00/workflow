/**
 * P5-27 `databricksOAuth2Api` on the server: the user grant (authorization code with PKCE) through
 * `services/oauth2.ts` with the templated OIDC URLs, the https-only rule, and the credential test.
 * Run with TEST_DATABASE_URL=.../workflow_test_p5_s1_oauth and TEST_REDIS_URL=redis://127.0.0.1:6379/5.
 * The token host is a fake HttpClient: nothing leaves the process.
 */
import { createHash } from 'node:crypto';
import { HttpClient } from '@workflow/core';
import type { HttpFullResponse, HttpRequestOptions } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, resetDatabase, signup, type TestClient, type TestServer } from './helpers';

const HOST = 'https://adb-777.azuredatabricks.net';
const HTTP_HOST = 'http://adb-777.azuredatabricks.net';

class FakeTokenHost extends HttpClient {
  readonly requests: HttpRequestOptions[] = [];

  override async request<T = unknown>(options: HttpRequestOptions): Promise<T | HttpFullResponse<T>> {
    this.requests.push(options);
    const url = new URL(options.url);
    let body: unknown = { ok: true };
    if (url.pathname === '/oidc/v1/token') {
      const params = options.body as Record<string, string>;
      body =
        params.grant_type === 'client_credentials'
          ? { access_token: 'cc-token', expires_in: 3600, token_type: 'Bearer' }
          : {
              access_token: `access-for-${params.code}`,
              refresh_token: 'refresh-1',
              expires_in: 3600,
              token_type: 'Bearer',
            };
    }
    if (options.returnFullResponse) {
      return { body, headers: {}, statusCode: 200, statusMessage: 'OK' } as HttpFullResponse<T>;
    }
    return body as T;
  }
}

let server: TestServer;
const fake = new FakeTokenHost();

beforeAll(async () => {
  server = await createTestServer({}, { http: fake });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  fake.requests.length = 0;
});

const data = (extra: Record<string, unknown> = {}) => ({
  host: HOST,
  grantType: 'pkce',
  clientId: 'dbx-client',
  clientSecret: 'dbx-secret',
  ...extra,
});

async function setup(extra: Record<string, unknown> = {}) {
  const { client, tenant } = await signup(server.app);
  const credential = await client.data(
    client.post('/rest/credentials', { name: 'Databricks', type: 'databricksOAuth2Api', data: data(extra) }),
  );
  return { client, tenant, credential };
}

describe('Databricks OAuth2 start and callback', () => {
  it('starts the user grant at the host with PKCE, the user scope and no request sent', async () => {
    const { client, credential } = await setup();
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe(`${HOST}/oidc/v1/authorize`);
    expect(authorize.searchParams.get('client_id')).toBe('dbx-client');
    expect(authorize.searchParams.get('scope')).toBe('all-apis offline_access');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:5678/rest/oauth2/callback');
    expect(fake.requests).toEqual([]);
  });

  it('exchanges the code at <host>/oidc/v1/token with the verifier and stores the tokens', async () => {
    const { client, tenant, credential } = await setup();
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    const authorize = new URL(url);
    const state = authorize.searchParams.get('state') as string;
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain('"status":"success"');
    expect(fake.requests).toHaveLength(1);
    const [token] = fake.requests;
    expect(token.url).toBe(`${HOST}/oidc/v1/token`);
    const body = token.body as Record<string, string>;
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'abc',
      client_id: 'dbx-client',
      client_secret: 'dbx-secret',
    });
    expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
    const headers = JSON.stringify(token.headers ?? {}).toLowerCase();
    expect(headers).not.toContain('openai-platform');
    expect(headers).not.toContain('n8n');
    const row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    expect(server.ctx.credentials.decrypt(row!).oauthTokenData).toMatchObject({
      access_token: 'access-for-abc',
      refresh_token: 'refresh-1',
    });
  });

  it('refuses to start on an http host', async () => {
    const { client, credential } = await setup({ host: HTTP_HOST });
    const res = await client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('must use https');
    expect(fake.requests).toEqual([]);
  });

  it('sends no token request when the host was changed to http after the start', async () => {
    const { client, credential } = await setup();
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    const state = new URL(url).searchParams.get('state') as string;
    await client.data(
      client.patch(`/rest/credentials/${credential.id}`, {
        data: data({ host: HTTP_HOST, clientSecret: '__REDACTED__' }),
      }),
    );
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain('"status":"error"');
    expect(fake.requests).toEqual([]);
  });

  it('has no Connect for the client credentials grant', async () => {
    const { client, credential } = await setup({ grantType: 'clientCredentials' });
    const res = await client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`);
    expect(res.statusCode).toBe(400);
    expect(fake.requests).toEqual([]);
  });
});

describe('Databricks credential test', () => {
  const test = (client: TestClient, extra: Record<string, unknown>) =>
    client.data(client.post('/rest/credentials/test', { type: 'databricksOAuth2Api', data: data(extra) }));

  it('client credentials: gets a token at the host, then reads the serving endpoints with it', async () => {
    const { client } = await setup();
    const result = await test(client, { grantType: 'clientCredentials', clientSecret: 'cc-secret-1' });
    expect(result).toEqual({ status: 'OK', message: 'Connection tested successfully' });
    expect(fake.requests.map((r) => r.url)).toEqual([
      `${HOST}/oidc/v1/token`,
      `${HOST}/api/2.0/serving-endpoints`,
    ]);
    expect(fake.requests[1].headers?.authorization).toBe('Bearer cc-token');
  });

  it('client credentials on an http host: refused, and no token request is sent', async () => {
    const { client } = await setup();
    const result = await test(client, { grantType: 'clientCredentials', host: HTTP_HOST });
    expect(result.status).toBe('Error');
    expect(result.message).toContain('https');
    expect(fake.requests).toEqual([]);
  });

  it('user grant on an http host: nothing is sent', async () => {
    const { client } = await setup();
    const result = await test(client, { host: HTTP_HOST });
    expect(result.status).toBe('Error');
    expect(fake.requests).toEqual([]);
  });

  it('user grant with an expired token on an http host: no refresh goes out', async () => {
    const { client, tenant, credential } = await setup();
    await server.ctx.credentials.saveData(tenant.id, credential.id, {
      ...data(),
      oauthTokenData: {
        access_token: 'old-access',
        refresh_token: 'stored-refresh',
        expires_at: Date.now() - 60_000,
      },
    });
    const withStored = (extra: Record<string, unknown>) =>
      client.data(
        client.post('/rest/credentials/test', {
          id: credential.id,
          type: 'databricksOAuth2Api',
          data: data(extra),
        }),
      );
    // on the https host the same stored token does refresh: this is the path the http host must not take
    expect(await withStored({})).toMatchObject({ status: 'OK' });
    expect(fake.requests[0]?.url).toBe(`${HOST}/oidc/v1/token`);
    expect(fake.requests[0]?.body).toMatchObject({ refresh_token: 'stored-refresh' });

    fake.requests.length = 0;
    const refused = await withStored({ host: HTTP_HOST });
    expect(refused.status).toBe('Error');
    expect(refused.message).toContain('https');
    const unflagged = await withStored({ host: HTTP_HOST, httpsOnlyTokenUrl: 'false' });
    expect(unflagged.status).toBe('Error');
    expect(fake.requests).toEqual([]);
  });
});
