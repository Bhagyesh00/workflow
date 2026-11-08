/**
 * P5-04 tenant MCP server endpoint against the real app on a free port, with real MCP clients:
 * `@modelcontextprotocol/client` 2.4.0 (2026-07-28 through `server/discover`) and `@modelcontextprotocol/sdk`
 * 1.32.2 (2025 stateless `initialize` fallback). Covers the HTTP rules (Host, CORS, methods, access switch,
 * Bearer only, body errors, routing headers, rate limit, generic production errors) and the C0 helpers
 * that had no test of their own.
 */
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as SdkStreamable } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { DataObject } from '@workflow/workflow';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mcpCorsHeaders, mcpRateLimit } from '../src/http/mcp-http';
import { isMcpOAuthToken } from '../src/services/mcp/oauth/tokens';
import {
  MCP_KEY_AUDIENCE,
  MCP_KEY_LABEL,
  mcpOAuthIssuer,
  mcpResourceMetadataUrl,
  mcpServerUrl,
} from '../src/services/mcp/types';
import {
  chain,
  createWorkflow,
  node,
  setNode,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ MCP_ACCESS_ENABLED: 'true', BODY_LIMIT_MB: '1' });
});
afterAll(async () => {
  await server?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** a new workspace; its REST client sends the test server's own origin (CSRF) */
async function signup() {
  const client = new TestClient(server.app, server.url);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-server-${id}@example.com`,
    password: 'Passw0rd!',
    name: `MCP ${id}`,
    workspaceName: `MCP ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  return { client, ...data, url: `${server.url}/mcp-server/${data.tenant.slug}/http` };
}

async function mcpKey(tenantId: string, userId: string) {
  return (await server.ctx.auth.createApiKey(tenantId, userId, MCP_KEY_LABEL, [], MCP_KEY_AUDIENCE)).key;
}

/** a published webhook workflow exposed to MCP: Webhook -> Set */
async function exposedWorkflow(client: TestClient, name = `Exposed ${randomUUID().slice(0, 8)}`) {
  const wf = await createWorkflow(client, {
    name,
    nodes: [
      node('Webhook', 'core.webhook', { path: `p-${randomUUID().slice(0, 8)}`, httpMethod: 'POST' }, [0, 0], {
        webhookId: randomUUID(),
      }),
      setNode('Set', 'greeting', 'hello'),
    ],
    connections: chain('Webhook', 'Set'),
    settings: { availableInMCP: true },
  });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return { ...wf, name };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const modernClient = async (url: string, headers: Record<string, string>) => {
  const client = new Client(
    { name: 'modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
};

const legacyClient = async (url: string, headers: Record<string, string>) => {
  const client = new SdkClient({ name: 'legacy-test', version: '1.0.0' });
  await client.connect(new SdkStreamable(new URL(url), { requestInit: { headers } }));
  return client;
};

const textOf = (result: unknown) =>
  ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .map((part) => part.text ?? '')
    .join('');
const jsonOf = (result: unknown) => JSON.parse(textOf(result));

const rpc = (method: string, params?: DataObject, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});
const MODERN_META = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

type RpcBody = { result?: any; error?: { code: number; message: string } };

describe('real clients', () => {
  it('2026 client: search finds a flagged workflow, runs it, and get_workflow_execution shows the result', async () => {
    const user = await signup();
    const wf = await exposedWorkflow(user.client);
    const client = await modernClient(user.url, bearer(await mcpKey(user.tenant.id, user.user.id)));
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining(['search_workflows', 'execute_workflow', 'get_workflow_execution']),
      );
      expect(tools.find((t) => t.name === 'execute_workflow')?.inputSchema.type).toBe('object');

      const search = jsonOf(
        await client.callTool({ name: 'search_workflows', arguments: { query: wf.name } }),
      );
      expect(search.data).toEqual([
        expect.objectContaining({ id: wf.id, name: wf.name, availableInMCP: true }),
      ]);

      const run = jsonOf(
        await client.callTool({
          name: 'execute_workflow',
          arguments: {
            workflowId: wf.id,
            executionMode: 'production',
            inputs: { type: 'webhook', webhookData: { body: { order: 7 } } },
          },
        }),
      );
      expect(run).toEqual({ executionId: expect.any(String), status: 'started' });
      await waitForExecution(server.ctx, user.tenant.id, run.executionId);

      const result = jsonOf(
        await client.callTool({
          name: 'get_workflow_execution',
          arguments: { workflowId: wf.id, executionId: run.executionId, includeData: true },
        }),
      );
      expect(result.execution).toMatchObject({ id: run.executionId, status: 'success', mode: 'webhook' });
      expect(result.data.nodes.Set[0].data.main[0][0]).toMatchObject({ greeting: 'hello' });
      expect(result.data.nodes.Webhook[0].data.main[0][0]).toMatchObject({ body: { order: 7 } });
    } finally {
      await client.close();
    }
  });

  it('2025 client (sdk 1.32.2, stateless initialize): search, manual run, execution with data', async () => {
    const user = await signup();
    const wf = await exposedWorkflow(user.client);
    const client = await legacyClient(user.url, bearer(await mcpKey(user.tenant.id, user.user.id)));
    try {
      expect(client.getServerVersion()?.name).toBe('workflow-mcp-server');
      expect(client.getInstructions()).toContain('untrusted');
      const search = jsonOf(await client.callTool({ name: 'search_workflows', arguments: {} }));
      expect(search.data.map((w: { id: string }) => w.id)).toContain(wf.id);
      const run = jsonOf(
        await client.callTool({
          name: 'execute_workflow',
          arguments: { workflowId: wf.id, executionMode: 'manual' },
        }),
      );
      expect(run.status).toBe('started');
      await waitForExecution(server.ctx, user.tenant.id, run.executionId);
      const result = jsonOf(
        await client.callTool({
          name: 'get_workflow_execution',
          arguments: {
            workflowId: wf.id,
            executionId: run.executionId,
            includeData: true,
            nodeNames: ['Set'],
          },
        }),
      );
      expect(result.execution.status).toBe('success');
      expect(result.execution.mode).toBe('manual');
      expect(Object.keys(result.data.nodes)).toEqual(['Set']);
      // a flagged-off workflow is refused with n8n's text
      const hidden = await createWorkflow(user.client, {
        name: 'Hidden',
        nodes: [node('Start', 'core.manualTrigger')],
      });
      const refused = await client.callTool({
        name: 'get_workflow_details',
        arguments: { workflowId: hidden.id },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('Workflow is not available in MCP');
    } finally {
      await client.close();
    }
  });
});

describe('HTTP rules', () => {
  it('Host: evil.example is 403 on POST, GET, HEAD and OPTIONS, with CORS and never credentials', async () => {
    const user = await signup();
    const path = `/mcp-server/${user.tenant.slug}/http`;
    for (const method of ['POST', 'GET', 'HEAD', 'OPTIONS'] as const) {
      const res = await server.app.inject({ method, url: path, headers: { host: 'evil.example' } });
      expect(res.statusCode, method).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('GET and DELETE 405 with Allow: POST; HEAD 401 with resource_metadata; OPTIONS CORS with requested headers', async () => {
    const user = await signup();
    const get = await fetch(user.url);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    const del = await fetch(user.url, { method: 'DELETE' });
    expect(del.status).toBe(405);
    const head = await fetch(user.url, { method: 'HEAD' });
    expect(head.status).toBe(401);
    const resource = mcpServerUrl(server.ctx.config, user.tenant.slug);
    expect(head.headers.get('www-authenticate')).toBe(
      `Bearer realm="MCP Server", resource_metadata="${server.url}/.well-known/oauth-protected-resource/mcp-server/${user.tenant.slug}/http"`,
    );
    expect(resource).toBe(user.url);
    const options = await fetch(user.url, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, x-custom-trace, *',
      },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-origin')).toBe('*');
    expect(options.headers.get('access-control-allow-credentials')).toBeNull();
    expect(options.headers.get('access-control-allow-headers')).toContain('x-custom-trace');
    expect(options.headers.get('access-control-allow-headers')).toContain('mcp-method');
    expect(options.headers.get('access-control-expose-headers')).toContain('www-authenticate');
  });

  it('access off or no such workspace: 404 for everything', async () => {
    const user = await signup();
    await user.client.data(user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: false }));
    const key = await mcpKey(user.tenant.id, user.user.id);
    expect((await post(user.url, rpc('tools/list'), bearer(key))).status).toBe(404);
    expect((await fetch(user.url, { method: 'OPTIONS' })).status).toBe(404);
    expect((await fetch(user.url)).status).toBe(404);
    expect((await fetch(user.url, { method: 'HEAD' })).status).toBe(404);
    const unknown = await post(
      `${server.url}/mcp-server/no-such-${randomUUID().slice(0, 6)}/http`,
      rpc('tools/list'),
    );
    expect(unknown.status).toBe(404);
    await user.client.data(user.client.patch('/rest/mcp/settings', { mcpAccessEnabled: true }));
    expect((await post(user.url, rpc('tools/list'), bearer(key))).status).toBe(200);
  });

  it("Bearer only: no header, a public API key, an OAuth-looking token and another tenant's key are 401", async () => {
    const a = await signup();
    const b = await signup();
    const challenge = `resource_metadata="${mcpResourceMetadataUrl(a.url)}"`;
    const none = await post(a.url, rpc('tools/list'));
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain(challenge);
    const publicKey = (await server.ctx.auth.createApiKey(a.tenant.id, a.user.id, 'Public')).key;
    expect((await post(a.url, rpc('tools/list'), bearer(publicKey))).status).toBe(401);
    expect((await post(a.url, rpc('tools/list'), bearer(`wfo_at_${randomUUID()}`))).status).toBe(401);
    const otherKey = await mcpKey(b.tenant.id, b.user.id);
    expect((await post(a.url, rpc('tools/list'), bearer(otherKey))).status).toBe(401);
    expect((await post(b.url, rpc('tools/list'), bearer(otherKey))).status).toBe(200);
    // a session cookie is no credential here
    const cookie = a.client.cookie ?? '';
    expect((await post(a.url, rpc('tools/list'), { cookie })).status).toBe(401);
    // and an MCP key never works on the public API
    const own = await mcpKey(a.tenant.id, a.user.id);
    const api = await server.app.inject({
      method: 'GET',
      url: '/api/v1/workflows',
      headers: { 'x-api-key': own },
    });
    expect(api.statusCode).toBe(401);
  });

  it('a removed member loses access at once', async () => {
    const owner = await signup();
    const member = await signup();
    await server.ctx.repos.memberships.add(owner.tenant.id, member.user.id, 'editor');
    const key = await mcpKey(owner.tenant.id, member.user.id);
    expect((await post(owner.url, rpc('tools/list'), bearer(key))).status).toBe(200);
    await server.ctx.repos.memberships.remove(owner.tenant.id, member.user.id);
    expect((await post(owner.url, rpc('tools/list'), bearer(key))).status).toBe(401);
  });

  it('malformed body -32700, batch -32600, oversize 413, notification 202, unknown method -32601', async () => {
    const user = await signup();
    const auth = bearer(await mcpKey(user.tenant.id, user.user.id));
    const malformed = await post(user.url, '{"jsonrpc": "2.0", "id": 1, ', auth);
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as RpcBody).error?.code).toBe(-32700);
    const batch = await post(user.url, [rpc('tools/list')], auth);
    expect(batch.status).toBe(400);
    expect(((await batch.json()) as RpcBody).error?.code).toBe(-32600);
    const big = await post(
      user.url,
      JSON.stringify({ ...rpc('tools/list'), pad: 'x'.repeat(1_200_000) }),
      auth,
    );
    expect(big.status).toBe(413);
    expect(big.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await big.json()) as RpcBody).error?.message).toBe('Request body too large');
    const note = await post(user.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
    expect(note.status).toBe(202);
    const unknown = await post(user.url, rpc('resources/list'), auth);
    expect(((await unknown.json()) as RpcBody).error?.code).toBe(-32601);
  });

  it('2026 routing headers: Mcp-Method and Mcp-Name must match the body, else -32020', async () => {
    const user = await signup();
    const auth = bearer(await mcpKey(user.tenant.id, user.user.id));
    const list = rpc('tools/list', MODERN_META);
    const ok = await post(user.url, list, { ...auth, 'mcp-method': 'tools/list' });
    const okBody = (await ok.json()) as RpcBody;
    expect(okBody.result.resultType).toBe('complete');
    expect(okBody.result.tools.length).toBeGreaterThan(5);
    const missing = await post(user.url, list, auth);
    expect(((await missing.json()) as RpcBody).error?.code).toBe(-32020);
    const wrongMethod = await post(user.url, list, { ...auth, 'mcp-method': 'tools/call' });
    expect(((await wrongMethod.json()) as RpcBody).error?.code).toBe(-32020);
    const call = rpc('tools/call', { name: 'list_workflow_tags', arguments: {}, ...MODERN_META });
    const wrongName = await post(user.url, call, {
      ...auth,
      'mcp-method': 'tools/call',
      'mcp-name': 'search_workflows',
    });
    expect(wrongName.status).toBe(400);
    expect(((await wrongName.json()) as RpcBody).error?.code).toBe(-32020);
    const right = await post(user.url, call, {
      ...auth,
      'mcp-method': 'tools/call',
      'mcp-name': 'list_workflow_tags',
    });
    expect(((await right.json()) as RpcBody).result.isError).toBeUndefined();
    const discover = await post(user.url, rpc('server/discover', MODERN_META), {
      ...auth,
      'mcp-method': 'server/discover',
    });
    const discovered = ((await discover.json()) as RpcBody).result;
    expect(discovered.supportedVersions[0]).toBe('2026-07-28');
    expect(discovered.instructions).toContain('untrusted');
  });

  it('production errors are a generic -32603 with no detail', async () => {
    const user = await signup();
    const auth = bearer(await mcpKey(user.tenant.id, user.user.id));
    vi.spyOn(server.ctx.workflows, 'list').mockRejectedValueOnce(new Error('db exploded: secret-detail-42'));
    const res = await post(user.url, rpc('tools/call', { name: 'search_workflows', arguments: {} }), auth);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ code: -32603, message: 'Internal error' });
    expect(text).not.toContain('secret-detail-42');
  });

  it('unknown tool -32602; bad arguments an isError result', async () => {
    const user = await signup();
    const auth = bearer(await mcpKey(user.tenant.id, user.user.id));
    const unknown = await post(user.url, rpc('tools/call', { name: 'nope', arguments: {} }), auth);
    expect(((await unknown.json()) as RpcBody).error).toEqual({
      code: -32602,
      message: 'Tool nope not found',
    });
    const bad = await post(
      user.url,
      rpc('tools/call', { name: 'get_workflow_details', arguments: { workflowId: 'x' } }),
      auth,
    );
    const body = (await bad.json()) as RpcBody;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments');
  });
});

