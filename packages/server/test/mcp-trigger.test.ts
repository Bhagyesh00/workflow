/**
 * P5-03 MCP Server Trigger against the real app on a free port, with real MCP clients: `@modelcontextprotocol/sdk`
 * 1.32.2 (2025 Streamable HTTP and legacy SSE) and `@modelcontextprotocol/client` 2.4.0 (the 2026-07-28 revision
 * through `server/discover`). Tools are a Calculator, a Code tool and an echo tool that answers with what reached it.
 */
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport as SdkStreamable } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { nodesAiPackage } from '@workflow/nodes-ai';
import {
  type AiTool,
  type DataObject,
  type NodePackage,
  type NodeType,
  ToolSuspension,
} from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MCP_TOOL_WAITING } from '../src/services/mcp-trigger';
import {
  createWorkflow,
  executionsOf,
  node,
  outputOf,
  startMcpTestServer,
  TestClient,
  type TestServer,
  waitForExecution,
} from './helpers';

const TRIGGER = 'MCP Server Trigger';

/** every item the echo tool's sub-node got, in order: what a tool sees as `$json` at a list and at a call */
const supplied: DataObject[] = [];

/** a tool that answers with its arguments and the trigger's item: what reached a tool */
const echoTool: NodeType = {
  description: {
    name: 'test.mcpEcho',
    displayName: 'MCP Echo',
    description: 'Answers with its arguments and its input item',
    icon: 'lucide:repeat',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Echo' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData(ctx) {
    const item = ctx.getInputData()[0]?.json ?? {};
    supplied.push(item);
    const tool: AiTool = {
      kind: 'tool',
      name: 'echo',
      description: 'Echoes what it received',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      invoke: async (args) => ({ args, item }),
    };
    return { response: tool };
  },
};
/** a tool that waits for the test's `open()` before it answers: a long tool run */
let gate = Promise.resolve();
let open = () => {};
const gatedTool: NodeType = {
  description: {
    ...echoTool.description,
    name: 'test.mcpGated',
    displayName: 'MCP Gated',
    defaults: { name: 'Gated' },
  },
  async supplyData() {
    const tool: AiTool = {
      kind: 'tool',
      name: 'gated',
      description: 'Answers once the test opens the gate',
      parameters: { type: 'object', properties: {} },
      invoke: async () => {
        await gate;
        return 'opened';
      },
    };
    return { response: tool };
  },
};

/** a tool that stops the run to wait for a person (an approval), counting how often it ran */
let approvals = 0;
const approvalTool: NodeType = {
  description: {
    ...echoTool.description,
    name: 'test.mcpApproval',
    displayName: 'MCP Approval',
    defaults: { name: 'Approve' },
  },
  async supplyData(ctx) {
    const toolNode = ctx.getNode().name;
    const tool: AiTool = {
      kind: 'tool',
      name: 'approve',
      description: 'Waits for a person',
      parameters: { type: 'object', properties: {} },
      invoke: async () => {
        approvals++;
        throw new ToolSuspension({
          toolNode,
          waitTill: new Date(Date.now() + 3_600_000),
          toolName: 'approve',
          toolCallId: 'c1',
        });
      },
    };
    return { response: tool };
  },
};
const echoPackage: NodePackage = {
  name: 'mcp-trigger-tests',
  nodes: [echoTool, gatedTool, approvalTool],
  credentials: [],
};

let server: TestServer & { url: string; port: number };

beforeAll(async () => {
  server = await startMcpTestServer({ BODY_LIMIT_MB: '1' }, { nodePackages: [nodesAiPackage, echoPackage] });
});
afterAll(async () => {
  await server?.close();
});
afterEach(() => {
  vi.useRealTimers();
});

