/**
 * P6 S5 C0: the engine hooks log streaming and tracing build on. A node's `logAiEvent` reaches `hooks.aiEvent`
 * (root and sub-node), `services.traceHeaders` reaches the HTTP helpers without replacing a header the node set,
 * the SSRF guard reports to `setGuardListener`, and the C0 telemetry tag resolver (a stub) leaves metadata as is.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Connections,
  type NodeType,
  type NodeTypeDescription,
  Workflow,
  type WorkflowNode,
} from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AiEventRecord,
  type GuardEvent,
  HttpClient,
  NodeTypes,
  resolveTelemetryTags,
  SsrfBlockedError,
  WorkflowExecute,
} from '../src';
import { connect, execute, node, services, testNodes } from './helpers';

function description(
  name: string,
  inputs: NodeTypeDescription['inputs'],
  outputs: NodeTypeDescription['outputs'],
): NodeTypeDescription {
  return {
    name,
    displayName: name,
    description: name,
    group: ['transform'],
    version: 1,
    defaults: { name },
    inputs,
    outputs,
    properties: [],
  };
}

/** what the local server received, one entry per request */
let received: Array<http.IncomingHttpHeaders> = [];
let baseUrl = '';
const server = http.createServer((req, res) => {
  received.push(req.headers);
  res.setHeader('content-type', 'application/json');
  res.end('{"ok":true}');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const types = new NodeTypes([
  ...testNodes,
  {
    description: description('p6s5.aiRoot', ['main', { type: 'ai_memory', displayName: 'Memory' }], ['main']),
    async execute(ctx) {
      await ctx.getInputConnectionData('ai_memory', 0);
      ctx.logAiEvent?.('ai.llm.generated', 'root message');
      return [ctx.getInputData()];
    },
  },
  {
    description: description('p6s5.memory', [], ['ai_memory']),
    async supplyData(ctx) {
      ctx.logAiEvent?.('ai.memory.get.messages');
      return { response: { kind: 'memory' } };
    },
  },
  {
    description: description('p6s5.http', ['main'], ['main']),
    async execute(ctx) {
      // a plain call, then one where the node set its own trace header (another case)
      await ctx.helpers.httpRequest({ url: baseUrl });
      await ctx.helpers.httpRequest({ url: baseUrl, headers: { TraceParent: 'node-own-value' } });
      await ctx.helpers.httpRequestWithAuthentication('apiKey', { url: baseUrl });
      return [ctx.getInputData()];
    },
  },
]);

const run = (
  nodes: WorkflowNode[],
  connections: Connections,
  overrides: Parameters<typeof services>[0] = {},
) =>
  new WorkflowExecute(
    new Workflow({ name: 'p6s5', nodes, connections }, types),
    services({ nodeTypes: types, ...overrides }),
  ).run({ startNode: 'Start' });

describe('logAiEvent reaches hooks.aiEvent', () => {
  const nodes = (): WorkflowNode[] => [
    node('Start', 'test.trigger'),
    node('Root', 'p6s5.aiRoot', [100, 0]),
    node('Memory', 'p6s5.memory', [100, 200]),
  ];
  const connections = (): Connections => ({
    ...connect(['Start', 'Root']),
    Memory: { ai_memory: [[{ node: 'Root', type: 'ai_memory', index: 0 }]] },
  });

  it('a root node and its sub-node report with their own name and type', async () => {
    const events: AiEventRecord[] = [];
    const result = await run(nodes(), connections(), { hooks: { aiEvent: (event) => events.push(event) } });
    expect(result.status).toBe('success');
    expect(events).toEqual([
      { name: 'ai.memory.get.messages', nodeName: 'Memory', nodeType: 'p6s5.memory', msg: '' },
      { name: 'ai.llm.generated', nodeName: 'Root', nodeType: 'p6s5.aiRoot', msg: 'root message' },
    ]);
  });

  it('a throwing hook never fails the run, and no hook is fine', async () => {
    const throwing = await run(nodes(), connections(), {
      hooks: {
        aiEvent: () => {
          throw new Error('hook down');
        },
      },
    });
    expect(throwing.status).toBe('success');
    const none = await run(nodes(), connections());
    expect(none.status).toBe('success');
  });
});

describe('trace headers on the HTTP helpers', () => {
  const nodes = (): WorkflowNode[] => [
    node('Start', 'test.trigger'),
    node('Call', 'p6s5.http', [100, 0], { credentials: { apiKey: { id: 'c1', name: 'Key' } } }),
  ];
  const http127 = () => new HttpClient({ ssrf: { allow: ['127.0.0.1'] } });

  it('adds the trace headers for the calling node unless the node set that header (any case)', async () => {
    received = [];
    const asked: string[] = [];
    const result = await run(nodes(), connect(['Start', 'Call']), {
      http: http127(),
      traceHeaders: (nodeName) => {
        asked.push(nodeName);
        return { traceparent: 'fake-trace-value', tracestate: 'fake-state' };
      },
    });
    expect(result.status).toBe('success');
    expect(asked).toEqual(['Call', 'Call', 'Call']);
    expect(received).toHaveLength(3);
    expect(received[0]?.traceparent).toBe('fake-trace-value');
    expect(received[0]?.tracestate).toBe('fake-state');
    expect(received[1]?.traceparent).toBe('node-own-value');
    expect(received[1]?.tracestate).toBe('fake-state');
    expect(received[2]?.traceparent).toBe('fake-trace-value');
    expect(received[2]?.['x-api-key']).toBeDefined();
  });

  it('sends no trace header when the host gives none, and a failing source fails nothing', async () => {
    received = [];
    const plain = await run(nodes(), connect(['Start', 'Call']), { http: http127() });
    expect(plain.status).toBe('success');
    const failing = await run(nodes(), connect(['Start', 'Call']), {
      http: http127(),
      traceHeaders: () => {
        throw new Error('tracer down');
      },
    });
    expect(failing.status).toBe('success');
    expect(received).toHaveLength(6);
    expect(received.filter((h) => h.traceparent === 'node-own-value')).toHaveLength(2);
    expect(received.filter((h) => h.traceparent && h.traceparent !== 'node-own-value')).toHaveLength(0);
  });
});

describe('HttpClient.setGuardListener', () => {
  it('reports an allowed and a blocked address, with lookups, and never changes the outcome', async () => {
    const events: GuardEvent[] = [];
    const client = new HttpClient({ ssrf: { allow: ['127.0.0.1', 'localhost'] } });
    client.setGuardListener((event) => events.push(event));

    // an IP literal: checked at connect time, no lookup
    await client.request({ url: baseUrl });
    expect(events).toEqual([{ kind: 'check', allowed: true }]);

    // blocked before any connection (the pre-check)
    events.length = 0;
    await expect(client.request({ url: 'http://10.0.0.1/' })).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(events).toEqual([{ kind: 'check', allowed: false }]);

    // a name: one lookup, then the check of its addresses
    events.length = 0;
    const port = (server.address() as AddressInfo).port;
    await client.request({ url: `http://localhost:${port}/` }).catch(() => undefined);
    const lookups = events.filter((e) => e.kind === 'lookup');
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    expect(lookups[0]).toMatchObject({ kind: 'lookup', ok: true });
    expect((lookups[0] as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    expect(events).toContainEqual({ kind: 'check', allowed: true });
  });

  it('reports resolveAllowedHost checks, survives a throwing listener and can be removed', async () => {
    const events: GuardEvent[] = [];
    const client = new HttpClient();
    client.setGuardListener((event) => events.push(event));
    await client.resolveAllowedHost('93.184.216.34');
    await expect(client.resolveAllowedHost('169.254.169.254')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(client.resolveAllowedHost('metadata.google.internal')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(events).toEqual([
      { kind: 'check', allowed: true },
      { kind: 'check', allowed: false },
      { kind: 'check', allowed: false },
    ]);

    client.setGuardListener(() => {
      throw new Error('metrics down');
    });
    await expect(client.resolveAllowedHost('93.184.216.34')).resolves.toMatchObject({
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    expect(() => client.assertUrlAllowed('http://10.0.0.1/')).toThrow(SsrfBlockedError);

    events.length = 0;
    client.setGuardListener(undefined);
    await client.resolveAllowedHost('93.184.216.34');
    expect(events).toEqual([]);
  });
});

describe('telemetry tags (C0 stub, L11)', () => {
  it('the stub resolver returns undefined', () => {
    const tagged = node('Set', 'test.set', [0, 0], {
      customTelemetryTags: { tag: [{ key: 'team', value: 'core' }] },
    });
    expect(resolveTelemetryTags(tagged, () => 'x')).toBeUndefined();
  });

  it('a node with tags gets no metadata.tracing, and its metadata stays as before', async () => {
    const result = await execute({
      name: 'tags',
      nodes: [
        node('Start', 'test.trigger'),
        node('Set', 'test.set', [100, 0], {
          customTelemetryTags: { tag: [{ key: 'team', value: '={{ 1 + 1 }}' }] },
        }),
      ],
      connections: connect(['Start', 'Set']),
      settings: { customTelemetryTags: [{ key: 'area', value: 'billing' }] },
    }).run({ startNode: 'Start' });
    expect(result.status).toBe('success');
    const task = result.state.resultData.runData.Set?.[0];
    expect(task?.executionStatus).toBe('success');
    expect(task?.metadata).toBeUndefined();
  });
});