describe('rate limit', () => {
  let limited: TestServer & { url: string; port: number };
  beforeAll(async () => {
    limited = await startMcpTestServer(
      { MCP_ACCESS_ENABLED: 'true', MCP_SERVER_RATE_LIMIT: '3' },
      { reset: false, startMain: false },
    );
  });
  afterAll(async () => {
    await limited?.close();
  });

  it('answers 429 after MCP_SERVER_RATE_LIMIT requests in the window', async () => {
    const user = await signup();
    const url = `${limited.url}/mcp-server/${user.tenant.slug}/http`;
    const auth = bearer(await mcpKey(user.tenant.id, user.user.id));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(url, rpc('ping'), auth)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

describe('C0 helpers', () => {
  it('isMcpOAuthToken, the URL helpers and mcpRateLimit', () => {
    expect(isMcpOAuthToken('wfo_at_abc')).toBe(true);
    expect(isMcpOAuthToken('wfo_rt_abc')).toBe(false);
    expect(isMcpOAuthToken('wfk_12345678_abc')).toBe(false);
    const config = { ...server.ctx.config, mcp: { ...server.ctx.config.mcp, baseUrl: 'https://h.example' } };
    expect(mcpServerUrl(config, 'a b')).toBe('https://h.example/mcp-server/a%20b/http');
    expect(mcpOAuthIssuer(config, 'acme')).toBe('https://h.example/mcp-oauth/acme');
    expect(mcpResourceMetadataUrl('https://h.example/mcp-server/acme/http')).toBe(
      'https://h.example/.well-known/oauth-protected-resource/mcp-server/acme/http',
    );
    expect(mcpResourceMetadataUrl('https://h.example/')).toBe(
      'https://h.example/.well-known/oauth-protected-resource',
    );
    const limit = mcpRateLimit(7);
    expect(limit.max).toBe(7);
    expect(limit.timeWindow).toBe(300_000);
    expect((limit.keyGenerator as (r: FastifyRequest) => string)({ ip: '10.0.0.1' } as FastifyRequest)).toBe(
      'mcp:10.0.0.1',
    );
  });

  it('mcpCorsHeaders adds valid requested names and drops * and invalid ones', () => {
    const headers = mcpCorsHeaders({ 'access-control-request-headers': ['X-Trace, *', 'bad name, x-other'] });
    const allow = headers['access-control-allow-headers'].split(', ');
    expect(allow).toEqual(expect.arrayContaining(['authorization', 'x-trace', 'x-other']));
    expect(allow).not.toContain('*');
    expect(allow).not.toContain('bad name');
    expect(headers['access-control-allow-credentials']).toBeUndefined();
  });
});
