/**
 * Phase 4 contract step (C0c): server wiring in existing files. Form routes, webhook URL bases,
 * listen answers, API key scopes, favorites, config, redaction, context and helpers. Stub return
 * values are never asserted (lanes fill those); a stub only proves its route is wired and gated.
 */
import { Writable } from 'node:stream';
import { PyodideCodeRunner } from '@workflow/core';
import type { DataObject, NodePackage, NodeType, TriggerContext, WebhookResponse } from '@workflow/workflow';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { API_KEY_SCOPES, assertApiKeyScope } from '../src/http/api-key-scopes';
import { createLogger, redactUrl } from '../src/logger';
import { dataTableQuotaBytes, effectiveLimits, PLANS } from '../src/plans';
import { PUBLIC_ROUTES } from '../src/routes/public-api';
import { testCredential } from '../src/services/credential-test';
import type { SecretProviderType } from '../src/services/secrets/types';
import { webhookUrlBase } from '../src/services/webhook-paths';
import {
  BASE_URL,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup as signupFrom,
  TEST_REDIS,
  TestClient,
  type TestServer,
  testConfig,
  waitFor,
} from './helpers';

vi.mock('../src/http/api-key-scopes', async (original) => {
  const actual = await original<typeof import('../src/http/api-key-scopes')>();
  return { ...actual, assertApiKeyScope: vi.fn(actual.assertApiKeyScope) };
});
vi.mock('../src/services/credential-test', async (original) => {
  const actual = await original<typeof import('../src/services/credential-test')>();
  return { ...actual, testCredential: vi.fn(actual.testCredential) };
});

/** a form-trigger-like node that records the URL its lifecycle hook is given */
const lifecycleUrls: string[] = [];
const lifecycleNode: NodeType = {
  description: {
    name: 'test.formLifecycle',
    displayName: 'Form lifecycle',
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Form lifecycle' },
    inputs: [],
    outputs: ['main'],
    properties: [],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'hook', nodeType: 'form' }],
  },
  webhookMethods: {
    default: {
      async checkExists() {
        return false;
      },
      async create(ctx) {
        lifecycleUrls.push(ctx.getNodeWebhookUrl('default') ?? '');
        return true;
      },
      async delete() {
        return true;
      },
    },
  },
  async webhook() {
    return { workflowData: [[{ json: {} }]] };
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
};

/** a trigger that hands its context to the test, so the test can call emit */
let triggerContext: TriggerContext | undefined;
const emitterNode: NodeType = {
  description: {
    name: 'test.emitter',
    displayName: 'Emitter',
    description: '',
    group: ['trigger'],
    version: 1,
    defaults: { name: 'Emitter' },
    inputs: [],
    outputs: ['main'],
    properties: [],
  },
  async trigger(ctx) {
    triggerContext = ctx;
    return {};
  },
  async execute(ctx) {
    return [ctx.getInputData()];
  },
};

const extraPackage: NodePackage = {
  name: 'p4-contracts',
  nodes: [lifecycleNode, emitterNode],
  credentials: [],
};

const fakeProvider: SecretProviderType = {
  name: 'p4Fake',
  displayName: 'P4 fake',
  properties: [],
  create() {
    throw new Error('never created in this test');
  },
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer(
    { LOGIN_RATE_LIMIT_MAX: '1000' },
    { nodePackages: [extraPackage], secretProviderTypes: [fakeProvider] },
  );
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  lifecycleUrls.length = 0;
  triggerContext = undefined;
  vi.mocked(assertApiKeyScope).mockClear();
  vi.mocked(testCredential).mockClear();
});

const pool = () => server.ctx.database.pool;

/** this file signs up more often than the 20 per hour one IP may */
let signups = 0;
const signup = (app: TestServer['app']) => signupFrom(app, { remoteAddress: `10.0.0.${++signups}` });

async function member(owner: Awaited<ReturnType<typeof signup>>, role: 'admin' | 'editor' | 'viewer') {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invite = await owner.client.data(owner.client.post('/rest/members/invite', { email, role }));
  const client = new TestClient(server.app);
  await client.data(
    client.post(`/rest/invitations/${invite.token}/accept`, { name: role, password: 'Passw0rd!' }),
  );
  return client;
}

const formTrigger = (path: string) => node('Form', 'core.formTrigger', { path });
const webhookNode = (path: string) => node('Hook', 'core.webhook', { path, httpMethod: 'POST' });

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

