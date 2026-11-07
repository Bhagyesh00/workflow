/**
 * P5-27 `databricksOAuth2Api`: client credentials through `authenticate` (cached token, allowed domains),
 * the https rule, and the test request. Replies are fixtures written from the Databricks OAuth M2M docs.
 */
import { randomUUID } from 'node:crypto';
import { applyAuthentication, createCredentialHelpers, resolveCredentialUrl } from '@workflow/core';
import { type DataObject, evaluateSimple, getCredentialAllowedDomains } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { databricksOAuth2Api } from '../src/credentials/databricks.credentials';
import { FakeHttpClient } from './harness';

const HOST = 'https://adb-1234567890123456.7.azuredatabricks.net';

const creds = (extra: DataObject = {}): DataObject => ({
  host: HOST,
  grantType: 'clientCredentials',
  clientId: 'sp-client',
  clientSecret: `dbx-secret-${randomUUID()}`,
  ...extra,
});

const tokenHost = () =>
  new FakeHttpClient()
    .on('POST', /\/oidc\/v1\/token$/, () => ({ access_token: 'dbx-token-1', expires_in: 3600 }))
    .on('*', /./, () => ({ ok: 1 }));

async function send(fake: FakeHttpClient, data: DataObject, url = `${HOST}/api/2.0/serving-endpoints`) {
  const helpers = createCredentialHelpers(fake, getCredentialAllowedDomains(data, { userUrl: false }));
  const authed = await applyAuthentication(databricksOAuth2Api, data, { url }, helpers);
  await fake.request(authed);
  return authed;
}

describe('databricksOAuth2Api type', () => {
  it('shows a brand icon and fixes the token URL to https', () => {
    expect(databricksOAuth2Api.icon).toBe('simple:databricks');
    const flag = databricksOAuth2Api.properties.find((p) => p.name === 'httpsOnlyTokenUrl');
    expect(flag).toMatchObject({ type: 'hidden', default: 'true' });
  });
});

describe('databricksOAuth2Api client credentials', () => {
  it('gets a token with the client in the Basic header and sends it as a bearer', async () => {
    const fake = tokenHost();
    const data = creds();
    await send(fake, data);
    const [token, call] = fake.requests;
    expect(token.url).toBe(`${HOST}/oidc/v1/token`);
    expect(token.method).toBe('POST');
    expect(token.headers.authorization).toBe(
      `Basic ${Buffer.from(`sp-client:${String(data.clientSecret)}`).toString('base64')}`,
    );
    expect(token.body).toEqual({ grant_type: 'client_credentials', scope: 'all-apis' });
    expect(call.url).toBe(`${HOST}/api/2.0/serving-endpoints`);
    expect(call.headers.authorization).toBe('Bearer dbx-token-1');
  });

  it('fetches the token once for the same secret and scope', async () => {
    const fake = tokenHost();
    const data = creds();
    await send(fake, data);
    await send(fake, data);
    expect(fake.requests.filter((r) => r.url.endsWith('/oidc/v1/token'))).toHaveLength(1);
  });

  it('caches by a scope text of token URL, subject, scopes, resource and role', async () => {
    const fake = tokenHost();
    const data = creds();
    const helpers = createCredentialHelpers(fake, undefined);
    const seen: string[] = [];
    await applyAuthentication(
      databricksOAuth2Api,
      data,
      { url: HOST },
      {
        ...helpers,
        cachedToken: (secret, scope, fetch) => {
          seen.push(scope);
          return helpers.cachedToken(secret, scope, fetch);
        },
      },
    );
    expect(JSON.parse(seen[0])).toEqual({
      tokenUrl: `${HOST}/oidc/v1/token`,
      subject: 'sp-client',
      scopes: ['all-apis'],
      resource: '',
      role: '',
    });
  });

  it.each([
    'http://adb-1.azuredatabricks.net',
    'ftp://adb-1.azuredatabricks.net',
    'adb-1.azuredatabricks.net',
    '',
    'https://user:pw@adb-1.azuredatabricks.net',
    'https://adb-1.azuredatabricks.net/?x=1',
  ])('refuses the host %j before any request', async (host) => {
    const fake = tokenHost();
    const error = await send(fake, creds({ host })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(fake.requests).toEqual([]);
    expect((error as Error).message).not.toContain('pw@');
    expect((error as Error).message).not.toContain(String(creds().clientSecret).slice(0, 10));
  });

  it('keeps a path on the host and trims a trailing slash', async () => {
    const fake = tokenHost();
    await send(fake, creds({ host: `${HOST}/` }));
    expect(fake.requests[0].url).toBe(`${HOST}/oidc/v1/token`);
  });

  it('keeps the allowed domains of the credential: a token host outside them is refused', async () => {
    const fake = tokenHost();
    const error = await send(
      fake,
      creds({ allowedHttpRequestDomains: 'domains', allowedDomains: 'other.example.com' }),
    ).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/Domain not allowed/);
    expect(fake.requests).toEqual([]);
  });

  it('fails without the client id or secret and sends nothing', async () => {
    const fake = tokenHost();
    await expect(send(fake, creds({ clientSecret: '' }))).rejects.toThrow(/client ID and a secret/);
    expect(fake.requests).toEqual([]);
  });

  it('sends no partner header and no n8n User-Agent', async () => {
    const fake = tokenHost();
    await send(fake, creds());
    for (const r of fake.requests) {
      const text = JSON.stringify(r.headers).toLowerCase();
      expect(text).not.toContain('openai-platform');
      expect(text).not.toContain('n8n');
    }
  });

  it('does not put a token on a request for the user grant until it is connected', async () => {
    const fake = tokenHost();
    await expect(send(fake, creds({ grantType: 'pkce' }))).rejects.toThrow(/not connected/);
    await send(fake, creds({ grantType: 'pkce', oauthTokenData: { access_token: 'user-token' } }));
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].headers.authorization).toBe('Bearer user-token');
  });
});

describe('databricksOAuth2Api OAuth2 URLs', () => {
  it('extends oAuth2Api with the OIDC URLs of the host', () => {
    expect(databricksOAuth2Api.extends).toEqual(['oAuth2Api']);
    const data = { host: HOST };
    const url = (name: string) =>
      resolveCredentialUrl(
        String(databricksOAuth2Api.properties.find((p) => p.name === name)?.default),
        data,
      );
    expect(url('authUrl')).toBe(`${HOST}/oidc/v1/authorize`);
    expect(url('accessTokenUrl')).toBe(`${HOST}/oidc/v1/token`);
  });

  it('tests the connection against the serving endpoints, and gives an http host no URL', () => {
    const template = databricksOAuth2Api.test?.request.url as string;
    expect(evaluateSimple(template, { $credentials: { host: HOST } })).toBe(
      `${HOST}/api/2.0/serving-endpoints`,
    );
    expect(evaluateSimple(template, { $credentials: { host: 'http://adb-1.example.net' } })).toBe('refused');
  });
});
