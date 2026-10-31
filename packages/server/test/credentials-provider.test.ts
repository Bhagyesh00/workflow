import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialTypes, type HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { HttpRequestOptions } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testCredential } from '../src/services/credential-test';
import { CredentialService } from '../src/services/credentials';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const hits: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[]}');
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
  hits.length = 0;
});

async function createCredential(
  tenantId: string,
  input: { name?: string; type: string; data: Record<string, unknown> },
) {
  const row = await server.ctx.credentials.create(tenantId, {
    name: input.name ?? 'Cred',
    type: input.type,
    data: input.data as never,
  });
  return row;
}

describe('CredentialsProvider', () => {
  it('rejects a credential id owned by another tenant', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const cred = await createCredential(a.tenant.id, { type: 'testApi', data: { apiKey: 'a-secret' } });
    const own = await server.ctx.credentials
      .provider(a.tenant.id)
      .get({ id: cred.id, name: 'Cred' }, 'testApi');
    expect(own.apiKey).toBe('a-secret');
    const other = server.ctx.credentials.provider(b.tenant.id);
    await expect(other.get({ id: cred.id, name: 'Cred' }, 'testApi')).rejects.toThrow(/was not found/);
    await expect(other.update({ id: cred.id, name: 'Cred' }, 'testApi', { apiKey: 'x' })).rejects.toThrow(
      /was not found/,
    );
    // a matching name in another tenant is not a fallback either
    await expect(other.get({ id: null, name: 'Cred' }, 'testApi')).rejects.toThrow(/was not found/);
    const row = await server.ctx.repos.credentials.get(a.tenant.id, cred.id);
    expect(server.ctx.credentials.decrypt(row!).apiKey).toBe('a-secret');
  });

  it('rejects a credential of the wrong type and accepts a type that extends the requested one', async () => {
    const { tenant } = await signup(server.app);
    const api = await createCredential(tenant.id, { type: 'testApi', data: { apiKey: 'k' } });
    const provider = server.ctx.credentials.provider(tenant.id);
    await expect(provider.get({ id: api.id, name: 'Cred' }, 'oAuth2Api')).rejects.toThrow(
      /is of type "testApi", expected "oAuth2Api"/,
    );
    await expect(provider.update({ id: api.id, name: 'Cred' }, 'oAuth2Api', {})).rejects.toThrow(
      /is of type "testApi"/,
    );

    const gmail = await createCredential(tenant.id, {
      name: 'Mail',
      type: 'gmailOAuth2',
      data: { clientId: 'id', clientSecret: 's' },
    });
    for (const requested of ['gmailOAuth2', 'googleOAuth2Api', 'oAuth2Api']) {
      const data = await provider.get({ id: gmail.id, name: 'Mail' }, requested);
      expect(data.clientId).toBe('id');
    }
    await expect(provider.get({ id: gmail.id, name: 'Mail' }, 'googleSheetsOAuth2Api')).rejects.toThrow(
      /is of type "gmailOAuth2"/,
    );
  });

  it('does not resolve an unresolved expression id and falls back to the name only without an id', async () => {
    const { tenant } = await signup(server.app);
    await createCredential(tenant.id, { name: 'Named', type: 'testApi', data: { apiKey: 'named' } });
    const provider = server.ctx.credentials.provider(tenant.id);
    await expect(provider.get({ id: '={{ $json.id }}', name: 'Named' }, 'testApi')).rejects.toThrow(
      /was not found/,
    );
    expect((await provider.get({ id: null, name: 'Named' }, 'testApi')).apiKey).toBe('named');
  });

  it('resolves expression credential ids per tenant inside an execution', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const credA = await createCredential(a.tenant.id, { type: 'testApi', data: { apiKey: 'abc' } });
    const credB = await createCredential(b.tenant.id, { type: 'testApi', data: { apiKey: 'abcdefgh' } });
    const run = async (
      who: typeof a,
      id: string,
      expectedStatus: 'success' | 'error',
    ): Promise<Record<string, unknown>> => {
      const wf = await createWorkflow(who.client, {
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Use', 'test.useCredential', {}, [200, 0], {
            credentials: { testApi: { id: `={{ "${id}" }}`, name: 'Cred' } },
          }),
        ],
        connections: chain('Start', 'Use'),
      });
      const { executionId } = await who.client.data(who.client.post(`/rest/workflows/${wf.id}/run`, {}));
      await waitForExecution(server.ctx, who.tenant.id, executionId, [expectedStatus]);
      return who.client.data(who.client.get(`/rest/executions/${executionId}`));
    };
    const ok = await run(a, credA.id, 'success');
    expect(outputOf(ok.state, 'Use')).toEqual([{ keyLength: 3, region: 'eu' }]);
    // tenant A pointing at tenant B's credential must not read it
    const denied = await run(a, credB.id, 'error');
    expect(JSON.stringify(denied)).toContain('was not found');
    expect(JSON.stringify(denied)).not.toContain('abcdefgh');
  });
});

