/**
 * P6-66 (S5 L10): trace propagation. An inbound `traceparent` (with `tracestate`) of a production webhook becomes
 * the run's parent; a sampled-out parent and a ratio of 0 send nothing; an HTTP Request node sends its own span's
 * `traceparent`, the `tracestate` and the inbound `baggage` without our reserved roots to a fake target, and
 * nothing when `injectOutbound` is off; a sub-node run becomes a zero-length child of its parent node's span.
 * Every receiver is an in-process fake on 127.0.0.1; fixed fake header values only, never printed.
 */
import { randomUUID } from 'node:crypto';
import type { TaskData, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunScope } from '../src/services/observability/lifecycle';
import { inboundBaggage, outboundTraceHeaders } from '../src/services/tracing/propagation';
import { startHttpSink } from './fakes/http-sink';
import { type OtlpCollector, startOtlpCollector } from './fakes/otlp';
import {
  chain,
  createTestServer,
  createWorkflow,
  enableTracing,
  node,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;
let collector: OtlpCollector;

type Span = ReturnType<OtlpCollector['spans']>[number];

const INBOUND_TRACE = '0af7651916cd43dd8448eb211c80319c';
const INBOUND_SPAN = 'b7ad6b7169203331';

async function spansOf(target: OtlpCollector, executionId: string, min = 1): Promise<Span[]> {
  return waitFor(
    async () => {
      await server.ctx.tracing.flush();
      const spans = target.spans().filter((s) => s.attributes['execution.id'] === executionId);
      return spans.length >= min ? spans : undefined;
    },
    { timeout: 15_000, message: `${min} spans of ${executionId}` },
  );
}

async function noSpansOf(target: OtlpCollector, executionId: string) {
  await new Promise((r) => setTimeout(r, 400));
  await server.ctx.tracing.flush();
  expect(target.spans().filter((s) => s.attributes['execution.id'] === executionId)).toEqual([]);
}

const nodeSpan = (spans: Span[], nodeName: string) =>
  spans.find((s) => s.name === 'node.execute' && s.attributes['node.name'] === nodeName);

async function webhookFlow(
  account: Awaited<ReturnType<typeof signup>>,
  nodes: WorkflowNode[],
): Promise<{ workflowId: string; path: string }> {
  const path = `t-${randomUUID().slice(0, 8)}`;
  const all = [
    node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() }),
    ...nodes,
  ];
  const workflow = await createWorkflow(account.client, {
    nodes: all,
    connections: chain(...all.map((n) => n.name)),
  });
  await account.client.data(account.client.post(`/rest/workflows/${workflow.id}/activate`));
  return { workflowId: workflow.id, path };
}

