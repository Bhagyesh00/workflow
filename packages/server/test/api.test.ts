import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

async function apiKey(role: 'owner' | 'viewer' = 'owner') {
  const owner = await signup(server.app);
  if (role === 'owner') {
    const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'test' }));
    return { ...owner, key: key.key as string };
  }
  const invite = await owner.client.data(
    owner.client.post('/rest/members/invite', { email: 'v@example.com', role }),
  );
  const { TestClient } = await import('./helpers');
  const viewer = new TestClient(server.app);
  await viewer.data(
    viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'V', password: 'Passw0rd!' }),
  );
  const key = await viewer.data(viewer.post('/rest/api-keys', { name: 'viewer' }));
  return { ...owner, key: key.key as string };
}

const api = (key: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  server.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { 'x-api-key': key },
    payload: payload as object,
  });

describe('public API', () => {
  it('requires a valid API key', async () => {
    expect((await server.app.inject({ url: '/api/v1/workflows' })).statusCode).toBe(401);
    const bad = await api('wfk_00000000_nope-nope-nope-nope-nope', 'GET', '/workflows');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('unauthorized');
  });

  it('manages workflows, executions, credentials, tags and variables', async () => {
    const { key, tenant } = await apiKey();
    const created = await api(key, 'POST', '/workflows', {
      name: 'From API',
      nodes: [
        node('Hook', 'core.webhook', { path: 'api-made', httpMethod: 'POST' }, [0, 0], { webhookId: 'x' }),
        setNode('Set', 'via', 'api'),
      ],
      connections: chain('Hook', 'Set'),
    });
    expect(created.statusCode).toBe(200);
    const wf = created.json().data;
    expect((await api(key, 'GET', `/workflows/${wf.id}`)).json().data.name).toBe('From API');

    const updated = await api(key, 'PUT', `/workflows/${wf.id}`, { name: 'Renamed' });
    expect(updated.json().data.name).toBe('Renamed');
    const stale = await api(key, 'PUT', `/workflows/${wf.id}`, { versionId: wf.versionId, name: 'x' });
    expect(stale.statusCode).toBe(409);

    expect((await api(key, 'POST', `/workflows/${wf.id}/activate`)).json().data.active).toBe(true);
    const list = (await api(key, 'GET', '/workflows?active=true')).json();
    expect(list).toMatchObject({ data: [{ id: wf.id, active: true }], nextCursor: null });

    const hook = await server.app.inject({ method: 'POST', url: `/webhook/${tenant.slug}/api-made` });
    expect(hook.statusCode).toBe(200);
    const executions = (await api(key, 'GET', `/executions?workflowId=${wf.id}`)).json().data;
    expect(executions).toHaveLength(1);
    await waitForExecution(server.ctx, tenant.id, executions[0].id, ['success']);
    const summary = (await api(key, 'GET', `/executions/${executions[0].id}`)).json().data;
    expect(summary).not.toHaveProperty('state');
    const full = (await api(key, 'GET', `/executions/${executions[0].id}?includeData=true`)).json().data;
    expect(full.state.resultData.runData.Set).toBeDefined();
    expect((await api(key, 'DELETE', `/executions/${executions[0].id}`)).json().data).toEqual({ ok: true });
    expect((await api(key, 'POST', `/workflows/${wf.id}/deactivate`)).json().data.active).toBe(false);

    const schema = (await api(key, 'GET', '/credentials/schema/testApi')).json().data;
    expect(schema.properties.apiKey).toMatchObject({ type: 'string', writeOnly: true });
    const credential = (
      await api(key, 'POST', '/credentials', { name: 'k', type: 'testApi', data: { apiKey: 'z' } })
    ).json().data;
    expect(credential).toEqual({ id: credential.id, name: 'k', type: 'testApi' });
    expect((await api(key, 'DELETE', `/credentials/${credential.id}`)).json().data).toEqual({ ok: true });

    const tag = (await api(key, 'POST', '/tags', { name: 'api' })).json().data;
    expect((await api(key, 'PUT', `/tags/${tag.id}`, { name: 'api2' })).json().data.name).toBe('api2');
    expect((await api(key, 'GET', '/tags')).json().data).toHaveLength(1);
    expect((await api(key, 'DELETE', `/tags/${tag.id}`)).statusCode).toBe(200);

    const variable = (await api(key, 'POST', '/variables', { key: 'REGION', value: 'eu' })).json().data;
    expect((await api(key, 'PUT', `/variables/${variable.id}`, { value: 'us' })).json().data.value).toBe(
      'us',
    );
    expect((await api(key, 'GET', '/variables')).json().data[0]).toMatchObject({
      key: 'REGION',
      value: 'us',
    });
    expect((await api(key, 'DELETE', `/variables/${variable.id}`)).statusCode).toBe(200);

    expect((await api(key, 'DELETE', `/workflows/${wf.id}`)).json().data).toEqual({ ok: true });
    expect((await api(key, 'GET', `/workflows/${wf.id}`)).statusCode).toBe(404);
  });

  it('applies the key owner role', async () => {
    const { key } = await apiKey('viewer');
    expect((await api(key, 'GET', '/workflows')).statusCode).toBe(200);
    const res = await api(key, 'POST', '/workflows', { name: 'x', nodes: [] });
    expect(res.statusCode).toBe(403);
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const res = await server.app.inject({ url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes.ApiKey).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-KEY',
    });
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/workflows',
        '/workflows/{id}',
        '/workflows/{id}/activate',
        '/executions',
        '/executions/{id}/retry',
        '/credentials',
        '/credentials/schema/{type}',
        '/tags',
        '/variables/{id}',
      ]),
    );
    const create = doc.paths['/workflows'].post;
    expect(create.requestBody.content['application/json'].schema.properties.nodes.type).toBe('array');
    expect(doc.paths['/workflows/{id}'].get.parameters[0]).toMatchObject({
      name: 'id',
      in: 'path',
      required: true,
    });
  });
});

