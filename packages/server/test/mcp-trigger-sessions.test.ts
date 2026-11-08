/**
 * P5-03 MCP Server Trigger sessions: the memory store (idle TTL, sweep, tenant cap, streams), the Redis store of
 * queue mode (TTL keys, any main reads them), and through the app: a running call keeps its session past the
 * idle TTL, an SSE session ends with its stream, and an idle session is gone.
 */
import { randomUUID } from 'node:crypto';
import { nodesAiPackage } from '@workflow/nodes-ai';
import type { AiTool, DataObject, NodePackage, NodeType } from '@workflow/workflow';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger';
import {
  createMcpSessionStore,
  MCP_TENANT_SESSION_CAP,
  type McpSessionRecord,
  type McpSessionStore,
} from '../src/services/mcp-sessions';
import {
  createWorkflow,
  node,
  startMcpTestServer,
  TEST_REDIS,
  TestClient,
  type TestServer,
  testConfig,
  waitFor,
} from './helpers';

const logger = createLogger('silent');

const record = (overrides: Partial<McpSessionRecord> = {}): Omit<McpSessionRecord, 'lastSeen'> => ({
  tenantId: 't1',
  workflowId: 'w1',
  nodeName: 'MCP Server Trigger',
  subjectHash: '',
  protocolVersion: '2025-06-18',
  transport: 'http',
  ...overrides,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('memory store', () => {
  const config = testConfig({ MCP_SERVER_SESSION_IDLE_TTL_MS: '1000', MCP_SERVER_SESSION_SWEEP_INTERVAL_MS: '500' });
  let store: McpSessionStore;
  afterEach(async () => {
    await store?.close();
  });

  it('is the store outside queue mode, even with Redis configured', async () => {
    const redis = new Redis(TEST_REDIS, { maxRetriesPerRequest: 1 });
    try {
      store = createMcpSessionStore({ config, logger, redis });
      const id = await store.create(record());
      // nothing went to Redis
      expect(await redis.keys(`*${id}*`)).toEqual([]);
    } finally {
      await redis.quit();
    }
  });

  it('creates, reads, touches and deletes a session', async () => {
    store = createMcpSessionStore({ config, logger });
    const id = await store.create(record({ subjectHash: 'abc' }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get(id)).toMatchObject({ ...record({ subjectHash: 'abc' }), lastSeen: expect.any(Number) });
    expect(await store.get(randomUUID())).toBeUndefined();
    expect(await store.touch(id)).toBe(true);
    expect(await store.delete(id)).toBe(true);
    expect(await store.delete(id)).toBe(false);
    expect(await store.get(id)).toBeUndefined();
    expect(await store.touch(id)).toBe(false);
  });

  it('forgets a session idle past the TTL; a touch keeps it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    store = createMcpSessionStore({ config, logger });
    const idle = await store.create(record());
    const busy = await store.create(record());
    vi.setSystemTime(1_000_800);
    expect(await store.touch(busy)).toBe(true);
    vi.setSystemTime(1_001_500);
    expect(await store.get(idle)).toBeUndefined();
    expect(await store.get(busy)).toBeDefined();
  });

  it('sweeps idle sessions on its interval', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    store = createMcpSessionStore({ config, logger });
    store.startSweep();
    const id = await store.create(record());
    expect(await store.sweep(2_000_500)).toBe(0);
    expect(await store.sweep(2_002_000)).toBe(1);
    const next = await store.create(record());
    await vi.advanceTimersByTimeAsync(1_600);
    vi.useRealTimers();
    expect(await store.get(next)).toBeUndefined();
    expect(await store.get(id)).toBeUndefined();
  });

  it('holds at most the tenant cap, dropping the least recently used', async () => {
    store = createMcpSessionStore({ config, logger });
    const ids: string[] = [];
    for (let i = 0; i < MCP_TENANT_SESSION_CAP; i++) ids.push(await store.create(record()));
    const other = await store.create(record({ tenantId: 't2' }));
    await store.touch(ids[0]);
    await store.create(record());
    expect(await store.get(ids[0])).toBeDefined();
    expect(await store.get(ids[1])).toBeUndefined();
    expect(await store.get(other)).toBeDefined();
  });

  it('counts a tenant SSE streams', async () => {
    store = createMcpSessionStore({ config, logger });
    await store.create(record({ transport: 'sse' }));
    await store.create(record({ transport: 'sse' }));
    await store.create(record());
    await store.create(record({ tenantId: 't2', transport: 'sse' }));
    expect(await store.countStreams('t1')).toBe(2);
    expect(await store.countStreams('t2')).toBe(1);
    expect(await store.countStreams('t3')).toBe(0);
  });
});

describe('Redis store (queue mode)', () => {
  const prefix = `mcpsess${process.pid}${Date.now()}`;
  const config = testConfig({
    EXECUTIONS_MODE: 'queue',
    REDIS_URL: TEST_REDIS,
    QUEUE_PREFIX: prefix,
    MCP_SERVER_SESSION_IDLE_TTL_MS: '400',
  });
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(TEST_REDIS, { maxRetriesPerRequest: 1 });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  it('keeps sessions as TTL keys that a second main reads', async () => {
    const a = createMcpSessionStore({ config, logger, redis });
    const b = createMcpSessionStore({ config, logger, redis });
    const id = await a.create(record({ subjectHash: 'h' }));
    const ttl = await redis.pttl(`${prefix}:mcp-session:${id}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    expect(await b.get(id)).toMatchObject({ subjectHash: 'h', transport: 'http' });
    expect(await b.get('not-a-session-id')).toBeUndefined();
    expect(await b.touch(id)).toBe(true);
    expect(await b.delete(id)).toBe(true);
    expect(await a.get(id)).toBeUndefined();
    expect(await a.delete(id)).toBe(false);
  });

  it('expires idle sessions and counts streams per tenant', async () => {
    const store = createMcpSessionStore({ config, logger, redis });
    const tenant = randomUUID();
    const stream = await store.create(record({ tenantId: tenant, transport: 'sse' }));
    await store.create(record({ tenantId: tenant, transport: 'sse' }));
    expect(await store.countStreams(tenant)).toBe(2);
    await store.delete(stream);
    expect(await store.countStreams(tenant)).toBe(1);
    const idle = await store.create(record({ tenantId: tenant }));
    await new Promise((r) => setTimeout(r, 600));
    expect(await store.get(idle)).toBeUndefined();
    expect(await store.countStreams(tenant)).toBe(0);
  });
});

/** a tool that takes its time: longer than the session's idle TTL */
const slowTool: NodeType = {
  description: {
    name: 'test.mcpSlow',
    displayName: 'MCP Slow',
    description: 'Answers after a while',
    icon: 'lucide:timer',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Slow' },
    inputs: [],
    outputs: ['ai_tool'],
    properties: [],
  },
  async supplyData() {
    const tool: AiTool = {
      kind: 'tool',
      name: 'slow',
      description: 'Slow',
      parameters: { type: 'object', properties: {} },
      invoke: async () => {
        await new Promise((r) => setTimeout(r, 1_500));
        return 'done';
      },
    };
    return { response: tool };
  },
};
const slowPackage: NodePackage = { name: 'mcp-session-tests', nodes: [slowTool], credentials: [] };

describe('sessions through the app', () => {
  let server: TestServer & { url: string; port: number };
  let url: string;
  let tenantId: string;

  beforeAll(async () => {
    server = await startMcpTestServer(
      { MCP_SERVER_SESSION_IDLE_TTL_MS: '600' },
      { nodePackages: [nodesAiPackage, slowPackage] },
    );
    const client = new TestClient(server.app, server.url);
    const res = await client.post('/rest/auth/signup', {
      email: `mcp-sessions-${randomUUID().slice(0, 8)}@example.com`,
      password: 'Passw0rd!',
      name: 'Sessions',
      workspaceName: 'Sessions',
    });
    const { tenant } = res.json().data as { tenant: { id: string; slug: string } };
    tenantId = tenant.id;
    const wf = await createWorkflow(client, {
      nodes: [
        node('MCP Server Trigger', 'ai.mcpTrigger', { path: 'slow' }, [0, 0], { webhookId: randomUUID() }),
        node('Slow', 'test.mcpSlow', {}, [0, 200]),
      ],
      connections: { Slow: { ai_tool: [[{ node: 'MCP Server Trigger', type: 'ai_tool', index: 0 }]] } },
    });
    await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
    url = `${server.url}/mcp/${tenant.slug}/slow`;
  });
  afterAll(async () => {
    await server?.close();
  });

  const post = (body: DataObject, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });
  const open = async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    return res.headers.get('mcp-session-id') as string;
  };
  const list = (session: string) => post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session });

  it('a running call keeps its session past the idle TTL; an idle one goes', async () => {
    const busy = await open();
    const idle = await open();
    const call = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slow', arguments: {} } },
      { 'mcp-session-id': busy },
    );
    expect(((await call.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text).toBe('done');
    expect((await list(busy)).status).toBe(200);
    expect((await list(idle)).status).toBe(404);
  });

  it('an SSE session lives as long as its stream', async () => {
    const abort = new AbortController();
    const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const sessionId = /sessionId=([0-9a-f-]{36})/.exec(first)?.[1] as string;
    expect(first).toContain('event: endpoint');
    expect(first).toContain(`/mcp/`);
    // kept alive past the idle TTL by the stream's own keep-alive
    await new Promise((r) => setTimeout(r, 900));
    expect(await server.ctx.mcpSessions.get(sessionId)).toMatchObject({ transport: 'sse', tenantId });
    expect(await server.ctx.mcpSessions.countStreams(tenantId)).toBe(1);
    abort.abort();
    await reader.cancel().catch(() => {});
    await waitFor(async () => (await server.ctx.mcpSessions.get(sessionId)) === undefined || undefined, {
      message: 'the SSE session to end with its stream',
    });
    expect(await server.ctx.mcpSessions.countStreams(tenantId)).toBe(0);
  });
});
