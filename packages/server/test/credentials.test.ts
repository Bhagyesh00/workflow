import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpClient } from '@workflow/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  resetDatabase,
  signup,
  TestClient,
  type TestServer,
  testConfig,
  waitForExecution,
} from './helpers';

let server: TestServer;
let remote: Server;
let remoteUrl: string;
const received: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = await createTestServer();
  remote = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      if (req.url === '/check') {
        const ok = req.headers['x-api-key'] === 'top-secret';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.url === '/token') {
        const params = new URLSearchParams(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `access-for-${params.get('code')}`,
            refresh_token: 'refresh-1',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
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

describe('credentials', () => {
  it('encrypts at rest, redacts secrets and keeps them on update', async () => {
    const { client, tenant } = await signup(server.app);
    const created = await client.data(
      client.post('/rest/credentials', {
        name: 'Prod API',
        type: 'testApi',
        data: { baseUrl: 'https://api.example.com', apiKey: 'top-secret' },
      }),
    );
    expect(created).toEqual({ id: created.id, name: 'Prod API', type: 'testApi' });

    const { rows } = await server.ctx.database.pool.query('select data_enc from credentials where id = $1', [
      created.id,
    ]);
    expect(rows[0].data_enc).toMatch(/^v1\.test\./);
    expect(rows[0].data_enc).not.toContain('top-secret');
    // ciphertext is bound to tenant + credential id
    expect(() =>
      server.ctx.cipher.decrypt(rows[0].data_enc, { tenantId: tenant.id, credentialId: 'other' }),
    ).toThrow();

    const fetched = await client.data(client.get(`/rest/credentials/${created.id}`));
    expect(fetched.data).toEqual({ baseUrl: 'https://api.example.com', apiKey: '__REDACTED__' });
    const list = await client.data(client.get('/rest/credentials?type=testApi'));
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('data');

    // the editor sends the sentinel back: the stored secret is kept
    await client.data(
      client.patch(`/rest/credentials/${created.id}`, {
        name: 'Prod API v2',
        data: { baseUrl: 'https://api2.example.com', apiKey: '__REDACTED__' },
      }),
    );
    const row = await server.ctx.repos.credentials.get(tenant.id, created.id);
    expect(server.ctx.credentials.decrypt(row!)).toEqual({
      baseUrl: 'https://api2.example.com',
      apiKey: 'top-secret',
    });
    await client.data(client.patch(`/rest/credentials/${created.id}`, { data: { apiKey: 'rotated' } }));
    const rotated = await server.ctx.repos.credentials.get(tenant.id, created.id);
    expect(server.ctx.credentials.decrypt(rotated!).apiKey).toBe('rotated');

    const audit = await client.data(client.get('/rest/audit-log'));
    expect(audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['credential.created', 'credential.read', 'credential.updated']),
    );
    expect(JSON.stringify(audit)).not.toContain('top-secret');

    expect((await client.post('/rest/credentials', { name: 'x', type: 'nope', data: {} })).statusCode).toBe(
      400,
    );
    await client.data(client.delete(`/rest/credentials/${created.id}`));
    expect((await client.get(`/rest/credentials/${created.id}`)).statusCode).toBe(404);
  });

  it('redacts header values of Multiple Headers Auth and keeps them on a save with the sentinel', async () => {
    const { client, tenant } = await signup(server.app);
    const headers = {
      values: [
        { name: 'X-API-Key', value: 'header-secret-1' },
        { name: 'X-Team', value: 'header-secret-2' },
        { name: 'X-Ref', value: '={{ $vars.ref }}' },
      ],
    };
    const created = await client.data(
      client.post('/rest/credentials', {
        name: 'Headers',
        type: 'httpMultipleHeadersAuth',
        data: { headers },
      }),
    );
    const read = await client.get(`/rest/credentials/${created.id}`);
    expect(read.statusCode).toBe(200);
    expect(read.body).not.toContain('header-secret');
    expect(read.json().data.data.headers).toEqual({
      values: [
        { name: 'X-API-Key', value: '__REDACTED__' },
        { name: 'X-Team', value: '__REDACTED__' },
        { name: 'X-Ref', value: '={{ $vars.ref }}' },
      ],
    });

    // the form sends the redacted data back with one header renamed and one value replaced
    const sent = read.json().data.data.headers as { values: Array<{ name: string; value: string }> };
    sent.values[0].name = 'X-Api-Key';
    sent.values[1].value = 'rotated';
    sent.values.push({ name: 'X-New', value: '__REDACTED__' });
    await client.data(client.patch(`/rest/credentials/${created.id}`, { data: { headers: sent } }));
    const row = await server.ctx.repos.credentials.get(tenant.id, created.id);
    expect(server.ctx.credentials.decrypt(row!).headers).toEqual({
      values: [
        { name: 'X-Api-Key', value: 'header-secret-1' },
        { name: 'X-Team', value: 'rotated' },
        { name: 'X-Ref', value: '={{ $vars.ref }}' },
        { name: 'X-New' },
      ],
    });
  });

  it('decrypts credentials with type defaults inside executions', async () => {
    const { client, tenant } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', { name: 'Key', type: 'testApi', data: { apiKey: 'abcdef' } }),
    );
    const wf = await createWorkflow(client, {
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Use', 'test.useCredential', {}, [200, 0], {
          credentials: { testApi: { id: credential.id, name: 'Key' } },
        }),
      ],
      connections: chain('Start', 'Use'),
    });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId, ['success']);
    const execution = await client.data(client.get(`/rest/executions/${executionId}`));
    expect(outputOf(execution.state, 'Use')).toEqual([{ keyLength: 6, region: 'eu' }]);
  });

  it('tests credentials with the type test request through the SSRF-guarded client', async () => {
    const { client } = await signup(server.app);
    const ok = await client.data(
      client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: remoteUrl, apiKey: 'top-secret' },
      }),
    );
    expect(ok).toEqual({ status: 'OK', message: 'Connection tested successfully' });
    expect(received[0].headers['x-api-key']).toBe('top-secret');

    const bad = await client.data(
      client.post('/rest/credentials/test', {
        type: 'testApi',
        data: { baseUrl: remoteUrl, apiKey: 'wrong' },
      }),
    );
    expect(bad.status).toBe('Error');

    // a stored credential is tested with its secret even when the editor sends the sentinel
    const stored = await client.data(
      client.post('/rest/credentials', {
        name: 'k',
        type: 'testApi',
        data: { baseUrl: remoteUrl, apiKey: 'top-secret' },
      }),
    );
    const merged = await client.data(
      client.post('/rest/credentials/test', {
        type: 'testApi',
        id: stored.id,
        data: { baseUrl: remoteUrl, apiKey: '__REDACTED__' },
      }),
    );
    expect(merged.status).toBe('OK');

    // with the configured (default) SSRF policy, loopback targets are blocked
    const platform = new HttpClient({ ssrf: testConfig().ssrf });
    try {
      const blocked = await platform
        .request({ url: `${remoteUrl}/check` })
        .then(() => 'allowed')
        .catch((e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
      expect(blocked).toMatch(/blocked/);
    } finally {
      await platform.close();
    }
  });

  it('does not evaluate a typed authorization URL again, so stored secrets stay out of the answer', async () => {
    const { client } = await signup(server.app);
    const credential = await client.data(
      client.post('/rest/credentials', {
        name: 'Generic',
        type: 'oAuth2Api',
        data: {
          authUrl: '={{"=https://x.example/{{$credentials.clientSecret}}"}}',
          accessTokenUrl: `${remoteUrl}/token`,
          clientId: 'client-1',
          clientSecret: 'stored-client-secret',
        },
      }),
    );
    const response = await client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Invalid authorization URL');
    expect(response.body).not.toContain('stored-client-secret');
  });

  it('runs the OAuth2 authorization code flow with PKCE and stores tokens encrypted', async () => {
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
          scope: 'read write',
        },
      }),
    );
    const { url } = await client.data(client.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    const authorize = new URL(url);
    expect(authorize.origin + authorize.pathname).toBe('https://auth.example.com/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('client-1');
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://localhost:5678/rest/oauth2/callback');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state')!;
    const challenge = authorize.searchParams.get('code_challenge')!;
    // the verifier is not readable from the state
    expect(Buffer.from(state.split('.')[0], 'base64url').toString()).not.toMatch(/"v":"[A-Za-z0-9_-]{43}"/);

    // tampering with the state is rejected
    const tampered = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${state.slice(0, -2)}xx`,
    });
    expect(tampered.statusCode).toBe(400);
    expect(tampered.body).toContain('"status":"error"');

    const callback = await server.app.inject({
      url: `/rest/oauth2/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.headers['content-type']).toContain('text/html');
    expect(callback.headers['content-security-policy']).toMatch(/script-src 'nonce-/);
    expect(callback.body).toContain('"status":"success"');
    expect(callback.body).toContain('postMessage(d,"http://localhost:5678")');
    // also announced on the editor's channel, for popups the provider cut off from their opener
    expect(callback.body).toContain('new BroadcastChannel("wf-oauth2")');

    const tokenRequest = new URLSearchParams(received.find((r) => r.url === '/token')!.body);
    expect(tokenRequest.get('grant_type')).toBe('authorization_code');
    expect(tokenRequest.get('code')).toBe('abc');
    const verifier = tokenRequest.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);

    const row = await server.ctx.repos.credentials.get(tenant.id, credential.id);
    const data = server.ctx.credentials.decrypt(row!);
    expect(data.oauthTokenData).toMatchObject({ access_token: 'access-for-abc', refresh_token: 'refresh-1' });
    expect(data.clientSecret).toBe('client-secret');
    const api = await client.data(client.get(`/rest/credentials/${credential.id}`));
    expect(api.data.oauthTokenData).toBe('__REDACTED__');
    expect(api.data.clientSecret).toBe('__REDACTED__');

    // a form save that omits the token data keeps the connection
    await client.data(
      client.patch(`/rest/credentials/${credential.id}`, { data: { ...api.data, scope: 'read' } }),
    );
    const after = server.ctx.credentials.decrypt(
      (await server.ctx.repos.credentials.get(tenant.id, credential.id))!,
    );
    expect(after.oauthTokenData).toMatchObject({ access_token: 'access-for-abc' });
    expect(after.scope).toBe('read');

    // the flow is bound to the user who started it: losing edit rights invalidates it
    const invite = await client.data(
      client.post('/rest/members/invite', { email: 'ed@example.com', role: 'editor' }),
    );
    const editor = new TestClient(server.app);
    const joined = await editor.data(
      editor.post(`/rest/invitations/${invite.token}/accept`, { name: 'Ed', password: 'Passw0rd!' }),
    );
    const started = await editor.data(editor.get(`/rest/oauth2/authorize?credentialId=${credential.id}`));
    await client.data(client.patch(`/rest/members/${joined.user.id}`, { role: 'viewer' }));
    const editorState = new URL(started.url).searchParams.get('state')!;
    const revoked = await server.app.inject({
      url: `/rest/oauth2/callback?code=zzz&state=${encodeURIComponent(editorState)}`,
    });
    expect(revoked.statusCode).toBe(400);
    expect(revoked.body).toContain('no longer edit credentials');

    const notOauth = await client.data(
      client.post('/rest/credentials', { name: 'k', type: 'testApi', data: {} }),
    );
    expect((await client.get(`/rest/oauth2/authorize?credentialId=${notOauth.id}`)).statusCode).toBe(400);
  });
});
