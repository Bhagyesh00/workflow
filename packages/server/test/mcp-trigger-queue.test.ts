/**
 * P5-03 MCP Server Trigger in queue mode: two mains (A and B) and a worker share Postgres and Redis db /6 only,
 * like separate processes. A session opened on A is used on B: Streamable HTTP reads it from Redis, and a legacy
 * SSE stream held by A gets B's answers over the bus. Every tool call runs on the worker, and its
 * `lastNodeOutput` comes back to the main that answers.
 */
import { randomUUID } from 'node:crypto';
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HttpClient } from '@workflow/core';
import { nodesAiPackage } from '@workflow/nodes-ai';
import { nodesBasePackage } from '@workflow/nodes-base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createContext, type ServerContext } from '../src/context';
import {
  createWorkflow,
  executionsOf,
  flushRedis,
  node,
  startMcpTestServer,
  TEST_REDIS,
  TestClient,
  type TestServer,
  testConfig,
  testPackage,
} from './helpers';

const QUEUE_ENV = { EXECUTIONS_MODE: 'queue', REDIS_URL: TEST_REDIS, QUEUE_PREFIX: 'wfmcpq' };
const TRIGGER = 'MCP Server Trigger';

let mainA: TestServer & { url: string };
let mainB: TestServer & { url: string };
let worker: ServerContext;
let tenantId: string;
let workflowId: string;
let path: string;

beforeAll(async () => {
  // this lane's Redis db only (TEST_REDIS_URL, /6)
  await flushRedis();
  mainA = await startMcpTestServer(QUEUE_ENV, { nodePackages: [nodesAiPackage] });
  mainB = await startMcpTestServer(QUEUE_ENV, { nodePackages: [nodesAiPackage], reset: false });
  worker = await createContext({
    // mains and workers share the binary data directory (a volume in production)
    config: testConfig({ ...QUEUE_ENV, BINARY_DATA_DIR: mainA.ctx.config.binaryData.dir }),
    nodePackages: [nodesBasePackage, testPackage, nodesAiPackage],
    http: new HttpClient({ ssrf: { enabled: true, allow: ['127.0.0.1'], deny: [] } }),
    migrate: false,
  });
  await worker.startWorker();

  const client = new TestClient(mainA.app, mainA.url);
  const res = await client.post('/rest/auth/signup', {
    email: `mcp-queue-${randomUUID().slice(0, 8)}@example.com`,
    password: 'Passw0rd!',
    name: 'Queue',
    workspaceName: 'Queue',
  });
  const { tenant } = res.json().data as { tenant: { id: string; slug: string } };
  tenantId = tenant.id;
  const wf = await createWorkflow(client, {
    nodes: [
      node(TRIGGER, 'ai.mcpTrigger', { path: 'queue-tools' }, [0, 0], { webhookId: randomUUID() }),
      node('Calculator', 'ai.toolCalculator', {}, [0, 200]),
    ],
    connections: { Calculator: { ai_tool: [[{ node: TRIGGER, type: 'ai_tool', index: 0 }]] } },
  });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  workflowId = wf.id;
  path = `/mcp/${tenant.slug}/queue-tools`;
});

afterAll(async () => {
  await mainA?.close();
  await mainB?.close();
  await worker?.close();
});

/** the executions the worker took from the queue while `fn` ran: a run on a main never reaches it */
async function onWorker(fn: () => Promise<void>) {
  const taken = vi.spyOn(worker.executions, 'runQueued');
  try {
    await fn();
    return taken.mock.calls.map(([job]) => job.executionId);
  } finally {
    taken.mockRestore();
  }
}

/** a fetch that sends what `route` picks to main B, the rest to main A; counts B's requests */
function routed(route: (init: RequestInit | undefined, index: number) => boolean) {
  const seen = { b: 0, total: 0 };
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const toB = route(init, seen.total++);
    if (toB) seen.b++;
    return fetch(toB ? url.replace(mainA.url, mainB.url) : url, init);
  };
  return { fetchFn, seen };
}

const textOf = (result: unknown) =>
  (result as { content: Array<{ text?: string }> }).content.map((p) => p.text ?? '').join('');

describe('MCP Server Trigger in queue mode', () => {
  it('Streamable HTTP: a session opened on A answers on B, the call runs on the worker', async () => {
    const before = (await executionsOf(mainA.ctx, tenantId, workflowId)).length;
    // the first request (initialize) goes to A, everything after it to B
    const { fetchFn, seen } = routed((_init, index) => index > 0);
    const client = new SdkClient({ name: 'queue-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${mainA.url}${path}`), { fetch: fetchFn });
    await client.connect(transport);
    try {
      const sessionId = transport.sessionId as string;
      // the session lives in Redis, so main B sees it
      expect(await mainB.ctx.mcpSessions.get(sessionId)).toMatchObject({ workflowId, transport: 'http' });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['Calculator']);
      const ran = await onWorker(async () => {
        const result = await client.callTool({ name: 'Calculator', arguments: { input: '6 * 7' } });
        expect(textOf(result)).toBe('42');
      });
      expect(seen.b).toBeGreaterThanOrEqual(2);
      const runs = await executionsOf(mainA.ctx, tenantId, workflowId);
      expect(runs.length).toBe(before + 1);
      // the worker ran the call's execution, and its answer came back to main B
      expect(ran).toEqual([runs[0].id]);
    } finally {
      await client.close();
    }
  });

  it('legacy SSE: the stream held by A carries the answers of POSTs sent to B', async () => {
    // the GET stream stays on A; every POST goes to B
    const { fetchFn, seen } = routed((init) => init?.method === 'POST');
    const client = new SdkClient({ name: 'queue-sse-test', version: '1.0.0' });
    await client.connect(new SSEClientTransport(new URL(`${mainA.url}${path}`), { fetch: fetchFn }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['Calculator']);
      const ran = await onWorker(async () => {
        const result = await client.callTool({ name: 'Calculator', arguments: { input: '10 - 3' } });
        expect(textOf(result)).toBe('7');
      });
      expect(seen.b).toBeGreaterThanOrEqual(3);
      expect(await mainA.ctx.mcpSessions.countStreams(tenantId)).toBe(1);
      const [latest] = await executionsOf(mainA.ctx, tenantId, workflowId);
      expect(ran).toEqual([latest.id]);
    } finally {
      await client.close();
    }
  });
});