describe('form routes', () => {
  it('/form and /form-test look a path up like webhooks, /form-waiting checks the signature', async () => {
    const owner = await signup(server.app);
    const form = await server.app.inject({ method: 'GET', url: `/form/${owner.tenant.slug}/nothing` });
    expect(form.statusCode).toBe(404);
    expect(form.json().error.message).toContain('is not registered');

    const test = await server.app.inject({ method: 'POST', url: `/form-test/${owner.tenant.slug}/nothing` });
    expect(test.statusCode).toBe(404);
    expect(test.json().error.message).toContain('Listen for test event');

    for (const url of [`/form-waiting/${UNKNOWN_ID}`, `/form-waiting/${UNKNOWN_ID}/forged`]) {
      const waiting = await server.app.inject({ method: 'GET', url });
      expect(waiting.statusCode).toBe(404);
      expect(waiting.json().error.message).toBe('Execution not found');
    }
  });

  it('answers a preflight on a form path', async () => {
    const owner = await signup(server.app);
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: `/form/${owner.tenant.slug}/nothing`,
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it('a form page is sandboxed like a webhook answer', async () => {
    const owner = await signup(server.app);
    const res = await server.app.inject({ method: 'GET', url: `/form/${owner.tenant.slug}/nothing` });
    expect(res.headers['content-security-policy']).toContain('sandbox');
  });

  it('the SPA never answers the form paths, but keeps /form-auth', async () => {
    const accept = { accept: 'text/html' };
    for (const url of ['/form', '/form-test', '/form-waiting']) {
      const res = await server.app.inject({ method: 'GET', url, headers: accept });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('json');
    }
    const auth = await server.app.inject({ method: 'GET', url: '/form-auth', headers: accept });
    expect(auth.statusCode).toBe(200);
    expect(auth.headers['content-type']).toContain('text/html');
  });

  it('a listening form trigger is reached at /form-test, and /webhook does not change', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [formTrigger('sign-up')] });
    await owner.client.data(
      owner.client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Form' }),
    );
    const reached = await server.app.inject({
      method: 'GET',
      url: `/form-test/${owner.tenant.slug}/sign-up`,
    });
    expect(reached.statusCode).not.toBe(404);

    const hook = await createWorkflow(owner.client, { nodes: [webhookNode('orders')] });
    await owner.client.data(owner.client.post(`/rest/workflows/${hook.id}/activate`));
    const answered = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/orders`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(answered.statusCode).toBe(200);
    expect(
      (await server.app.inject({ method: 'POST', url: `/webhook/${owner.tenant.slug}/nope` })).statusCode,
    ).toBe(404);
  });
});

describe('webhook URL base', () => {
  it('webhookUrlBase names the prefix by the hook description', () => {
    expect(webhookUrlBase({ nodeType: 'form' })).toBe('form');
    expect(webhookUrlBase({})).toBe('webhook');
  });

  it('webhook-urls gives a form trigger form URLs and a webhook webhook URLs', async () => {
    const owner = await signup(server.app);
    const slug = owner.tenant.slug;
    const wf = await createWorkflow(owner.client, {
      nodes: [formTrigger('sign-up'), webhookNode('orders')],
    });
    const urls = await owner.client.data<Array<{ nodeName: string; testUrl: string; productionUrl: string }>>(
      owner.client.get(`/rest/workflows/${wf.id}/webhook-urls`),
    );
    const form = urls.filter((u) => u.nodeName === 'Form');
    expect(form.length).toBeGreaterThan(0);
    for (const url of form) {
      expect(url.testUrl).toBe(`${BASE_URL}/form-test/${slug}/sign-up`);
      expect(url.productionUrl).toBe(`${BASE_URL}/form/${slug}/sign-up`);
    }
    const hook = urls.find((u) => u.nodeName === 'Hook');
    expect(hook?.testUrl).toBe(`${BASE_URL}/webhook-test/${slug}/orders`);
    expect(hook?.productionUrl).toBe(`${BASE_URL}/webhook/${slug}/orders`);
  });

  it('a lifecycle hook gets the form URL, production and test', async () => {
    const owner = await signup(server.app);
    const slug = owner.tenant.slug;
    const lifecycle = node('Life', 'test.formLifecycle', {}, [0, 0], { webhookId: 'life' });
    const wf = await createWorkflow(owner.client, { nodes: [lifecycle] });
    await owner.client.data(
      owner.client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Life' }),
    );
    expect(lifecycleUrls.at(-1)).toBe(`${BASE_URL}/form-test/${slug}/life/hook`);
    await owner.client.request('DELETE', `/rest/workflows/${wf.id}/listen-test-webhook`, {
      nodeName: 'Life',
    });
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    expect(lifecycleUrls.at(-1)).toBe(`${BASE_URL}/form/${slug}/life/hook`);
  });
});

describe('listen', () => {
  it("a form trigger's listen answers its form test URL once", async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [formTrigger('sign-up')] });
    const listen = await owner.client.data(
      owner.client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Form' }),
    );
    const url = `${BASE_URL}/form-test/${owner.tenant.slug}/sign-up`;
    expect(listen.testUrl).toBe(url);
    expect(listen.formTestUrls).toEqual([url]);
  });

  it('any other webhook answers an empty list', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [webhookNode('orders')] });
    const listen = await owner.client.data(
      owner.client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: 'Hook' }),
    );
    expect(listen.testUrl).toBe(`${BASE_URL}/webhook-test/${owner.tenant.slug}/orders`);
    expect(listen.formTestUrls).toEqual([]);
  });

  it('listen-test-trigger is 404 for an editor on an unknown workflow, 403 for a viewer, 401 signed out', async () => {
    const owner = await signup(server.app);
    const viewer = await member(owner, 'viewer');
    const editor = await member(owner, 'editor');
    const url = `/rest/workflows/${UNKNOWN_ID}/listen-test-trigger`;
    expect((await new TestClient(server.app).post(url, { nodeName: 'A' })).statusCode).toBe(401);
    expect((await viewer.post(url, { nodeName: 'A' })).statusCode).toBe(403);
    expect((await viewer.delete(url)).statusCode).toBe(403);
    expect((await editor.post(url, { nodeName: 'A' })).statusCode).toBe(404);
    expect((await editor.post(url, {})).statusCode).toBe(400);
    expect((await editor.delete(url)).statusCode).toBe(404);
  });
});

describe('trigger emit', () => {
  it('passes the response hook on, and resolves the run result the contract names', async () => {
    const owner = await signup(server.app);
    const wf = await createWorkflow(owner.client, { nodes: [node('Emit', 'test.emitter')] });
    await owner.client.data(owner.client.post(`/rest/workflows/${wf.id}/activate`));
    const ctx = await waitFor(async () => triggerContext);

    const manager = server.ctx.activeWorkflows as unknown as {
      startFromTrigger(...args: unknown[]): Promise<boolean>;
    };
    const spy = vi.spyOn(manager, 'startFromTrigger');
    const hook = (_response: WebhookResponse) => {};
    const result = await new Promise<unknown>((resolve, reject) => {
      ctx.emit([[{ json: { a: 1 } }]], { resolve, reject }, hook);
    });
    expect(spy.mock.calls[0].includes(hook)).toBe(true);
    spy.mockRestore();
    expect(result).toEqual({ executionId: expect.any(String), status: 'success' });
  });
});

describe('API key scopes', () => {
  it('POST /api-keys stores the scopes and GET lists them', async () => {
    const owner = await signup(server.app);
    const created = await owner.client.data(
      owner.client.post('/rest/api-keys', { name: 'rows', scopes: ['dataTableRow:read', 'workflow:list'] }),
    );
    expect(created.scopes).toEqual(['dataTableRow:read', 'workflow:list']);
    const listed = await owner.client.data<Array<{ id: string; scopes: string[] }>>(
      owner.client.get('/rest/api-keys'),
    );
    expect(listed.find((k) => k.id === created.id)?.scopes).toEqual(['dataTableRow:read', 'workflow:list']);
  });

  it('no scopes means an empty list, an unknown scope is refused', async () => {
    const owner = await signup(server.app);
    const plain = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'all' }));
    expect(plain.scopes).toEqual([]);
    const empty = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'all2', scopes: [] }));
    expect(empty.scopes).toEqual([]);
    const bad = await owner.client.post('/rest/api-keys', { name: 'bad', scopes: ['nope:nope'] });
    expect(bad.statusCode).toBe(400);
  });

  it('authenticateApiKey returns the scopes of the key', async () => {
    const owner = await signup(server.app);
    const created = await owner.client.data(
      owner.client.post('/rest/api-keys', { name: 'x', scopes: ['tag:list'] }),
    );
    const auth = await server.ctx.auth.authenticateApiKey(created.key);
    expect(auth?.apiKeyScopes).toEqual(['tag:list']);
  });

  it('every public route names a scope from API_KEY_SCOPES', () => {
    const known = new Set<string>(API_KEY_SCOPES);
    for (const route of PUBLIC_ROUTES) {
      expect(known.has(String(route.scope)), `${route.method} ${route.path}`).toBe(true);
    }
  });

  it("the existing public routes carry n8n's scopes", () => {
    const scopes = Object.fromEntries(
      PUBLIC_ROUTES.filter((r) => r.tag !== 'DataTable').map((r) => [`${r.method} ${r.path}`, r.scope]),
    );
    expect(scopes).toEqual({
      'GET /workflows': 'workflow:list',
      'POST /workflows': 'workflow:create',
      'GET /workflows/:id': 'workflow:read',
      'PUT /workflows/:id': 'workflow:update',
      'DELETE /workflows/:id': 'workflow:delete',
      'POST /workflows/:id/activate': 'workflow:activate',
      'POST /workflows/:id/archive': 'workflow:delete',
      'POST /workflows/:id/unarchive': 'workflow:delete',
      'POST /workflows/:id/deactivate': 'workflow:deactivate',
      'GET /executions': 'execution:list',
      'GET /executions/:id': 'execution:read',
      'DELETE /executions/:id': 'execution:delete',
      'POST /executions/:id/retry': 'execution:retry',
      'POST /credentials': 'credential:create',
      'DELETE /credentials/:id': 'credential:delete',
      'GET /credentials/schema/:type': 'credential:read',
      'GET /tags': 'tag:list',
      'POST /tags': 'tag:create',
      'GET /tags/:id': 'tag:read',
      'PUT /tags/:id': 'tag:update',
      'DELETE /tags/:id': 'tag:delete',
      'GET /variables': 'variable:list',
      'POST /variables': 'variable:create',
      'PUT /variables/:id': 'variable:update',
      'DELETE /variables/:id': 'variable:delete',
      'GET /folders': 'folder:list',
      'POST /folders': 'folder:create',
      'GET /folders/:folderId': 'folder:read',
      'PATCH /folders/:folderId': 'folder:update',
      'DELETE /folders/:folderId': 'folder:delete',
    });
  });

  it("the 16 data-table routes are public rows with n8n's tag", () => {
    const rows = PUBLIC_ROUTES.filter((r) => r.tag === 'DataTable');
    expect(rows).toHaveLength(16);
    expect(new Set(rows.map((r) => r.scope))).toEqual(
      new Set([
        'dataTable:list',
        'dataTable:create',
        'dataTable:read',
        'dataTable:update',
        'dataTable:delete',
        'dataTableColumn:create',
        'dataTableColumn:read',
        'dataTableColumn:update',
        'dataTableColumn:delete',
        'dataTableRow:create',
        'dataTableRow:read',
        'dataTableRow:update',
        'dataTableRow:upsert',
        'dataTableRow:delete',
      ]),
    );
  });

  it('the public handler checks the scope, after the role', async () => {
    const owner = await signup(server.app);
    const key = await owner.client.data(owner.client.post('/rest/api-keys', { name: 'k' }));
    const res = await server.app.inject({
      method: 'GET',
      url: '/api/v1/workflows',
      headers: { 'x-api-key': key.key },
    });
    expect(res.statusCode).toBe(200);
    expect(assertApiKeyScope).toHaveBeenCalledTimes(1);
    const [auth, scope] = vi.mocked(assertApiKeyScope).mock.calls[0];
    expect(auth.apiKeyId).toBe(key.id);
    expect(auth.apiKeyScopes).toEqual([]);
    expect(scope).toBe('workflow:list');

    vi.mocked(assertApiKeyScope).mockClear();
    const viewer = await member(owner, 'viewer');
    const viewerKey = await viewer.data(viewer.post('/rest/api-keys', { name: 'v' }));
    const refused = await server.app.inject({
      method: 'POST',
      url: '/api/v1/data-tables',
      headers: { 'x-api-key': viewerKey.key, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'a', columns: [] }),
    });
    expect(refused.statusCode).toBe(403);
    expect(assertApiKeyScope).not.toHaveBeenCalled();
  });

  it('the OpenAPI document holds the data-table routes and every reference resolves', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.paths['/data-tables']).toBeDefined();
    expect(doc.paths['/data-tables/{dataTableId}/rows/upsert'].post).toBeDefined();
    const refs = [...res.body.matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    expect(refs).toContain('DataTableRow');
    for (const name of new Set(refs)) expect(doc.components.schemas[name], name).toBeDefined();
  });
});

describe('every new /rest route requires its role', () => {
  const id = UNKNOWN_ID;
  const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string, 'viewer' | 'editor' | 'admin']> = [
    ['GET', '/data-tables', 'viewer'],
    ['GET', '/data-tables/limits', 'viewer'],
    ['POST', '/data-tables', 'editor'],
    ['POST', '/data-tables/csv/preview', 'editor'],
    ['GET', `/data-tables/${id}`, 'viewer'],
    ['PATCH', `/data-tables/${id}`, 'editor'],
    ['DELETE', `/data-tables/${id}`, 'editor'],
    ['GET', `/data-tables/${id}/dependencies`, 'viewer'],
    ['GET', `/data-tables/${id}/columns`, 'viewer'],
    ['POST', `/data-tables/${id}/columns`, 'editor'],
    ['DELETE', `/data-tables/${id}/columns/${id}`, 'editor'],
    ['PATCH', `/data-tables/${id}/columns/${id}/move`, 'editor'],
    ['PATCH', `/data-tables/${id}/columns/${id}/rename`, 'editor'],
    ['GET', `/data-tables/${id}/rows`, 'viewer'],
    ['POST', `/data-tables/${id}/insert`, 'editor'],
    ['POST', `/data-tables/${id}/upsert`, 'editor'],
    ['PATCH', `/data-tables/${id}/rows`, 'editor'],
    ['DELETE', `/data-tables/${id}/rows`, 'editor'],
    ['DELETE', `/data-tables/${id}/rows/clear`, 'editor'],
    ['GET', `/data-tables/${id}/download-csv`, 'viewer'],
    ['POST', `/data-tables/${id}/import-csv`, 'editor'],
    ['GET', '/secret-providers/types', 'admin'],
    ['GET', '/secret-providers/types/vault', 'admin'],
    ['GET', '/secret-providers/connections', 'admin'],
    ['POST', '/secret-providers/connections', 'admin'],
    ['GET', '/secret-providers/connections/abc', 'admin'],
    ['PATCH', '/secret-providers/connections/abc', 'admin'],
    ['DELETE', '/secret-providers/connections/abc', 'admin'],
    ['POST', '/secret-providers/connections/abc/test', 'admin'],
    ['POST', '/secret-providers/connections/abc/reload', 'admin'],
    ['GET', '/secret-providers/completions/secrets', 'editor'],
    ['POST', '/form-auth/code', 'viewer'],
    ['POST', `/workflows/${id}/listen-test-trigger`, 'editor'],
    ['DELETE', `/workflows/${id}/listen-test-trigger`, 'editor'],
    ['GET', `/active-workflows/error/${id}`, 'viewer'],
  ];

  it('signed out 401, below the role 403, at the role the route answers', async () => {
    const owner = await signup(server.app);
    const clients = {
      viewer: await member(owner, 'viewer'),
      editor: await member(owner, 'editor'),
      admin: await member(owner, 'admin'),
    };
    const below = { viewer: undefined, editor: clients.viewer, admin: clients.editor };
    const anonymous = new TestClient(server.app);
    for (const [method, path, role] of routes) {
      const url = `/rest${path}`;
      const label = `${method} ${path}`;
      const body = method === 'GET' || method === 'DELETE' ? undefined : {};
      expect((await anonymous.request(method, url, body)).statusCode, label).toBe(401);
      const lower = below[role];
      if (lower) expect((await lower.request(method, url, body)).statusCode, label).toBe(403);
      const res = await clients[role].request(method, url, body);
      // past the role gate: the handler answers (an unknown id is a 404, a bad body or id a 400)
      expect([200, 400, 404], `${label} ${res.body}`).toContain(res.statusCode);
    }
  });
});

describe('favorites', () => {
  const tableIn = async (tenantId: string, name: string) => {
    const { rows } = await pool().query<{ id: string }>(
      'insert into data_tables (tenant_id, name) values ($1, $2) returning id',
      [tenantId, name],
    );
    return rows[0].id;
  };

  it('the route takes dataTable and still refuses other types', async () => {
    const owner = await signup(server.app);
    const taken = await owner.client.post('/rest/favorites', {
      resourceType: 'dataTable',
      resourceId: UNKNOWN_ID,
    });
    expect(taken.statusCode).not.toBe(400);
    const refused = await owner.client.post('/rest/favorites', {
      resourceType: 'chart',
      resourceId: UNKNOWN_ID,
    });
    expect(refused.statusCode).toBe(400);
  });

  it('asks the data-table repository, within the tenant', async () => {
    const owner = await signup(server.app);
    const get = vi.spyOn(server.ctx.repos.dataTables, 'get').mockResolvedValueOnce(undefined);
    const res = await owner.client.post('/rest/favorites', {
      resourceType: 'dataTable',
      resourceId: UNKNOWN_ID,
    });
    expect(res.statusCode).toBe(404);
    expect(get).toHaveBeenCalledWith(owner.tenant.id, UNKNOWN_ID);
    get.mockRestore();
  });

  it('lists a favorite table with its current name and removes it', async () => {
    const owner = await signup(server.app);
    const tableId = await tableIn(owner.tenant.id, 'Orders');
    await server.ctx.repos.favorites.add(owner.tenant.id, owner.user.id, 'dataTable', tableId);
    await pool().query('update data_tables set name = $1 where id = $2', ['Orders 2', tableId]);
    const listed = await owner.client.data<Array<{ resourceType: string; resourceId: string; name: string }>>(
      owner.client.get('/rest/favorites'),
    );
    expect(listed).toEqual([
      expect.objectContaining({ resourceType: 'dataTable', resourceId: tableId, name: 'Orders 2' }),
    ]);
    await owner.client.data(owner.client.delete(`/rest/favorites/dataTable/${tableId}`));
    expect(await owner.client.data(owner.client.get('/rest/favorites'))).toEqual([]);
  });

  it('leaves out a table that is gone and one of another tenant', async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const foreign = await tableIn(other.tenant.id, 'Theirs');
    const gone = await tableIn(owner.tenant.id, 'Gone');
    await server.ctx.repos.favorites.add(owner.tenant.id, owner.user.id, 'dataTable', foreign);
    await server.ctx.repos.favorites.add(owner.tenant.id, owner.user.id, 'dataTable', gone);
    await pool().query('delete from data_tables where id = $1', [gone]);
    expect(await owner.client.data(owner.client.get('/rest/favorites'))).toEqual([]);
  });
});

describe('config, plans and logger', () => {
  const MIB = 1024 * 1024;

  it('has the defaults of the plan', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.dataTables).toEqual({
      maxSizeBytes: 200 * MIB,
      warningThresholdBytes: 160 * MIB,
      sizeCheckCacheDurationMs: 5000,
      uploadMaxFileSizeBytes: undefined,
    });
    expect(config.python).toEqual({
      enabled: true,
      stdlibAllow: [],
      externalAllow: [],
      builtinsDeny: expect.arrayContaining([
        'eval',
        'exec',
        'open',
        'getattr',
        '__build_class__',
        'copyright',
      ]),
      allowTransitiveImports: false,
      maxConcurrency: 5,
      wheelsDir: '',
    });
    expect(config.python.builtinsDeny).toHaveLength(22);
    expect(config.externalSecrets).toEqual({
      updateIntervalS: 300,
      connectTimeoutS: 20,
      refreshTimeoutS: 20,
      preferGet: false,
    });
  });

  it('reads the settings from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_TABLES_MAX_SIZE_BYTES: String(10 * MIB),
      DATA_TABLES_UPLOAD_MAX_FILE_SIZE_BYTES: String(MIB),
      PYTHON_ENABLED: 'false',
      RUNNERS_STDLIB_ALLOW: 'json, math',
      RUNNERS_BUILTINS_DENY: '',
      RUNNERS_ALLOW_TRANSITIVE_IMPORTS: 'true',
      RUNNERS_MAX_CONCURRENCY: '2',
      EXTERNAL_SECRETS_PREFER_GET: 'true',
      EXTERNAL_SECRETS_UPDATE_INTERVAL: '60',
    });
    expect(config.dataTables.warningThresholdBytes).toBe(8 * MIB);
    expect(config.dataTables.uploadMaxFileSizeBytes).toBe(MIB);
    expect(config.python.enabled).toBe(false);
    expect(config.python.stdlibAllow).toEqual(['json', 'math']);
    expect(config.python.builtinsDeny).toEqual([]);
    expect(config.python.allowTransitiveImports).toBe(true);
    expect(config.python.maxConcurrency).toBe(2);
    expect(config.externalSecrets.preferGet).toBe(true);
    expect(config.externalSecrets.updateIntervalS).toBe(60);
  });

  it('the upload limit is the smallest of setting, remaining space and body limit', async () => {
    const { dataTableUploadLimitBytes } = await import('../src/config');
    const config = loadConfig({ NODE_ENV: 'test', BODY_LIMIT_MB: '16' });
    expect(dataTableUploadLimitBytes(config, 100 * MIB)).toBe(16 * MIB);
    expect(dataTableUploadLimitBytes(config, 3 * MIB)).toBe(3 * MIB);
    expect(dataTableUploadLimitBytes(config, -1)).toBe(0);
    const set = loadConfig({
      NODE_ENV: 'test',
      BODY_LIMIT_MB: '16',
      DATA_TABLES_UPLOAD_MAX_FILE_SIZE_BYTES: String(MIB),
    });
    expect(dataTableUploadLimitBytes(set, 100 * MIB)).toBe(MIB);
  });

  it('a plan may override the data-table quota; null means the instance setting', () => {
    for (const plan of Object.values(PLANS)) expect(plan.dataTableBytes).toBeNull();
    const config = testConfig();
    expect(dataTableQuotaBytes(config, effectiveLimits('starter', null))).toBe(
      config.dataTables.maxSizeBytes,
    );
    expect(
      dataTableQuotaBytes(config, effectiveLimits('starter', { limits: { dataTableBytes: 1000 } })),
    ).toBe(1000);
  });

  it('redacts the new secret fields', () => {
    const lines: string[] = [];
    const logger = createLogger(
      'info',
      {},
      new Writable({
        write(chunk, _encoding, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    const secrets: DataObject = {
      secretAccessKey: 'leak-1',
      serviceAccountKey: 'leak-2',
      secretId: 'leak-3',
      privateKey: 'leak-4',
      passphrase: 'leak-5',
      settingsEnc: 'leak-6',
      settings_enc: 'leak-7',
    };
    logger.info({ settings: secrets, req: { headers: { 'x-auth-token': 'leak-8' } } }, 'm');
    const line = lines.join('');
    expect(line).not.toContain('leak-');
    expect(JSON.parse(line).settings.privateKey).toBe('[redacted]');
  });

  it('never logs the signature of a form resume URL', () => {
    expect(redactUrl(`/form-waiting/${UNKNOWN_ID}/secret-signature`)).toBe('/form-waiting/[redacted]');
    expect(redactUrl('/form/acme/sign-up')).toBe('/form/acme/sign-up');
  });
});

describe('execution services', () => {
  const services = async (ctx: TestServer['ctx'], tenantId: string, executionId: string) => {
    const tenant = (await ctx.repos.tenants.get(tenantId))!;
    return ctx.executions.buildServices({ tenant, executionId, mode: 'manual', workflowId: UNKNOWN_ID });
  };

  it('resumeFormUrl is /form-waiting/<id> with its own signature', async () => {
    const owner = await signup(server.app);
    const built = await services(server.ctx, owner.tenant.id, UNKNOWN_ID);
    const signature = String(built.resumeFormUrl).split('/').at(-1) ?? '';
    expect(built.resumeFormUrl).toBe(`${BASE_URL}/form-waiting/${UNKNOWN_ID}/${signature}`);
    expect(signature).not.toBe(built.resumeUrl?.split('/').at(-1));
    expect(server.ctx.executions.verifyResumeSignature(UNKNOWN_ID, signature, 'form')).toBe(true);
    expect(server.ctx.executions.verifyResumeSignature(UNKNOWN_ID, signature)).toBe(false);
    expect((await services(server.ctx, owner.tenant.id, '')).resumeFormUrl).toBeUndefined();
  });

  it('a signed resume form URL passes the signature check on the route', async () => {
    const owner = await signup(server.app);
    const built = await services(server.ctx, owner.tenant.id, UNKNOWN_ID);
    const signed = await server.app.inject({
      method: 'GET',
      url: String(built.resumeFormUrl).replace(BASE_URL, ''),
    });
    // the id is unknown: past the signature, findTenantOf answers the same 404
    expect(signed.statusCode).toBe(404);
    const verify = vi.spyOn(server.ctx.executions, 'verifyResumeSignature');
    await server.app.inject({ method: 'GET', url: String(built.resumeFormUrl).replace(BASE_URL, '') });
    expect(verify).toHaveReturnedWith(true);
    verify.mockRestore();
  });

  it('hands nodes the data tables, form tokens, form auth and the python runner', async () => {
    const owner = await signup(server.app);
    const built = await services(server.ctx, owner.tenant.id, UNKNOWN_ID);
    expect(typeof built.dataTables?.insertRows).toBe('function');
    expect(built.formTokens).toBe(server.ctx.formTokens);
    expect(built.formAuth).toBe(server.ctx.formAuth);
    expect(built.pythonRunner).toBeInstanceOf(PyodideCodeRunner);
  });

  it('binds the data tables to the tenant and the workflow', async () => {
    const owner = await signup(server.app);
    const forTenant = vi.spyOn(server.ctx.dataTables, 'forTenant');
    await services(server.ctx, owner.tenant.id, UNKNOWN_ID);
    expect(forTenant).toHaveBeenCalledWith(owner.tenant.id, { workflowId: UNKNOWN_ID });
    forTenant.mockRestore();
  });

  it('runActivationErrorWorkflow is public', () => {
    expect(typeof server.ctx.executions.runActivationErrorWorkflow).toBe('function');
  });
});

describe('credential test', () => {
  it('the route hands the node types, tenant and logger to testCredential', async () => {
    const owner = await signup(server.app);
    const res = await owner.client.post('/rest/credentials/test', {
      type: 'httpHeaderAuth',
      data: { name: 'x', value: 'y' },
    });
    expect(res.statusCode).toBe(200);
    const opts = vi.mocked(testCredential).mock.calls[0][4];
    expect(opts?.nodeTypes).toBe(server.ctx.registries.nodeTypes);
    expect(opts?.tenantId).toBe(owner.tenant.id);
    expect(typeof opts?.logger.warn).toBe('function');
  });
});

describe('context and test helpers', () => {
  it('createTestServer adds a test node package and a test provider type', async () => {
    expect(server.ctx.registries.nodeTypes.get('test.emitter')).toBeDefined();
    expect(server.ctx.secrets.getType('p4Fake')).toBeDefined();
    const owner = await signup(server.app);
    const types = await owner.client.data<Array<{ name: string }>>(
      owner.client.get('/rest/secret-providers/types'),
    );
    expect(types.map((t) => t.name)).toContain('p4Fake');
  });

  it('the python runner follows PYTHON_ENABLED and takes its options from config', async () => {
    const owner = await signup(server.app);
    const on = await server.ctx.executions.buildServices({
      tenant: (await server.ctx.repos.tenants.get(owner.tenant.id))!,
      executionId: '',
      mode: 'manual',
    });
    const options = (on.pythonRunner as PyodideCodeRunner).options;
    const { config } = server.ctx;
    expect(options).toMatchObject({
      memoryLimitMb: Math.max(config.code.memoryMb, 256),
      timeoutMs: config.code.timeoutMs,
      maxConcurrency: 5,
      stdlibAllow: [],
      externalAllow: [],
      builtinsDeny: config.python.builtinsDeny,
      allowTransitiveImports: false,
    });
    expect(options.wheelsDir).toBeUndefined();

    const off = await createTestServer({ PYTHON_ENABLED: 'false' }, { startMain: false, reset: false });
    try {
      const built = await off.ctx.executions.buildServices({
        tenant: (await off.ctx.repos.tenants.get(owner.tenant.id))!,
        executionId: '',
        mode: 'manual',
      });
      expect(built.pythonRunner).toBeUndefined();
    } finally {
      await off.close();
    }
  });

  it('secrets start before the leader duties and stop on close', async () => {
    const local = await createTestServer({}, { startMain: false, reset: false });
    const order: string[] = [];
    const start = vi.spyOn(local.ctx.secrets, 'start').mockImplementation(async () => {
      order.push('secrets');
    });
    const startAll = vi.spyOn(local.ctx.activeWorkflows, 'startAll').mockImplementation(async () => {
      order.push('triggers');
    });
    const stop = vi.spyOn(local.ctx.secrets, 'stop');
    await local.ctx.startMain();
    expect(order).toEqual(['secrets', 'triggers']);
    expect(start).toHaveBeenCalledTimes(1);
    startAll.mockRestore();
    await local.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a worker starts secrets before it takes jobs', async () => {
    const local = await createTestServer(
      { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfp4' },
      { startMain: false, reset: false },
    );
    const order: string[] = [];
    vi.spyOn(local.ctx.secrets, 'start').mockImplementation(async () => {
      order.push('secrets');
    });
    vi.spyOn(local.ctx.queue!, 'startWorker').mockImplementation(() => {
      order.push('jobs');
    });
    await local.ctx.startWorker();
    expect(order).toEqual(['secrets', 'jobs']);
    await local.close();
  });
});