describe('credential type defaults', () => {
  it('merges hidden fixed Google URLs and scopes into the data nodes receive', async () => {
    const { tenant } = await signup(server.app);
    const cred = await createCredential(tenant.id, {
      name: 'Mail',
      type: 'gmailOAuth2',
      data: { clientId: 'id', clientSecret: 's' },
    });
    const data = await server.ctx.credentials
      .provider(tenant.id)
      .get({ id: cred.id, name: 'Mail' }, 'gmailOAuth2');
    expect(data).toMatchObject({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      accessTokenUrl: 'https://oauth2.googleapis.com/token',
      authQueryParameters: 'access_type=offline&prompt=consent',
      authentication: 'body',
      grantType: 'authorizationCode',
      clientId: 'id',
    });
    expect(String(data.scope)).toContain('gmail.send');
  });

  it('pins hidden fixed values over blank stored ones but keeps stored token data', () => {
    const service = server.ctx.credentials;
    const tokens = { access_token: 'tok' };
    const data = service.withDefaults('gmailOAuth2', {
      clientId: 'id',
      authUrl: '',
      scope: '',
      grantType: 'pkce',
      oauthTokenData: tokens,
    });
    expect(data.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(String(data.scope)).toContain('gmail.modify');
    expect(data.grantType).toBe('authorizationCode');
    expect(data.oauthTokenData).toEqual(tokens);
  });

  it('treats a blank visible field as unset so its type default applies', () => {
    const data = server.ctx.credentials.withDefaults('testApi', { region: '', apiKey: 'k' });
    expect(data).toEqual({ baseUrl: '', region: 'eu', apiKey: 'k' });
    expect(server.ctx.credentials.withDefaults('testApi', { region: 'us' }).region).toBe('us');
  });

  it('builds the Google authorization URL from a credential with only a client id and secret', async () => {
    const { client, tenant } = await signup(server.app);
    const cred = await createCredential(tenant.id, {
      name: 'Google',
      type: 'googleSheetsOAuth2Api',
      data: { clientId: 'client-1', clientSecret: 'secret-1', authUrl: '', accessTokenUrl: '', scope: '' },
    });
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${cred.id}`));
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('client_id')).toBe('client-1');
    expect(authorize.searchParams.get('scope')).toContain('auth/spreadsheets');
    expect(authorize.searchParams.get('access_type')).toBe('offline');
    expect(authorize.searchParams.get('prompt')).toBe('consent');
  });
});

describe('credential test templates', () => {
  const aiService = () =>
    new CredentialService(
      server.ctx.repos,
      server.ctx.cipher,
      new CredentialTypes([...nodesAiPackage.credentials]),
    );

  function recordingHttp(): { http: HttpClient; requests: HttpRequestOptions[] } {
    const requests: HttpRequestOptions[] = [];
    const http = {
      request: async (options: HttpRequestOptions) => {
        requests.push(options);
        return { statusCode: 200, headers: {}, body: {} };
      },
    } as unknown as HttpClient;
    return { http, requests };
  }

  it('hits {baseUrl}/models for OpenAI, with the default base URL when none is given', async () => {
    const service = aiService();
    const result = await testCredential(service, server.ctx.http, 'openAiApi', {
      apiKey: 'sk-test',
      baseUrl: remoteUrl,
    });
    expect(result.status).toBe('OK');
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('/models');
    expect(hits[0].headers.authorization).toBe('Bearer sk-test');

    const recorded = recordingHttp();
    await testCredential(service, recorded.http, 'openAiApi', { apiKey: 'sk-test' });
    expect(recorded.requests[0].url).toBe('https://api.openai.com/v1/models');
  });

  it('hits {baseUrl}/v1/models for Anthropic with the version header', async () => {
    const result = await testCredential(aiService(), server.ctx.http, 'anthropicApi', {
      apiKey: 'ak-test',
      baseUrl: remoteUrl,
    });
    expect(result.status).toBe('OK');
    expect(hits[0].url).toBe('/v1/models');
    expect(hits[0].headers['x-api-key']).toBe('ak-test');
    expect(hits[0].headers['anthropic-version']).toBeTruthy();
  });

  it('resolves templates in header values and nested request fields', async () => {
    const types = new CredentialTypes([
      {
        name: 'tplApi',
        displayName: 'Template API',
        properties: [
          { displayName: 'Host', name: 'host', type: 'string', default: remoteUrl },
          { displayName: 'Token', name: 'token', type: 'string', default: '' },
        ],
        test: {
          request: {
            url: '={{$credentials.host}}/check',
            headers: { 'x-token': '={{$credentials.token}}' },
            qs: { who: '={{$credentials.token}}' },
          },
        },
      },
    ]);
    const service = new CredentialService(server.ctx.repos, server.ctx.cipher, types);
    const result = await testCredential(service, server.ctx.http, 'tplApi', { token: 'tt' });
    expect(result.status).toBe('OK');
    expect(hits[0].url).toBe('/check?who=tt');
    expect(hits[0].headers['x-token']).toBe('tt');
  });
});