async function call(
  account: Awaited<ReturnType<typeof signup>>,
  flow: { workflowId: string; path: string },
  headers: Record<string, string> = {},
) {
  const res = await server.app.inject({
    method: 'POST',
    url: `/webhook/${account.tenant.slug}/${flow.path}`,
    headers,
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  const run = await waitFor(
    async () =>
      (
        await server.ctx.repos.executions.list(account.tenant.id, { workflowId: flow.workflowId, limit: 1 })
      )[0],
    { message: 'the run to start' },
  );
  await waitForExecution(server.ctx, account.tenant.id, run.id, ['success']);
  return run.id;
}

beforeAll(async () => {
  server = await createTestServer();
  owner = await signup(server.app);
  collector = await startOtlpCollector();
  await enableTracing(server, owner.tenant.id, { exporterEndpoint: collector.url });
});
afterAll(async () => {
  await server?.close();
  await collector?.close();
});

describe('headers', () => {
  it('outboundTraceHeaders writes traceparent, tracestate and baggage', () => {
    expect(
      outboundTraceHeaders(
        { traceId: INBOUND_TRACE, spanId: INBOUND_SPAN, traceFlags: 1, traceState: 'congo=t61rcWkgMzE' },
        'team=blue',
      ),
    ).toEqual({
      traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
      tracestate: 'congo=t61rcWkgMzE',
      baggage: 'team=blue',
    });
    expect(outboundTraceHeaders({ traceId: INBOUND_TRACE, spanId: INBOUND_SPAN, traceFlags: 0 })).toEqual({
      traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-00`,
    });
  });

  it('inbound baggage loses the keys under our reserved roots', () => {
    expect(
      inboundBaggage(
        'workflow.id=spoof,execution.id=x,node.name=n,project.id=p,instance.id=i,service.name=s,team=blue,app=a%20b',
      ),
    ).toBe('team=blue,app=a%20b');
    expect(inboundBaggage('workflow.id=spoof')).toBeUndefined();
    expect(inboundBaggage(undefined)).toBeUndefined();
  });

  it('headersFor answers nothing for a run this process does not trace', () => {
    expect(server.ctx.tracingObserver.headersFor(randomUUID(), 'Any')).toBeUndefined();
  });
});

describe('inbound', () => {
  it("a production webhook's traceparent becomes the run's parent", async () => {
    const flow = await webhookFlow(owner, [setNode('Done', 'ok', 'yes')]);
    const executionId = await call(owner, flow, {
      traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
      tracestate: 'congo=t61rcWkgMzE',
    });
    const spans = await spansOf(collector, executionId, 3);
    const run = spans.find((s) => s.name === 'workflow.execute')!;
    expect(run.traceId).toBe(INBOUND_TRACE);
    expect(run.parentSpanId).toBe(INBOUND_SPAN);
    expect(run.traceState).toBe('congo=t61rcWkgMzE');
    expect(nodeSpan(spans, 'Done')?.traceId).toBe(INBOUND_TRACE);
    const stored = await server.ctx.repos.executions.tracingContextOf(owner.tenant.id, executionId);
    expect(stored?.traceparent).toBe(`00-${INBOUND_TRACE}-${run.spanId}-01`);
    expect(stored?.tracestate).toBe('congo=t61rcWkgMzE');
  });

  it('a sampled-out parent sends nothing', async () => {
    const flow = await webhookFlow(owner, [setNode('Done', 'ok', 'yes')]);
    const executionId = await call(owner, flow, {
      traceparent: `00-${'c'.repeat(32)}-${INBOUND_SPAN}-00`,
    });
    await noSpansOf(collector, executionId);
    // the context is still stored, so a child continues unsampled
    const stored = await server.ctx.repos.executions.tracingContextOf(owner.tenant.id, executionId);
    expect(stored?.traceparent).toMatch(new RegExp(`^00-${'c'.repeat(32)}-[0-9a-f]{16}-00$`));
  });

  it('a ratio of 0 sends nothing for a root run', async () => {
    const zero = await signup(server.app);
    const target = await startOtlpCollector();
    try {
      await enableTracing(server, zero.tenant.id, { exporterEndpoint: target.url, tracesSampleRate: 0 });
      const flow = await webhookFlow(zero, [setNode('Done', 'ok', 'yes')]);
      const executionId = await call(zero, flow);
      await noSpansOf(target, executionId);
    } finally {
      await target.close();
    }
  });
});

describe('outbound', () => {
  it("an HTTP Request node sends its span's traceparent and the filtered baggage to the target", async () => {
    const sink = await startHttpSink();
    try {
      const flow = await webhookFlow(owner, [
        node('Fetch', 'core.httpRequest', { method: 'GET', url: `${sink.url}/target` }, [200, 0]),
      ]);
      const executionId = await call(owner, flow, {
        traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01`,
        tracestate: 'congo=t61rcWkgMzE',
        baggage: 'workflow.id=spoof,team=blue',
      });
      const [request] = await sink.waitForRequests(1);
      const fetch = nodeSpan(await spansOf(collector, executionId, 3), 'Fetch')!;
      expect(request.headers.traceparent).toBe(`00-${INBOUND_TRACE}-${fetch.spanId}-01`);
      expect(request.headers.tracestate).toBe('congo=t61rcWkgMzE');
      expect(request.headers.baggage).toBe('team=blue');
    } finally {
      await sink.close();
    }
  });

  it('injectOutbound off sends no trace headers', async () => {
    const quiet = await signup(server.app);
    const target = await startOtlpCollector();
    const sink = await startHttpSink();
    try {
      await enableTracing(server, quiet.tenant.id, { exporterEndpoint: target.url, injectOutbound: false });
      const flow = await webhookFlow(quiet, [
        node('Fetch', 'core.httpRequest', { method: 'GET', url: `${sink.url}/target` }, [200, 0]),
      ]);
      const executionId = await call(quiet, flow, { traceparent: `00-${INBOUND_TRACE}-${INBOUND_SPAN}-01` });
      const [request] = await sink.waitForRequests(1);
      expect(request.headers.traceparent).toBeUndefined();
      expect(request.headers.baggage).toBeUndefined();
      await spansOf(target, executionId, 3);
    } finally {
      await sink.close();
      await target.close();
    }
  });
});

describe('sub-nodes', () => {
  it("a sub-node run is a zero-length child of its parent node's span", async () => {
    const observer = server.ctx.tracingObserver;
    const executionId = randomUUID();
    const definition = {
      name: 'Agent flow',
      nodes: [node('Agent', 'test.agent'), node('Model', 'test.model')],
      connections: { Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } },
      settings: {},
    } as unknown as WorkflowDefinition;
    const scope: RunScope = {
      tenantId: owner.tenant.id,
      executionId,
      row: {
        mode: 'webhook',
        workflowId: null,
        parentExecutionId: null,
        retryOf: null,
        startedAt: new Date(),
        stoppedAt: null,
      },
      definition,
      options: {},
      kind: 'run',
    };
    const task = (extra: Partial<TaskData>): TaskData => ({
      startTime: Date.now(),
      executionTime: 0,
      executionStatus: 'success',
      source: [],
      ...extra,
    });
    const redaction = { production: false, manual: false };
    await observer.runStart?.(scope);
    await observer.nodeStart?.({ ...scope, nodeName: 'Agent', nodeType: 'test.agent', runIndex: 0 });
    // the parent node's outbound headers come from its open span
    expect(observer.headersFor(executionId, 'Agent')?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    // a sub-node's own request carries its parent node's span
    expect(observer.headersFor(executionId, 'Model')).toEqual(observer.headersFor(executionId, 'Agent'));
    await observer.nodeEnd?.({
      ...scope,
      nodeName: 'Model',
      nodeType: 'test.model',
      runIndex: 0,
      taskData: task({
        inputOverride: { ai_languageModel: [[{ json: {} }]] },
        data: { ai_languageModel: [[{ json: {} }]] },
        source: [{ previousNode: 'Agent' }],
      }),
      redaction,
      redacted: false,
    });
    await observer.nodeEnd?.({
      ...scope,
      nodeName: 'Agent',
      nodeType: 'test.agent',
      runIndex: 0,
      taskData: task({ data: { main: [[{ json: {} }, { json: {} }]] } }),
      redaction,
      redacted: false,
    });
    await observer.runEnd?.({ ...scope, status: 'success', redaction, redacted: false });
    expect(observer.headersFor(executionId, 'Agent')).toBeUndefined();
    const spans = await spansOf(collector, executionId, 3);
    const agent = nodeSpan(spans, 'Agent')!;
    const model = nodeSpan(spans, 'Model')!;
    expect(model.parentSpanId).toBe(agent.spanId);
    expect(model.endTimeUnixNano).toBe(model.startTimeUnixNano);
    expect(Number(model.attributes['node.items.input'])).toBe(1);
    expect(Number(model.attributes['node.items.output'])).toBe(1);
    expect(Number(agent.attributes['node.items.output'])).toBe(2);
  });
});
