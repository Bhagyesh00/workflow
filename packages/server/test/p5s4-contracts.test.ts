/**
 * Phase 5 S4 contract step (C0d3): server wiring. Env defaults, the MCP URL family (`webhookUrlBase`,
 * `hookUrl`), API key audiences, the MCP Host check and preflight, the SPA reservations, the AI builder
 * settings (`TenantSettings.ai`, `features.aiBuilder`), the `availableInMCP` default, route and service
 * registration, `startMcpTestServer`, `aiRuntime`, and the two MCP test clients. Stub bodies (L1..L14)
 * are never asserted.
 */
import { Client } from '@modelcontextprotocol/client';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reservedPaths } from '../src/routes/system';
import type { AiRuntime } from '../src/services/ai-builder/runtime';
import { MCP_KEY_AUDIENCE, MCP_KEY_LABEL } from '../src/services/mcp/types';
import { hookUrl, webhookUrlBase } from '../src/services/webhook-paths';
import {
  BASE_URL,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  signup,
  startMcpTestServer,
  TestClient,
  type TestServer,
  testConfig,
} from './helpers';

const fakeRuntime: AiRuntime = {
  runAgent: (async () => {
    throw new Error('fake runtime');
  }) as unknown as AiRuntime['runAgent'],
  capabilitiesOf: (() => ({})) as unknown as AiRuntime['capabilitiesOf'],
};

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { nodePackages: [nodesAiPackage], aiRuntime: fakeRuntime });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

const MCP_HOST = new URL(BASE_URL).host;

async function withViewer(owner: Awaited<ReturnType<typeof signup>>) {
  const invite = await owner.client.data(
    owner.client.post('/rest/members/invite', { email: `v-${Date.now()}@example.com`, role: 'viewer' }),
  );
  const viewer = new TestClient(server.app);
  await viewer.data(
    viewer.post(`/rest/invitations/${invite.token}/accept`, { name: 'V', password: 'Passw0rd!' }),
  );
  return viewer;
}

async function openAiCredential(client: TestClient): Promise<string> {
  const row = await client.data<{ id: string }>(
    client.post('/rest/credentials', { name: 'OpenAI', type: 'openAiApi', data: { apiKey: 'sk-test' } }),
  );
  return row.id;
}

describe('config and URLs', () => {
  it('has the S4 env defaults', () => {
    const config = testConfig();
    expect(config.mcp.baseUrl).toBe(BASE_URL);
    expect(config.mcp.endpoint).toBe('mcp');
    expect(config.mcp.endpointTest).toBe('mcp-test');
    expect(config.mcp.accessEnabled).toBe(false);
    expect(config.ai.enabled).toBe(false);
    expect(testConfig({ MCP_BASE_URL: 'https://mcp.example.com/' }).mcp.baseUrl).toBe(
      'https://mcp.example.com',
    );
  });

  it('webhookUrlBase maps the three families', () => {
    expect(webhookUrlBase({})).toBe('webhook');
    expect(webhookUrlBase({ nodeType: 'form' })).toBe('form');
    expect(webhookUrlBase({ nodeType: 'mcp' })).toBe('mcp');
  });

  it('hookUrl builds webhook and form URLs on BASE_URL and MCP URLs on MCP_BASE_URL', () => {
    const config = testConfig({
      MCP_BASE_URL: 'https://mcp.example.com',
      ENDPOINT_MCP: 'tools',
      ENDPOINT_MCP_TEST: 'tools-test',
    });
    expect(hookUrl(config, {}, false, 'acme', 'a/b')).toBe(`${BASE_URL}/webhook/acme/a/b`);
    expect(hookUrl(config, {}, true, 'acme', 'a')).toBe(`${BASE_URL}/webhook-test/acme/a`);
    expect(hookUrl(config, { nodeType: 'form' }, true, 'acme', 'f')).toBe(`${BASE_URL}/form-test/acme/f`);
    expect(hookUrl(config, { nodeType: 'mcp' }, false, 'acme', 'm')).toBe(
      'https://mcp.example.com/tools/acme/m',
    );
    expect(hookUrl(config, { nodeType: 'mcp' }, true, 'acme', 'm')).toBe(
      'https://mcp.example.com/tools-test/acme/m',
    );
  });

  it('shows /mcp and /mcp-test URLs for an MCP Server Trigger', async () => {
    const owner = await signup(server.app);
    const trigger = node('MCP Server Trigger', 'ai.mcpTrigger', { path: 'tools' });
    const wf = await createWorkflow(owner.client, { nodes: [trigger] });
    const urls = await owner.client.data<Array<{ testUrl: string; productionUrl: string }>>(
      owner.client.get(`/rest/workflows/${wf.id}/webhook-urls`),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.productionUrl).toBe(`${BASE_URL}/mcp/${owner.tenant.slug}/tools`);
      expect(url.testUrl).toBe(`${BASE_URL}/mcp-test/${owner.tenant.slug}/tools`);
    }
  });
});