/** a new workspace; its REST client sends the test server's own origin (CSRF) */
async function signup() {
  const client = new TestClient(server.app, server.url);
  const id = randomUUID().slice(0, 8);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-${id}@example.com`,
    password: 'Passw0rd!',
    name: `MCP ${id}`,
    workspaceName: `MCP ${id}`,
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  const data = res.json().data as { user: { id: string }; tenant: { id: string; slug: string } };
  return { client, ...data };
}

const toolLink = () =>
  ({ ai_tool: [[{ node: TRIGGER, type: 'ai_tool', index: 0 }]] }) as unknown as DataObject;

async function mcpWorkflow(
  client: TestClient,
  options: {
    path?: string;
    parameters?: DataObject;
    credentials?: Record<string, { id: string; name: string }>;
    activate?: boolean;
  } = {},
) {
  const path = options.path ?? `tools-${randomUUID().slice(0, 8)}`;
  const wf = await createWorkflow(client, {
    name: `MCP ${path}`,
    nodes: [
      node(
        TRIGGER,
        'ai.mcpTrigger',
        { path, instructions: 'Use these tools', ...options.parameters },
        [0, 0],
        { webhookId: randomUUID(), ...(options.credentials ? { credentials: options.credentials } : {}) },
      ),
      node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
      node(
        'Shout',
        'ai.toolCode',
        { toolDescription: 'Upper-cases the text', jsCode: 'return String(query).toUpperCase();' },
        [200, 200],
      ),
      node('Echo', 'test.mcpEcho', {}, [400, 200]),
    ],
    connections: { Calculator: toolLink(), Shout: toolLink(), Echo: toolLink() },
  });
  if (options.activate !== false) await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return { ...wf, path };
}

async function setup(options: Parameters<typeof mcpWorkflow>[1] = {}) {
  const user = await signup();
  const wf = await mcpWorkflow(user.client, options);
  const url = `${server.url}/mcp/${user.tenant.slug}/${wf.path}`;
  return { ...user, wf, url };
}

const legacyClient = async (url: string, headers: Record<string, string> = {}) => {
  const client = new SdkClient({ name: 'legacy-test', version: '1.0.0' });
  const transport = new SdkStreamable(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return { client, transport };
};

const sseClient = async (url: string, headers: Record<string, string> = {}) => {
  const client = new SdkClient({ name: 'sse-test', version: '1.0.0' });
  await client.connect(new SSEClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
};

const modernClient = async (url: string, headers: Record<string, string> = {}) => {
  const client = new Client(
    { name: 'modern-test', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
};

const textOf = (result: unknown) =>
  ((result as { content: Array<{ type: string; text?: string }> }).content ?? [])
    .map((part) => part.text ?? '')
    .join('');

const rpc = (method: string, params?: DataObject, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
});

const INIT = rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'raw', version: '1.0.0' },
});

type RpcBody = { error: { code: number; message: string } };
const rpcBody = async (res: Response) => (await res.json()) as RpcBody;

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

/** a Streamable HTTP session opened by hand; returns its id */
async function openSession(url: string, headers: Record<string, string> = {}) {
  const res = await post(url, INIT, headers);
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  return id as string;
}

async function lastExecution(tenantId: string, workflowId: string) {
  const [row] = await executionsOf(server.ctx, tenantId, workflowId);
  expect(row).toBeDefined();
  await waitForExecution(server.ctx, tenantId, row.id, ['success', 'error', 'waiting']);
  return server.ctx.repos.executions.get(tenantId, row.id);
}

describe('MCP Server Trigger with real clients', () => {
  it('lists and calls a calculator and a code tool over Streamable HTTP (2025)', async () => {
    const { tenant, wf, url, client } = await setup();
    const mcp = await legacyClient(url);
    try {
      expect(mcp.client.getServerVersion()).toEqual({ name: 'MCP_Server_Trigger', version: '0.1.0' });
      expect(mcp.client.getInstructions()).toBe('Use these tools');
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['Calculator', 'Shout', 'echo']);
      // listing runs nothing
      expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);
      expect(textOf(await mcp.client.callTool({ name: 'Calculator', arguments: { input: '6 * 7' } }))).toBe(
        '42',
      );
      expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
      expect(textOf(await mcp.client.callTool({ name: 'Shout', arguments: { query: 'hello' } }))).toBe(
        'HELLO',
      );
      // one execution per call, with the trigger item n8n's shape
      const runs = await executionsOf(server.ctx, tenant.id, wf.id);
      expect(runs).toHaveLength(2);
      const items = await Promise.all(
        runs.map(async (run) => {
          await waitForExecution(server.ctx, tenant.id, run.id, ['success']);
          const execution = await client.data(client.get(`/rest/executions/${run.id}`));
          return outputOf(execution.state, TRIGGER)[0];
        }),
      );
      const item = items.find((i) => (i.mcpToolCall as DataObject).toolName === 'Calculator') as DataObject;
      expect(item.mcpToolCall).toEqual({
        toolName: 'Calculator',
        arguments: { input: '6 * 7' },
        sourceNodeName: 'Calculator',
      });
      expect(item.mcpMessageId).toEqual(expect.any(Number));
      expect(item.body).toMatchObject({ method: 'tools/call', params: { name: 'Calculator' } });
      expect(item.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(item.mcpToolResult).toEqual({ content: [{ type: 'text', text: '42' }] });
      expect(item).not.toHaveProperty('user');
    } finally {
      await mcp.client.close();
    }
  });

  it('serves a 2026-07-28 client through server/discover without a session', async () => {
    const { url } = await setup();
    const client = await modernClient(url);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'MCP_Server_Trigger', version: '0.1.0' });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['Calculator', 'Shout', 'echo']);
      expect(textOf(await client.callTool({ name: 'Calculator', arguments: { input: '2 + 3' } }))).toBe('5');
    } finally {
      await client.close();
    }
  });

  it('lists and calls over the legacy SSE stream', async () => {
    const { url } = await setup();
    const client = await sseClient(url);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('Shout');
      expect(textOf(await client.callTool({ name: 'Shout', arguments: { query: 'sse' } }))).toBe('SSE');
      expect(textOf(await client.callTool({ name: 'Calculator', arguments: { input: '1 + 1' } }))).toBe('2');
    } finally {
      await client.close();
    }
  });

  it('answers an unknown tool with -32602 and a failing tool with isError', async () => {
    const { url } = await setup();
    const mcp = await legacyClient(url);
    try {
      await expect(mcp.client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow('Tool not found');
      const failed = await mcp.client.callTool({ name: 'Calculator', arguments: { input: 'not math' } });
      expect(failed.isError).toBe(true);
      expect(textOf(failed)).toMatch(/^Calculator: /);
    } finally {
      await mcp.client.close();
    }
  });
});

describe('auth and redaction', () => {
  const BEARER = 'mcp-bearer-secret-0123456789';
  const HEADER_VALUE = 'mcp-header-secret-0123456789';
  const COOKIE = 'other=cookie-secret-0123456789';

  async function withCredential(type: string, data: DataObject, authentication: string) {
    const user = await signup();
    const credential = await user.client.data(
      user.client.post('/rest/credentials', { name: type, type, data }),
    );
    const wf = await mcpWorkflow(user.client, {
      parameters: { authentication },
      credentials: { [type]: { id: credential.id, name: type } },
    });
    return { ...user, wf, url: `${server.url}/mcp/${user.tenant.slug}/${wf.path}` };
  }

  it('Bearer: 401 without or with a wrong token, and the token never reaches a tool or the run data', async () => {
    const { tenant, wf, url } = await withCredential('httpBearerAuth', { token: BEARER }, 'bearerAuth');
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { authorization: BEARER }] as Array<
      Record<string, string>
    >) {
      const res = await post(url, INIT, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="MCP Server"');
      expect(await res.text()).not.toContain(BEARER);
    }
    await expect(legacyClient(url)).rejects.toThrow();
    const mcp = await legacyClient(url, { authorization: `Bearer ${BEARER}`, cookie: COOKIE });
    try {
      const answer = textOf(await mcp.client.callTool({ name: 'echo', arguments: { text: 'hi' } }));
      expect(JSON.parse(answer).args).toEqual({ text: 'hi' });
      expect(JSON.parse(answer).item.headers).toMatchObject({
        authorization: '**hidden**',
        cookie: '**hidden**',
      });
      expect(answer).not.toContain(BEARER);
      expect(answer).not.toContain('cookie-secret');
      const execution = await lastExecution(tenant.id, wf.id);
      const stored = JSON.stringify(execution);
      expect(stored).not.toContain(BEARER);
      expect(stored).not.toContain('cookie-secret');
    } finally {
      await mcp.client.close();
    }
  });

  it('Header Auth: 401 on a wrong value, the header redacted by its credential name', async () => {
    const { tenant, wf, url } = await withCredential(
      'httpHeaderAuth',
      { name: 'X-Mcp-Key', value: HEADER_VALUE },
      'headerAuth',
    );
    expect((await post(url, INIT, { 'x-mcp-key': 'wrong' })).status).toBe(401);
    expect((await post(url, INIT)).status).toBe(401);
    const mcp = await legacyClient(url, { 'X-Mcp-Key': HEADER_VALUE });
    try {
      const answer = textOf(await mcp.client.callTool({ name: 'echo', arguments: {} }));
      expect(JSON.parse(answer).item.headers['x-mcp-key']).toBe('**hidden**');
      expect(answer).not.toContain(HEADER_VALUE);
      expect(JSON.stringify(await lastExecution(tenant.id, wf.id))).not.toContain(HEADER_VALUE);
    } finally {
      await mcp.client.close();
    }
  });

  it('None: open to any client; a session is refused to another subject', async () => {
    const open = await setup();
    expect((await post(open.url, INIT)).status).toBe(200);
    const { client, url, wf } = await withCredential('httpBearerAuth', { token: BEARER }, 'bearerAuth');
    const session = await openSession(url, { authorization: `Bearer ${BEARER}` });
    const ok = await post(url, rpc('tools/list'), {
      authorization: `Bearer ${BEARER}`,
      'mcp-session-id': session,
    });
    expect(ok.status).toBe(200);
    // the token changes: the old session belongs to another subject now
    const definition = await client.data(client.get(`/rest/workflows/${wf.id}`));
    const credentialId = (definition.nodes as Array<{ credentials?: DataObject }>)[0].credentials
      ?.httpBearerAuth as {
      id: string;
    };
    await client.data(
      client.patch(`/rest/credentials/${credentialId.id}`, { data: { token: `${BEARER}-new` } }),
    );
    const moved = await post(url, rpc('tools/list'), {
      authorization: `Bearer ${BEARER}-new`,
      'mcp-session-id': session,
    });
    expect(moved.status).toBe(404);
    expect((await post(url, rpc('ping'), { 'mcp-session-id': session })).status).toBe(401);
  });

  it('workspace sign-in refuses until the OAuth server is there', async () => {
    const { url } = await setup({ parameters: { authentication: 'n8nOAuth2' } });
    expect((await post(url, INIT)).status).toBe(401);
  });
});

describe('sessions and transport rules', () => {
  it('DELETE ends a session; the id then answers 404 Session not found', async () => {
    const { url } = await setup();
    const mcp = await legacyClient(url);
    const sessionId = mcp.transport.sessionId as string;
    expect(sessionId).toBeTruthy();
    await mcp.transport.terminateSession();
    await mcp.client.close();
    const res = await post(url, rpc('tools/list'), { 'mcp-session-id': sessionId });
    expect(res.status).toBe(404);
    expect((await rpcBody(res)).error.message).toBe('Session not found');
    // DELETE of an unknown or missing session
    expect((await fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } })).status).toBe(
      404,
    );
    const missing = await fetch(url, { method: 'DELETE' });
    expect(missing.status).toBe(400);
    expect((await rpcBody(missing)).error.message).toBe('No sessionId provided');
  });

  it('an idle session expires (15 minutes by default): 404', async () => {
    const { url } = await setup();
    const sessionId = await openSession(url);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const res = await post(url, rpc('tools/list'), { 'mcp-session-id': sessionId });
    expect(res.status).toBe(404);
  });

  it('refuses requests without a session, a session of another workflow, and an SSE id it does not know', async () => {
    const a = await setup();
    const user = a;
    const other = await mcpWorkflow(user.client);
    const otherUrl = `${server.url}/mcp/${user.tenant.slug}/${other.path}`;
    const noSession = await post(a.url, rpc('tools/list'));
    expect(noSession.status).toBe(400);
    expect((await rpcBody(noSession)).error.message).toBe('No sessionId provided');
    const session = await openSession(a.url);
    const foreign = await post(otherUrl, rpc('tools/list'), { 'mcp-session-id': session });
    expect(foreign.status).toBe(404);
    const sse = await post(`${a.url}?sessionId=${randomUUID()}`, rpc('tools/list'));
    expect(sse.status).toBe(401);
    expect((await rpcBody(sse)).error.message).toBe('No transport found for sessionId');
    // GET with a session id is not a stream here: 405, which clients expect
    const get = await fetch(a.url, { headers: { 'mcp-session-id': session, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
  });

  it('answers ping, 202 for notifications, -32601 for unknown methods, with CORS on every reply', async () => {
    const { url } = await setup();
    const session = await openSession(url);
    const headers = { 'mcp-session-id': session };
    const ping = await post(url, rpc('ping', undefined, 'p'), headers);
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(ping.headers.get('access-control-allow-origin')).toBe('*');
    expect(ping.headers.get('access-control-allow-credentials')).toBeNull();
    expect(ping.headers.get('access-control-expose-headers')).toContain('mcp-session-id');
    expect((await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status).toBe(
      202,
    );
    const unknown = await post(url, rpc('resources/list'), headers);
    expect((await rpcBody(unknown)).error.code).toBe(-32601);
  });

  it('refuses a batch with -32600 and an oversize body with 413', async () => {
    const { url } = await setup();
    const batch = await post(url, [INIT, rpc('ping', undefined, 2)]);
    expect(batch.status).toBe(400);
    expect((await rpcBody(batch)).error.code).toBe(-32600);
    const malformed = await post(url, '{"jsonrpc":');
    expect(malformed.status).toBe(400);
    expect((await rpcBody(malformed)).error.code).toBe(-32700);
    const big = await post(url, { ...INIT, params: { pad: 'x'.repeat(1_200_000) } });
    expect(big.status).toBe(413);
    expect((await rpcBody(big)).error.code).toBe(-32600);
  });

  it('a deactivated workflow answers 404', async () => {
    const { url, wf, client } = await setup();
    expect((await post(url, INIT)).status).toBe(200);
    await client.data(client.post(`/rest/workflows/${wf.id}/deactivate`));
    const gone = await post(url, INIT);
    expect(gone.status).toBe(404);
    // made before the hand-off to the MCP service, it still carries CORS: a browser client reads the 404
    expect(gone.headers.get('access-control-allow-origin')).toBe('*');
    expect(gone.headers.get('access-control-allow-credentials')).toBeNull();
    const unknown = await post(`${server.url}/mcp/no-such-workspace/tools`, INIT);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves a dynamic path and only that path', async () => {
    const user = await signup();
    const wf = await mcpWorkflow(user.client, { path: `team-${randomUUID().slice(0, 6)}/:team/tools` });
    const base = `${server.url}/mcp/${user.tenant.slug}/${wf.path.split('/')[0]}`;
    expect((await post(`${base}/red/tools`, INIT)).status).toBe(200);
    expect((await post(`${base}/red/other`, INIT)).status).toBe(404);
    expect((await post(`${base}/red/tools/more`, INIT)).status).toBe(404);
  });

  it('refuses a foreign Host with 403 on POST, GET and OPTIONS', async () => {
    const { tenant, wf } = await setup();
    for (const prefix of ['mcp', 'mcp-test']) {
      for (const method of ['POST', 'GET', 'OPTIONS'] as const) {
        const res = await server.app.inject({
          method,
          url: `/${prefix}/${tenant.slug}/${wf.path}`,
          headers: { host: 'evil.example', 'content-type': 'application/json' },
          payload: method === 'POST' ? JSON.stringify(INIT) : undefined,
        });
        expect(res.statusCode).toBe(403);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      }
    }
  });
});

describe('test URL', () => {
  it('survives initialize and list, and the first tool call uses it up', async () => {
    const { tenant, wf, client } = await setup({ activate: false });
    const listen = await client.data<{ testUrl: string }>(
      client.post(`/rest/workflows/${wf.id}/listen-test-webhook`, { nodeName: TRIGGER }),
    );
    const testUrl = `${server.url}${new URL(listen.testUrl).pathname}`;
    expect(testUrl).toContain('/mcp-test/');
    const registrations = async () =>
      (await server.ctx.testWebhooks.list(tenant.id)).filter((r) => r.workflowId === wf.id);
    expect((await registrations()).length).toBeGreaterThan(0);
    const mcp = await legacyClient(testUrl);
    try {
      expect((await mcp.client.listTools()).tools).toHaveLength(3);
      expect((await registrations()).length).toBeGreaterThan(0);
      expect(textOf(await mcp.client.callTool({ name: 'Calculator', arguments: { input: '3 + 4' } }))).toBe(
        '7',
      );
      expect(await registrations()).toEqual([]);
      const execution = await lastExecution(tenant.id, wf.id);
      expect(execution?.mode).toBe('manual');
      await expect(mcp.client.callTool({ name: 'Calculator', arguments: { input: '1' } })).rejects.toThrow();
      // the used-up URL answers 404 with CORS
      const gone = await post(testUrl, INIT);
      expect(gone.status).toBe(404);
      expect(gone.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await mcp.client.close();
    }
  });
});

describe('tool input, long calls and waits', () => {
  // one workspace for the block: sign-ups are rate limited
  let user: Awaited<ReturnType<typeof signup>>;
  beforeAll(async () => {
    user = await signup();
  });

  /** a workflow whose trigger serves one tool node */
  async function toolWorkflow(type: string, name: string) {
    const path = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`;
    const wf = await createWorkflow(user.client, {
      name: `MCP ${path}`,
      nodes: [
        node(TRIGGER, 'ai.mcpTrigger', { path }, [0, 0], { webhookId: randomUUID() }),
        node(name, type, {}, [0, 200]),
      ],
      connections: { [name]: toolLink() },
    });
    await user.client.data(user.client.post(`/rest/workflows/${wf.id}/activate`));
    return { ...user, wf, url: `${server.url}/mcp/${user.tenant.slug}/${path}` };
  }

  it('at tools/list a tool sees the base item of a call: body and redacted headers', async () => {
    const wf = await mcpWorkflow(user.client);
    const mcp = await legacyClient(`${server.url}/mcp/${user.tenant.slug}/${wf.path}`, {
      cookie: 'other=cookie-secret-0123456789',
    });
    try {
      supplied.length = 0;
      await mcp.client.listTools();
      expect(supplied).toHaveLength(1);
      const [listed] = supplied;
      expect(Object.keys(listed).sort()).toEqual(['body', 'headers']);
      expect(listed.body).toMatchObject({ method: 'tools/list' });
      expect(listed.headers).toMatchObject({ cookie: '**hidden**', 'content-type': 'application/json' });
      const answer = JSON.parse(textOf(await mcp.client.callTool({ name: 'echo', arguments: {} })));
      // the call's item adds the trigger's own fields to the same base
      expect(Object.keys(answer.item).sort()).toEqual(['body', 'headers', 'mcpMessageId', 'mcpToolCall']);
      expect(answer.item.headers.cookie).toBe('**hidden**');
    } finally {
      await mcp.client.close();
    }
  });

  it('legacy SSE: a POST gets 202 at once and a long tool answers on the stream later', async () => {
    const { url } = await toolWorkflow('test.mcpGated', 'Gated');
    gate = new Promise((resolve) => {
      open = resolve;
    });
    const abort = new AbortController();
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: abort.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = '';
      const until = async (pattern: RegExp) => {
        for (let match = pattern.exec(text); ; match = pattern.exec(text)) {
          if (match) return match;
          const { value, done } = await reader.read();
          if (done) throw new Error('the stream ended');
          text += decoder.decode(value, { stream: true });
        }
      };
      const endpoint = (await until(/event: endpoint\ndata: (\S+)/))[1];
      const call = post(`${server.url}${endpoint}`, rpc('tools/call', { name: 'gated', arguments: {} }, 7));
      const first = await Promise.race([
        call,
        new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 5_000)),
      ]);
      // the tool still waits for the gate, and the POST is already answered
      expect(first).not.toBe('held');
      expect((first as Response).status).toBe(202);
      open();
      const answer = JSON.parse((await until(/data: (\{[^\n]*"id":7[^\n]*\})\n/))[1]);
      expect(answer.result.content).toEqual([{ type: 'text', text: 'opened' }]);
      await reader.cancel().catch(() => {});
    } finally {
      open();
      abort.abort();
    }
  });

  it('a tool that waits for a person answers the client once; the resume never runs it again', async () => {
    const { tenant, wf, url, client } = await toolWorkflow('test.mcpApproval', 'Approve');
    approvals = 0;
    const publish = vi.spyOn(server.ctx.bus, 'publish');
    const answers = () =>
      publish.mock.calls.filter(([channel]) => String(channel).startsWith('mcp-session:')).map(([, m]) => m);
    const mcp = await sseClient(url);
    try {
      const result = await mcp.callTool({ name: 'approve', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(MCP_TOOL_WAITING);
      expect(approvals).toBe(1);
      const [row] = await executionsOf(server.ctx, tenant.id, wf.id);
      expect(row.status).toBe('waiting');
      const sent = answers().length;
      expect(answers().filter((m) => JSON.stringify(m).includes(MCP_TOOL_WAITING))).toHaveLength(1);
      // the person answers: the run ends with that answer and the tool does not run a second time
      const answer = [[{ json: { approved: true } }]];
      const resumed = await server.ctx.executions.resume(tenant.id, row.id, answer, { wait: true });
      expect((await resumed?.finished)?.status).toBe('success');
      expect(approvals).toBe(1);
      const execution = await client.data(client.get(`/rest/executions/${row.id}`));
      expect(outputOf(execution.state, TRIGGER)[0].mcpToolResult).toEqual({
        content: [{ type: 'text', text: '{"approved":true}' }],
      });
      // nothing more reached the client
      expect(answers()).toHaveLength(sent);
    } finally {
      publish.mockRestore();
      await mcp.close();
    }
  });
});