describe('system endpoints', () => {
  it('serves health, readiness and Prometheus metrics', async () => {
    expect((await server.app.inject({ url: '/healthz' })).json()).toEqual({ status: 'ok' });
    expect((await server.app.inject({ url: '/healthz/readiness' })).json()).toEqual({
      status: 'ok',
      checks: { database: 'ok' },
    });

    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Start', 'core.manualTrigger')] });
    const { executionId } = await client.data(client.post(`/rest/workflows/${wf.id}/run`, {}));
    await waitForExecution(server.ctx, tenant.id, executionId);
    const metrics = await server.app.inject({ url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toMatch(/workflow_executions_total\{status="success",mode="manual"\} \d+/);
    expect(metrics.body).toContain('workflow_execution_duration_seconds_bucket');
    expect(metrics.body).toContain('workflow_active_workflows 0');
    expect(metrics.body).toContain('workflow_webhook_duration_seconds');
  });

  it('protects metrics with METRICS_TOKEN when set', async () => {
    const guarded = await createTestServer({ METRICS_TOKEN: 'm-token' }, { startMain: false, reset: false });
    try {
      expect((await guarded.app.inject({ url: '/metrics' })).statusCode).toBe(401);
      const ok = await guarded.app.inject({ url: '/metrics', headers: { authorization: 'Bearer m-token' } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await guarded.close();
    }
  });

  it('returns branding and limits from /rest/settings with tenant overrides', async () => {
    const anonymous = (await server.app.inject({ url: '/rest/settings' })).json().data;
    expect(anonymous).toMatchObject({
      brand: { name: 'Workflow' },
      baseUrl: 'http://localhost:5678',
      webhookBaseUrl: 'http://localhost:5678/webhook',
      timezone: 'UTC',
      features: { signup: true, executionsMode: 'regular' },
    });
    const { client, tenant } = await signup(server.app);
    await client.data(
      client.patch('/rest/settings', {
        brand: { name: 'Acme Flows', primaryColor: '#ff0000' },
        timezone: 'Europe/Berlin',
      }),
    );
    const settings = await client.data(client.get('/rest/settings'));
    expect(settings).toMatchObject({
      brand: { name: 'Acme Flows', primaryColor: '#ff0000' },
      webhookBaseUrl: `http://localhost:5678/webhook/${tenant.slug}`,
      timezone: 'Europe/Berlin',
      limits: { executionsPerMonth: null },
    });
    expect((await client.patch('/rest/settings', { timezone: 'Mars/Base' })).statusCode).toBe(400);
  });

  it('serves the editor with an SPA fallback that never shadows API routes', async () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'editor-dist-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Editor</title><div id="root"></div>');
    writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log(1)');
    const withEditor = await createTestServer({ EDITOR_DIST: dist }, { startMain: false, reset: false });
    try {
      const index = await withEditor.app.inject({ url: '/', headers: { accept: 'text/html' } });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('<title>Editor</title>');
      expect(index.headers['content-security-policy']).toContain("script-src 'self'");
      expect(index.headers['x-frame-options']).toBeDefined();
      const deep = await withEditor.app.inject({
        url: '/workflow/123/executions',
        headers: { accept: 'text/html' },
      });
      expect(deep.body).toContain('<title>Editor</title>');
      const asset = await withEditor.app.inject({ url: '/assets/app-123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
      for (const url of ['/rest/nope', '/api/v1/nope', '/webhook-test/x', '/healthz/nope', '/metrics/x']) {
        const res = await withEditor.app.inject({ url, headers: { accept: 'text/html' } });
        expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
        expect(res.json().error.code).toBe('not_found');
      }
    } finally {
      await withEditor.close();
    }
    // without a built editor a small status page is served
    const status = await server.app.inject({ url: '/', headers: { accept: 'text/html' } });
    expect(status.body).toContain('The API server is running');
  });

  it('runs loadOptions methods for the node details view', async () => {
    const { client } = await signup(server.app);
    const res = await client.post('/rest/node-types/options', {
      nodeType: 'core.set',
      method: 'nope',
      kind: 'loadOptions',
      node: node('Set', 'core.set'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/has no loadOptions method/);
  });
});

describe('configuration', () => {
  it('fails fast on missing secrets in production and validates values', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', ENCRYPTION_KEYS: `a:${'A'.repeat(44)}` })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).toThrow(
      /ENCRYPTION_KEYS/,
    );
    expect(() => loadConfig({ EXECUTIONS_MODE: 'queue' })).toThrow(/REDIS_URL/);
    expect(() => loadConfig({ ENCRYPTION_KEYS: 'k1:c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    const key = Buffer.alloc(32, 1).toString('base64');
    const config = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://db/x',
      ENCRYPTION_KEYS: `k2:${key},k1:${key}`,
      BASE_URL: 'https://flows.example.com/',
      CORS_ORIGINS: 'https://admin.example.com',
      SSRF_ALLOW: '10.0.0.0/8, api.internal',
    });
    expect(config.baseUrl).toBe('https://flows.example.com');
    expect(config.cookieSecure).toBe(true);
    expect(config.encryptionKeys.map((k) => k.id)).toEqual(['k2', 'k1']);
    expect(config.allowedOrigins).toEqual(['https://flows.example.com', 'https://admin.example.com']);
    expect(config.ssrf).toEqual({ enabled: true, allow: ['10.0.0.0/8', 'api.internal'], deny: [] });
    expect(config.port).toBe(5678);
  });
});