describe('API key audience', () => {
  it('refuses an MCP key on /api/v1 and hides it from /rest/api-keys; a public key still passes', async () => {
    const owner = await signup(server.app);
    const mcp = await server.ctx.auth.createApiKey(
      owner.tenant.id,
      owner.user.id,
      MCP_KEY_LABEL,
      [],
      MCP_KEY_AUDIENCE,
    );
    const pub = await owner.client.data<{ id: string; key: string }>(
      owner.client.post('/rest/api-keys', { name: 'public' }),
    );
    const call = (key: string) =>
      server.app.inject({ method: 'GET', url: '/api/v1/workflows', headers: { 'x-api-key': key } });
    expect((await call(mcp.key)).statusCode).toBe(401);
    expect((await call(pub.key)).statusCode).toBe(200);

    const listed = await owner.client.data<Array<{ id: string }>>(owner.client.get('/rest/api-keys'));
    expect(listed.map((k) => k.id)).toEqual([pub.id]);

    expect(await server.ctx.auth.authenticateApiKey(mcp.key)).toBeUndefined();
    expect((await server.ctx.auth.authenticateApiKey(mcp.key, MCP_KEY_AUDIENCE))?.tenant.id).toBe(
      owner.tenant.id,
    );
    expect(await server.ctx.auth.authenticateApiKey(pub.key, MCP_KEY_AUDIENCE)).toBeUndefined();
    expect((await server.ctx.auth.authenticateApiKey(pub.key))?.user.id).toBe(owner.user.id);
  });
});

