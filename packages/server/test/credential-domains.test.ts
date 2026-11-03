/**
 * P2-10 allowed domains per credential on the server: the fields are stored and served unredacted, a
 * workflow run honours the list, and the OAuth2 code exchange is a token call the list applies to.
 * Run with TEST_DATABASE_URL=.../workflow_test_p2_domains and TEST_REDIS_URL=redis://127.0.0.1:6379/2.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const received: Array<{ url: string; headers: Record<string, unknown>; body: string }> = [];

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/token') {
        const params = new URLSearchParams(body);
        res.end(JSON.stringify({ access_token: `access-for-${params.get('code')}`, expires_in: 3600 }));
      } else res.end(JSON.stringify({ ok: true, key: req.headers['x-api-key'] ?? null }));
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

const FIELDS = ['allowedHttpRequestDomains', 'allowedDomains'];

describe('the credential fields', () => {
  it('are served with the credential types, and not on types that send no HTTP requests', async () => {
    const { client } = await signup(server.app);
    const types = await client.data<Array<{ name: string; properties: Array<{ name: string }> }>>(
      client.get('/rest/credential-types'),
    );
    const names = (type: string) => types.find((t) => t.name === type)!.properties.map((p) => p.name);
    for (const type of ['httpHeaderAuth', 'httpBasicAuth', 'oAuth2Api', 'oAuth1Api', 'slackApi', 'testApi']) {
      expect(names(type).slice(-2), type).toEqual(FIELDS);
    }
    for (const type of ['postgres', 'smtp', 'jwtAuth'])
      expect(names(type)).not.toEqual(expect.arrayContaining(FIELDS));
  });

  it('round-trip through POST, GET and PATCH /rest/credentials unredacted', async () => {
    const { client, tenant } = await signup(server.app);
    const created = await client.data(
      client.post('/rest/credentials', {
        name: 'Restricted',
        type: 'httpHeaderAuth',
        data: {
          name: 'X-Api-Key',
          value: 'secret-value',
          allowedHttpRequestDomains: 'domains',
          allowedDomains: 'api.example.com, *.example.org',
        },
      }),
    );
    const fetched = await client.data(client.get(`/rest/credentials/${created.id}`));
    expect(fetched.data).toMatchObject({
      value: '__REDACTED__',
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'api.example.com, *.example.org',
    });
    const stored = server.ctx.credentials.decrypt(
      (await server.ctx.repos.credentials.get(tenant.id, created.id))!,
    );
    expect(stored).toMatchObject({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'api.example.com, *.example.org',
    });

    // the form sends the redacted secret back: the list changes, the secret stays
    await client.data(
      client.patch(`/rest/credentials/${created.id}`, {
        data: { ...fetched.data, allowedDomains: 'api.example.com' },
      }),
    );
    const after = server.ctx.credentials.decrypt(
      (await server.ctx.repos.credentials.get(tenant.id, created.id))!,
    );
    expect(after).toMatchObject({ value: 'secret-value', allowedDomains: 'api.example.com' });
    const audit = await client.data(client.get('/rest/audit-log'));
    expect(JSON.stringify(audit)).not.toContain('secret-value');
  });

  it('default to "all" for a credential saved without them', async () => {
    const { client, tenant } = await signup(server.app);
    const created = await client.data(
      client.post('/rest/credentials', {
        name: 'Old',
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: 'v' },
      }),
    );
    const data = server.ctx.credentials.withDefaults(
      'httpHeaderAuth',
      server.ctx.credentials.decrypt((await server.ctx.repos.credentials.get(tenant.id, created.id))!),
    );
    expect(data.allowedHttpRequestDomains).toBe('all');
  });
});

describe('a workflow run with a restricted credential', () => {
  async function runRequest(data: Record<string, unknown>, url = `${remoteUrl}/data`) {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Key',
        type: 'httpHeaderAuth',
        data: { name: 'X-Api-Key', value: 'k-77', ...data },
      }),
    );
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Call',
          'core.httpRequest',
          { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' },
          [200, 0],
          { credentials: { httpHeaderAuth: { id: credential.id, name: 'Key' } } },
        ),
      ],
      connections: chain('Start', 'Call'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    const row = await waitForExecution(server.ctx, tenant.id, executionId, ['success', 'error']);
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    return { row, execution };
  }

  it('refuses a request to another domain, with zero requests at that server', async () => {
    const { row, execution } = await runRequest({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'api.example.com',
    });
    expect(row.status).toBe('error');
    expect(JSON.stringify(execution.state.resultData.error)).toContain('Domain not allowed');
    expect(JSON.stringify(execution)).not.toContain('k-77');
    expect(received).toHaveLength(0);
  });

  it('sends to a listed domain', async () => {
    const { row, execution } = await runRequest({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'api.example.com, 127.0.0.1',
    });
    expect(row.status).toBe('success');
    expect(outputOf(execution.state, 'Call')).toEqual([{ ok: true, key: 'k-77' }]);
  });

  it('the default "all" changes nothing', async () => {
    const { row } = await runRequest({});
    expect(row.status).toBe('success');
    expect(received).toHaveLength(1);
  });
});

describe('Test connection', () => {
  const test = async (allowedDomains: string) => {
    const { client } = await signup(server.app);
    return client.data(
      client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: remoteUrl, apiKey: 'k-test', allowedHttpRequestDomains: 'domains', allowedDomains },
      }),
    );
  };

  it('refuses a test URL outside the list, with zero requests at that server', async () => {
    const result = await test('api.example.com');
    expect(result.status).toBe('Error');
    expect(result.message).toContain('Domain not allowed');
    expect(received).toHaveLength(0);
  });

  it('an empty list is an error, and a listed host is tested', async () => {
    expect((await test('')).status).toBe('Error');
    expect(received).toHaveLength(0);
    expect(await test('127.0.0.1')).toMatchObject({ status: 'OK' });
    expect(received).toHaveLength(1);
    expect(received[0].headers['x-api-key']).toBe('k-test');
  });
});

describe('the OAuth2 code exchange', () => {
  async function connectWith(allowedDomains: Record<string, unknown>) {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Provider',
        type: 'testPkceOAuth2Api',
        data: {
          authUrl: 'https://auth.example.com/authorize',
          accessTokenUrl: `${remoteUrl}/token`,
          clientId: 'client-1',
          clientSecret: 'client-secret',
          ...allowedDomains,
        },
      }),
    );
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    const state = new URL(url).searchParams.get('state')!;
    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    const row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    return { callback, data: server.ctx.credentials.decrypt(row!) };
  }

  it('refuses a token URL outside the list: the token server sees nothing and nothing is stored', async () => {
    const { callback, data } = await connectWith({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'auth.example.com',
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.body).toContain('Domain not allowed');
    expect(callback.body).not.toContain('client-secret');
    expect(received).toHaveLength(0);
    expect(data.oauthTokenData).toBeUndefined();
  });

  it('exchanges the code when the token host is listed', async () => {
    const { callback, data } = await connectWith({
      allowedHttpRequestDomains: 'domains',
      allowedDomains: 'auth.example.com, 127.0.0.1',
    });
    expect(callback.statusCode).toBe(200);
    expect(received.map((r) => r.url)).toEqual(['/token']);
    expect(data.oauthTokenData).toMatchObject({ access_token: 'access-for-abc' });
  });

  it('"none" does not stop the exchange (the token URL is not a URL a user typed), and "all" changes nothing', async () => {
    const none = await connectWith({ allowedHttpRequestDomains: 'none' });
    expect(none.callback.statusCode).toBe(200);
    received.length = 0;
    const all = await connectWith({});
    expect(all.callback.statusCode).toBe(200);
    expect(received.map((r) => r.url)).toEqual(['/token']);
  });
});