describe('MCP trigger endpoints', () => {
  it('answers 403 when the Host is not the MCP base URL host, on every method of both families', async () => {
    for (const url of ['/mcp/t/x', '/mcp-test/t/x']) {
      for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS'] as const) {
        const res = await server.app.inject({ method, url, headers: { host: 'evil.example' } });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().error.code).toBe('forbidden');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      }
    }
  });

  it('answers a preflight with the MCP CORS headers: any origin, never credentials', async () => {
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: '/mcp/t/x',
      headers: {
        host: MCP_HOST,
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-custom',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(String(res.headers['access-control-allow-headers'])).toContain('mcp-session-id');
    expect(String(res.headers['access-control-allow-headers'])).toContain('x-custom');
    expect(String(res.headers['access-control-expose-headers'])).toContain('mcp-session-id');
  });

  it('passes the right Host on to the webhook service (an unknown path is 404)', async () => {
    const owner = await signup(server.app);
    const res = await server.app.inject({
      method: 'POST',
      url: `/mcp/${owner.tenant.slug}/nothing-here`,
      headers: { host: MCP_HOST, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('SPA reservations', () => {
  it('never answers the MCP prefixes with the SPA fallback', async () => {
    for (const url of [
      '/mcp-server',
      '/mcp-server/t/x',
      '/.well-known/x',
      '/mcp-oauth/t',
      '/mcp',
      '/mcp-test',
    ]) {
      const res = await server.app.inject({ method: 'GET', url, headers: { accept: 'text/html,*/*' } });
      expect(res.statusCode, url).toBe(404);
      expect(String(res.headers['content-type'] ?? ''), url).not.toContain('text/html');
    }
  });

  it('reserves the configured MCP endpoints too', () => {
    const paths = reservedPaths(
      testConfig({ ENDPOINT_MCP: 'hooks-mcp', ENDPOINT_MCP_TEST: 'hooks-mcp-test' }),
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        '/mcp',
        '/mcp-test',
        '/mcp-server',
        '/mcp-oauth',
        '/.well-known',
        '/hooks-mcp',
        '/hooks-mcp-test',
        '/chat-widget',
      ]),
    );
  });
});

describe('AI builder settings', () => {
  it('shows features.aiBuilder and saves the model setup for admins only', async () => {
    const owner = await signup(server.app);
    const before = await owner.client.data(owner.client.get('/rest/settings'));
    expect(before.features.aiBuilder).toEqual({ enabled: false, setup: false });
    expect(before.ai).toBeUndefined();

    const credentialId = await openAiCredential(owner.client);
    const ai = { credentialId, nodeType: 'ai.lmChatOpenAi', model: 'gpt-4o-mini' };
    const patched = await owner.client.data(owner.client.patch('/rest/settings', { ai }));
    expect(patched.ai).toEqual(ai);
    expect(patched.aiBuilder).toEqual({ enabled: false, setup: true });

    const after = await owner.client.data(owner.client.get('/rest/settings'));
    expect(after.features.aiBuilder).toEqual({ enabled: false, setup: true });
    expect(after.ai).toEqual(ai);

    const audit = await server.ctx.database.pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.settings_updated'`,
      [owner.tenant.id],
    );
    expect(audit.rows[0].n).toBe(1);

    const viewer = await withViewer(owner);
    const seen = await viewer.data(viewer.get('/rest/settings'));
    expect(seen.features.aiBuilder).toEqual({ enabled: false, setup: true });
    expect(seen.ai).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(credentialId);
    expect((await viewer.patch('/rest/settings', { ai })).statusCode).toBe(403);

    const cleared = await owner.client.data(owner.client.patch('/rest/settings', { ai: null }));
    expect(cleared.ai).toBeUndefined();
    expect(cleared.aiBuilder).toEqual({ enabled: false, setup: false });
  });

  it("refuses another tenant's credential and a node type that is not a chat model", async () => {
    const owner = await signup(server.app);
    const other = await signup(server.app);
    const foreign = await openAiCredential(other.client);
    const own = await openAiCredential(owner.client);
    const patch = (ai: Record<string, unknown>) => owner.client.patch('/rest/settings', { ai });

    const res1 = await patch({ credentialId: foreign, nodeType: 'ai.lmChatOpenAi', model: 'm' });
    expect(res1.statusCode).toBe(400);
    const res2 = await patch({ credentialId: own, nodeType: 'ai.agent', model: 'm' });
    expect(res2.statusCode).toBe(400);
    const res3 = await patch({ credentialId: own, nodeType: 'ai.lmChatNope', model: 'm' });
    expect(res3.statusCode).toBe(400);
    const res4 = await patch({ credentialId: 'not-a-uuid', nodeType: 'ai.lmChatOpenAi', model: 'm' });
    expect(res4.statusCode).toBe(400);
    const settings = await owner.client.data(owner.client.get('/rest/settings'));
    expect(settings.ai).toBeUndefined();
  });
});

describe('availableInMCP default', () => {
  it('follows the tenant auto expose setting; an explicit value wins', async () => {
    const owner = await signup(server.app);
    const nodes = () => [node('Start', 'core.manualTrigger')];
    const settingsOf = async (id: string) =>
      (
        await owner.client.data<{ settings: Record<string, unknown> }>(
          owner.client.get(`/rest/workflows/${id}`),
        )
      ).settings;

    const off = await createWorkflow(owner.client, { nodes: nodes() });
    expect((await settingsOf(off.id)).availableInMCP).toBeUndefined();

    await server.ctx.repos.tenants.updateSettings(owner.tenant.id, { mcp: { autoExposeNewWorkflows: true } });
    const on = await createWorkflow(owner.client, { nodes: nodes() });
    expect((await settingsOf(on.id)).availableInMCP).toBe(true);
    const explicit = await createWorkflow(owner.client, {
      nodes: nodes(),
      settings: { availableInMCP: false },
    });
    expect((await settingsOf(explicit.id)).availableInMCP).toBe(false);
  });
});

describe('registration', () => {
  it('builds the S4 services and passes the aiRuntime option', async () => {
    expect(server.ctx.mcpTrigger).toBeDefined();
    expect(server.ctx.mcpSessions).toBeDefined();
    expect(server.ctx.aiBuilder).toBeDefined();
    expect(await server.ctx.aiBuilder.runtime()).toBe(fakeRuntime);
  });

  it('registers the S4 routes', () => {
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'DELETE', string]> = [
      ['POST', '/rest/ai/build'],
      ['POST', '/rest/ai/usage-settings'],
      ['POST', '/rest/ai/sessions'],
      ['POST', '/rest/ai/build/truncate-messages'],
      ['POST', '/rest/ai/build/clear-session'],
      ['POST', '/rest/ai/build/accepted-version'],
      ['GET', '/rest/mcp/settings'],
      ['PATCH', '/rest/mcp/settings'],
      ['GET', '/rest/mcp/api-key'],
      ['POST', '/rest/mcp/api-key/rotate'],
      ['GET', '/rest/mcp/workflows'],
      ['PATCH', '/rest/mcp/workflows/toggle-access'],
      ['GET', '/rest/mcp/oauth/allowed-redirect-uris'],
      ['GET', '/rest/mcp/oauth-clients'],
      ['DELETE', '/rest/mcp/oauth-clients/:clientId'],
      ['GET', '/rest/consent/details'],
      ['POST', '/rest/consent/approve'],
      ['POST', '/mcp-server/:tenantSlug/http'],
      ['POST', '/mcp-oauth/:tenantSlug/register'],
      ['GET', '/mcp-oauth/:tenantSlug/authorize'],
      ['POST', '/mcp-oauth/:tenantSlug/token'],
      ['POST', '/mcp-oauth/:tenantSlug/revoke'],
      ['GET', '/.well-known/oauth-authorization-server/mcp-oauth/:tenantSlug'],
      ['GET', '/mcp/:tenantSlug/*'],
      ['POST', '/mcp/:tenantSlug/*'],
      ['DELETE', '/mcp-test/:tenantSlug/*'],
    ];
    for (const [method, url] of routes) {
      expect(server.app.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
  });

  it('keeps the builder routes behind AI_ENABLED and the MCP settings behind a session', async () => {
    expect((await new TestClient(server.app).post('/rest/ai/build', {})).statusCode).toBe(404);
    expect((await server.app.inject({ method: 'GET', url: '/rest/mcp/settings' })).statusCode).toBe(401);
  });
});

describe('startMcpTestServer', () => {
  it('listens on a free port with BASE_URL and MCP_BASE_URL on it', async () => {
    const mcp = await startMcpTestServer({ AI_ENABLED: 'true' }, { reset: false });
    try {
      expect(mcp.url).toBe(`http://127.0.0.1:${mcp.port}`);
      expect(mcp.ctx.config.baseUrl).toBe(mcp.url);
      expect(mcp.ctx.config.mcp.baseUrl).toBe(mcp.url);
      expect((await fetch(`${mcp.url}/healthz`)).status).toBe(200);
      const preflight = await fetch(`${mcp.url}/mcp/t/x`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      // AI_ENABLED on: the builder route exists and asks for a session
      expect((await new TestClient(mcp.app, mcp.url).post('/rest/ai/build', {})).statusCode).toBe(401);
    } finally {
      await mcp.close();
    }
  });

  it('compiles and loads both MCP test clients', () => {
    expect(typeof Client).toBe('function');
    expect(typeof SdkClient).toBe('function');
  });
});
