/**
 * P6-66 (S5 L10): run and node spans. A tenant with tracing on sends one `workflow.execute` span per run segment and
 * one `node.execute` child per node run to its own collector (L9's in-process OTLP fake), with n8n's attributes
 * less `n8n.`, the execution identity on every span, ERROR and an exception event without a stack on failure, a
 * sub-workflow and an error workflow in the caller's trace, a resume that continues the trace from the stored
 * context after the process map is cleared, a reconstructed span for a crash, and no run text for a redacted
 * run. Fixed fake values only; nothing captured is printed.
 */
import { randomUUID } from 'node:crypto';
import type { TaskData, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CrashContext, RunScope } from '../src/services/observability/lifecycle';
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

// L11 fills the custom attributes; here they are a fixed stand-in, so the test sees what the observer passes in
vi.mock('../src/services/tracing/custom-attributes', () => ({
  customAttributes: (input: {
    project?: { tags: Array<{ key: string; value: string }> };
    workflow?: { tags: Array<{ key: string; value: string }> };
    node?: { tracing?: Record<string, unknown> };
  }) => {
    const out: Record<string, string> = {};
    for (const tag of input.project?.tags ?? []) out[`project.custom.${tag.key}`] = tag.value;
    for (const tag of input.workflow?.tags ?? []) out[`workflow.custom.${tag.key}`] = tag.value;
    for (const [key, value] of Object.entries(input.node?.tracing ?? {}))
      out[`node.custom.${key}`] = String(value);
    return out;
  },
}));

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;
let collector: OtlpCollector;

type Span = ReturnType<OtlpCollector['spans']>[number];

const num = (value: unknown) => Number(value);

/** the spans of one execution, once at least `min` arrived (flushing the processors while waiting) */
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

/** no span of the execution arrives (the run has ended; its observers had time to run) */
async function noSpansOf(target: OtlpCollector, executionId: string) {
  await new Promise((r) => setTimeout(r, 400));
  await server.ctx.tracing.flush();
  expect(target.spans().filter((s) => s.attributes['execution.id'] === executionId)).toEqual([]);
}

const named = (spans: Span[], name: string) => spans.filter((s) => s.name === name);
const nodeSpan = (spans: Span[], nodeName: string) =>
  spans.find((s) => s.name === 'node.execute' && s.attributes['node.name'] === nodeName);

const noRedaction = { production: false, manual: false };

/** a run driven straight through the observer (a trigger run of one Set node), optionally a sub-workflow */
function directRun(parentExecutionId: string | null = null) {
  const definition = {
    name: 'Direct',
    nodes: [node('Slow', 'core.set')],
    connections: {},
    settings: {},
  } as WorkflowDefinition;
  const scope: RunScope = {
    tenantId: owner.tenant.id,
    executionId: randomUUID(),
    row: {
      mode: 'trigger',
      workflowId: null,
      parentExecutionId,
      retryOf: null,
      startedAt: new Date(),
      stoppedAt: null,
    },
    definition,
    options: {},
    kind: 'run',
  };
  return { scope };
}

async function manualRun(nodes: WorkflowNode[], connections: unknown, settings?: Record<string, unknown>) {
  const workflow = await createWorkflow(owner.client, { nodes, connections, settings });
  const { executionId } = await owner.client.data<{ executionId: string }>(
    owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
  );
  return { workflowId: workflow.id, executionId };
}

async function activeWebhook(path: string, nodes: WorkflowNode[], settings?: Record<string, unknown>) {
  const all = [
    node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() }),
    ...nodes,
  ];
  const workflow = await createWorkflow(owner.client, {
    nodes: all,
    connections: chain(...all.map((n) => n.name)),
    settings,
  });
  await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/activate`));
  return workflow;
}

async function latestRun(tenantId: string, workflowId: string) {
  return waitFor(
    async () => (await server.ctx.repos.executions.list(tenantId, { workflowId, limit: 1 }))[0],
    { message: 'the run to start' },
  );
}

beforeAll(async () => {
  server = await createTestServer();
  owner = await signup(server.app);
  collector = await startOtlpCollector();
  await enableTracing(server, owner.tenant.id, {
    exporterEndpoint: collector.url,
    productionExecutionsOnly: false,
  });
});
afterAll(async () => {
  await server?.close();
  await collector?.close();
});

describe('workflow and node spans', () => {
  it('a 3-node run sends one workflow.execute and three node.execute children', async () => {
    const { workflowId, executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        setNode('First', 'a', 'x'),
        setNode('Second', 'b', 'y', [400, 0]),
      ],
      chain('Start', 'First', 'Second'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const spans = await spansOf(collector, executionId, 4);
    const [run] = named(spans, 'workflow.execute');
    expect(named(spans, 'workflow.execute')).toHaveLength(1);
    expect(named(spans, 'node.execute')).toHaveLength(3);
    expect(run.parentSpanId).toBe('');
    expect(run.kind).toBe(1);
    // OK (1): n8n gives OK to every end but an error or a crash
    expect(run.status.code).toBe(1);
    expect(run.attributes).toMatchObject({
      'workflow.id': workflowId,
      'workflow.name': 'Test workflow',
      'project.id': owner.client.defaultProjectId,
      'execution.id': executionId,
      'execution.mode': 'manual',
      'execution.status': 'success',
      'execution.is_retry': false,
    });
    expect(typeof run.attributes['project.name']).toBe('string');
    expect(num(run.attributes['workflow.node_count'])).toBe(3);
    expect(run.attributes['execution.error_type']).toBeUndefined();
    for (const child of named(spans, 'node.execute')) {
      expect(child.traceId).toBe(run.traceId);
      expect(child.parentSpanId).toBe(run.spanId);
      expect(child.attributes).toMatchObject({
        'execution.id': executionId,
        'workflow.id': workflowId,
        'project.id': owner.client.defaultProjectId,
      });
      expect(child.endTimeUnixNano >= child.startTimeUnixNano).toBe(true);
      expect(child.startTimeUnixNano >= run.startTimeUnixNano).toBe(true);
    }
    const start = nodeSpan(spans, 'Start')!;
    expect(start.attributes).toMatchObject({ 'node.name': 'Start', 'node.type': 'core.manualTrigger' });
    expect(num(start.attributes['node.type_version'])).toBe(1);
    expect(typeof start.attributes['node.id']).toBe('string');
    expect(num(start.attributes['node.items.input'])).toBe(0);
    expect(num(start.attributes['node.items.output'])).toBe(1);
    const second = nodeSpan(spans, 'Second')!;
    expect(second.attributes['node.type']).toBe('core.set');
    expect(num(second.attributes['node.items.input'])).toBe(1);
    expect(num(second.attributes['node.items.output'])).toBe(1);
    // resource attributes come from L9's exporter; no tenant id
    expect(run.resource['service.name']).toBe('workflow');
    expect(run.resource['tenant.id']).toBeUndefined();
  });

  it('a failure has status ERROR and an exception event with type and message, no stack', async () => {
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        node('Boom', 'test.fail', { message: 'boom happened' }, [200, 0]),
      ],
      chain('Start', 'Boom'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    const spans = await spansOf(collector, executionId, 3);
    const [run] = named(spans, 'workflow.execute');
    expect(run.status.code).toBe(2);
    expect(run.attributes['execution.status']).toBe('error');
    expect(typeof run.attributes['execution.error_type']).toBe('string');
    const exception = run.events.find((e) => e.name === 'exception');
    expect(exception?.attributes['exception.message']).toBe('boom happened');
    expect(typeof exception?.attributes['exception.type']).toBe('string');
    const boom = nodeSpan(spans, 'Boom')!;
    expect(boom.status.code).toBe(2);
    expect(boom.events.find((e) => e.name === 'exception')?.attributes['exception.message']).toBe(
      'boom happened',
    );
    for (const span of spans) {
      for (const event of span.events) expect(event.attributes['exception.stacktrace']).toBeUndefined();
      expect(JSON.stringify(span, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(
        /\bat .+:\d+:\d+/,
      );
    }
  });

  it('a sub-workflow shares the trace, its Execute Workflow node span is the parent', async () => {
    const inner = JSON.stringify({
      name: 'Inner',
      nodes: [node('Called', 'core.executeWorkflowTrigger'), setNode('Inside', 'in', 'yes')],
      connections: chain('Called', 'Inside'),
    });
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        node('Sub', 'core.executeWorkflow', { source: 'parameter', workflowJson: inner }, [200, 0]),
      ],
      chain('Start', 'Sub'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const parentSpans = await spansOf(collector, executionId, 3);
    const sub = nodeSpan(parentSpans, 'Sub')!;
    const childRow = await waitFor(
      async () =>
        (await server.ctx.repos.executions.list(owner.tenant.id, { limit: 20 })).find(
          (r) => r.parentExecutionId === executionId,
        ),
      { message: 'the sub-workflow run' },
    );
    const childSpans = await spansOf(collector, childRow.id, 3);
    const [child] = named(childSpans, 'workflow.execute');
    expect(child.traceId).toBe(sub.traceId);
    expect(child.parentSpanId).toBe(sub.spanId);
    expect(child.attributes['execution.mode']).toBe('integrated');
    expect(nodeSpan(childSpans, 'Inside')?.parentSpanId).toBe(child.spanId);
    // the stored context keeps the segment's parent, so a crash rebuilt elsewhere stays under it
    const stored = (await server.ctx.repos.executions.tracingContextOf(owner.tenant.id, childRow.id)) as {
      parentSpanId?: string;
    } | null;
    expect(stored?.parentSpanId).toBe(sub.spanId);
  });

  it("a failing run's error workflow is in the same trace, the failed run's workflow span its parent", async () => {
    const handler = await createWorkflow(owner.client, {
      name: 'Handler',
      nodes: [node('Error Trigger', 'core.errorTrigger'), setNode('Seen', 'seen', 'yes')],
      connections: chain('Error Trigger', 'Seen'),
    });
    const path = `e-${randomUUID().slice(0, 8)}`;
    const failing = await activeWebhook(path, [node('Boom', 'test.fail', { message: 'boom' }, [200, 0])], {
      errorWorkflow: handler.id,
    });
    const res = await server.app.inject({ method: 'POST', url: `/webhook/${owner.tenant.slug}/${path}` });
    expect(res.statusCode).toBe(200);
    const failed = await latestRun(owner.tenant.id, failing.id);
    await waitForExecution(server.ctx, owner.tenant.id, failed.id, ['error']);
    const handled = await latestRun(owner.tenant.id, handler.id);
    await waitForExecution(server.ctx, owner.tenant.id, handled.id, ['success']);
    const [failedRun] = named(await spansOf(collector, failed.id, 3), 'workflow.execute');
    const [errorRun] = named(await spansOf(collector, handled.id, 3), 'workflow.execute');
    expect(failedRun.status.code).toBe(2);
    expect(errorRun.traceId).toBe(failedRun.traceId);
    expect(errorRun.parentSpanId).toBe(failedRun.spanId);
    expect(errorRun.attributes['execution.mode']).toBe('error');
  });

  it('a wait then resume continues the trace after the process map is cleared', async () => {
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        setNode('After', 'done', 'yes', [400, 0]),
      ],
      chain('Start', 'Wait', 'After'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['waiting']);
    const first = await waitFor(
      async () => {
        await server.ctx.tracing.flush();
        return collector
          .spans()
          .find(
            (s) =>
              s.name === 'workflow.execute' &&
              s.attributes['execution.id'] === executionId &&
              s.attributes['execution.status'] === 'waiting',
          );
      },
      { message: 'the first segment' },
    );
    const stored = await server.ctx.repos.executions.tracingContextOf(owner.tenant.id, executionId);
    expect(stored?.traceparent).toBe(`00-${first.traceId}-${first.spanId}-01`);
    expect(stored?.identity['execution.id']).toBe(executionId);
    // a restart: this process forgets every open run
    server.ctx.tracingObserver.forget();
    const resumePath = new URL(server.ctx.executions.resumeUrl(executionId)).pathname;
    const res = await server.app.inject({ method: 'POST', url: resumePath, payload: { approved: true } });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const second = await waitFor(
      async () => {
        await server.ctx.tracing.flush();
        return collector
          .spans()
          .find(
            (s) =>
              s.name === 'workflow.execute' &&
              s.attributes['execution.id'] === executionId &&
              s.attributes['execution.status'] === 'success',
          );
      },
      { message: 'the resumed segment' },
    );
    expect(second.traceId).toBe(first.traceId);
    expect(second.spanId).not.toBe(first.spanId);
    expect(second.links.map((l) => l.spanId)).toContain(first.spanId);
    // the reason is on the link, as n8n
    expect(second.links.find((l) => l.spanId === first.spanId)?.attributes['continuation.reason']).toBe(
      'resume',
    );
    expect(second.attributes['continuation.reason']).toBe('resume');
    const after = nodeSpan(await spansOf(collector, executionId, 5), 'After')!;
    expect(after.parentSpanId).toBe(second.spanId);
  });
});

describe('who is traced', () => {
  it('production only skips a manual run, never a production one', async () => {
    const other = await signup(server.app);
    const target = await startOtlpCollector();
    try {
      await enableTracing(server, other.tenant.id, { exporterEndpoint: target.url });
      const workflow = await createWorkflow(other.client, {
        nodes: [node('Start', 'core.manualTrigger'), setNode('Mark', 'm', 'x')],
        connections: chain('Start', 'Mark'),
      });
      const { executionId } = await other.client.data<{ executionId: string }>(
        other.client.post(`/rest/workflows/${workflow.id}/run`, {}),
      );
      await waitForExecution(server.ctx, other.tenant.id, executionId, ['success']);
      await noSpansOf(target, executionId);
      // the same workspace's production run is traced
      const path = `p-${randomUUID().slice(0, 8)}`;
      const hook = await createWorkflow(other.client, {
        nodes: [
          node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() }),
        ],
      });
      await other.client.data(other.client.post(`/rest/workflows/${hook.id}/activate`));
      expect(
        (await server.app.inject({ method: 'POST', url: `/webhook/${other.tenant.slug}/${path}` }))
          .statusCode,
      ).toBe(200);
      const run = await latestRun(other.tenant.id, hook.id);
      await waitForExecution(server.ctx, other.tenant.id, run.id, ['success']);
      const [span] = named(await spansOf(target, run.id, 2), 'workflow.execute');
      expect(span.attributes['execution.mode']).toBe('webhook');
    } finally {
      await target.close();
    }
  });

  it("tenant B's collector gets none of tenant A's spans", async () => {
    const b = await signup(server.app);
    const collectorB = await startOtlpCollector();
    try {
      await enableTracing(server, b.tenant.id, {
        exporterEndpoint: collectorB.url,
        productionExecutionsOnly: false,
      });
      const { executionId } = await manualRun(
        [node('Start', 'core.manualTrigger'), setNode('Only A', 'a', 'x')],
        chain('Start', 'Only A'),
      );
      await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
      await spansOf(collector, executionId, 3);
      const workflowB = await createWorkflow(b.client, {
        nodes: [node('Start', 'core.manualTrigger')],
      });
      const { executionId: runB } = await b.client.data<{ executionId: string }>(
        b.client.post(`/rest/workflows/${workflowB.id}/run`, {}),
      );
      await waitForExecution(server.ctx, b.tenant.id, runB, ['success']);
      await spansOf(collectorB, runB, 2);
      expect(collectorB.spans().filter((s) => s.attributes['execution.id'] === executionId)).toEqual([]);
      expect(collectorB.spans().every((s) => s.attributes['execution.id'] === runB)).toBe(true);
      expect(collector.spans().filter((s) => s.attributes['execution.id'] === runB)).toEqual([]);
    } finally {
      await collectorB.close();
    }
  });

  it('a workspace without tracing stores no trace context and sends nothing', async () => {
    const plain = await signup(server.app);
    const workflow = await createWorkflow(plain.client, {
      nodes: [node('Start', 'core.manualTrigger')],
    });
    const { executionId } = await plain.client.data<{ executionId: string }>(
      plain.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, plain.tenant.id, executionId, ['success']);
    await noSpansOf(collector, executionId);
    expect(await server.ctx.repos.executions.tracingContextOf(plain.tenant.id, executionId)).toBeNull();
  });
});

describe('crash', () => {
  async function runningRow(storedContext?: { traceparent: string; parentSpanId?: string }) {
    const workflow = await createWorkflow(owner.client, { nodes: [node('Start', 'core.manualTrigger')] });
    const id = randomUUID();
    const startedAt = new Date(Date.now() - 5000);
    await server.ctx.repos.executions.create(
      owner.tenant.id,
      { id, workflowId: workflow.id, workflowName: 'Crashy', mode: 'trigger', status: 'running', startedAt },
      {
        workflowData: { id: workflow.id, name: 'Crashy', nodes: [], connections: {}, settings: {} },
        runOptions: {},
      },
    );
    if (storedContext) {
      await server.ctx.repos.executions.setTracingContext(owner.tenant.id, id, {
        ...storedContext,
        identity: { 'execution.id': id },
      });
    }
    return { id, startedAt, workflowId: workflow.id };
  }

  it('markCrashed gives a reconstructed span from the stored start and stop', async () => {
    const { id, startedAt, workflowId } = await runningRow();
    await server.ctx.executions.markCrashed();
    const row = await waitForExecution(server.ctx, owner.tenant.id, id, ['crashed']);
    const [span] = await spansOf(collector, id, 1);
    expect(span.name).toBe('workflow.execute');
    expect(span.status.code).toBe(2);
    expect(span.attributes).toMatchObject({
      'execution.reconstructed': true,
      'execution.crash.detector': 'startup',
      'execution.status': 'crashed',
      'execution.mode': 'trigger',
      'workflow.id': workflowId,
    });
    expect(Number(span.startTimeUnixNano / 1_000_000n)).toBe(startedAt.getTime());
    expect(Number(span.endTimeUnixNano / 1_000_000n)).toBe(row.stoppedAt!.getTime());
  });

  it('a crash of a run with a stored context closes that span id in its trace', async () => {
    const traceId = `${'a'.repeat(31)}1`;
    const spanId = `${'b'.repeat(15)}2`;
    const { id } = await runningRow({ traceparent: `00-${traceId}-${spanId}-01` });
    await server.ctx.executions.markCrashed();
    await waitForExecution(server.ctx, owner.tenant.id, id, ['crashed']);
    const [span] = await spansOf(collector, id, 1);
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toBe(spanId);
    expect(span.parentSpanId).toBe('');
    expect(span.attributes['execution.reconstructed']).toBe(true);
  });

  it("a crash rebuilt from a stored context keeps that segment's parent", async () => {
    const traceId = `${'c'.repeat(31)}1`;
    const spanId = `${'d'.repeat(15)}2`;
    const parentSpanId = `${'e'.repeat(15)}3`;
    const { id } = await runningRow({ traceparent: `00-${traceId}-${spanId}-01`, parentSpanId });
    await server.ctx.executions.markCrashed();
    await waitForExecution(server.ctx, owner.tenant.id, id, ['crashed']);
    const [span] = await spansOf(collector, id, 1);
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toBe(spanId);
    expect(span.parentSpanId).toBe(parentSpanId);
  });

  it('an in-process crash ends the open node spans with ERROR', async () => {
    const { scope } = directRun();
    const observer = server.ctx.tracingObserver;
    await observer.runStart?.(scope);
    await observer.nodeStart?.({ ...scope, nodeName: 'Slow', nodeType: 'core.set', runIndex: 0 });
    await observer.crash?.({
      tenantId: scope.tenantId,
      executionId: scope.executionId,
      row: scope.row,
      detector: 'persist',
      error: 'Could not store the execution result: lost',
      definition: scope.definition,
      options: {},
    });
    const spans = await spansOf(collector, scope.executionId, 2);
    const [run] = named(spans, 'workflow.execute');
    expect(run.status.code).toBe(2);
    const slow = nodeSpan(spans, 'Slow')!;
    expect(slow.status.code).toBe(2);
    expect(slow.attributes['node.termination_reason']).toBe('crashed');
  });

  it("an in-process crash keeps the message out when a sub-workflow raised the run's redaction", async () => {
    const secret = `secret-crash-${randomUUID()}`;
    const { scope } = directRun();
    const observer = server.ctx.tracingObserver;
    await observer.runStart?.(scope);
    const state = {
      resultData: {
        runData: {
          Sub: [
            {
              startTime: Date.now(),
              executionTime: 1,
              executionStatus: 'success',
              source: [],
              metadata: { subWorkflowRedaction: { production: true, manual: false } },
            },
          ],
        },
      },
    } as unknown as NonNullable<CrashContext['state']>;
    await observer.crash?.({
      tenantId: scope.tenantId,
      executionId: scope.executionId,
      row: scope.row,
      detector: 'persist',
      error: `Could not store the execution result: ${secret}`,
      definition: scope.definition,
      options: {},
      state,
    });
    const [run] = named(await spansOf(collector, scope.executionId, 1), 'workflow.execute');
    expect(run.status.code).toBe(2);
    expect(run.status.message).toBe('');
    const exception = run.events.find((e) => e.name === 'exception');
    expect(typeof exception?.attributes['exception.type']).toBe('string');
    expect(exception?.attributes['exception.message']).toBeUndefined();
    for (const request of collector.requests) expect(request.body.includes(secret)).toBe(false);
  });

  it('crashes of runs from another process keep only the newest ended runs to continue', async () => {
    const observer = server.ctx.tracingObserver;
    const ids = Array.from({ length: 1001 }, () => randomUUID());
    for (const executionId of ids) {
      await observer.crash?.({
        tenantId: owner.tenant.id,
        executionId,
        row: {
          mode: 'trigger',
          workflowId: null,
          parentExecutionId: null,
          retryOf: null,
          startedAt: new Date(),
          stoppedAt: new Date(),
        },
        detector: 'startup',
        error: 'The process stopped',
      });
    }
    const childOf = async (parentExecutionId: string) => {
      const { scope } = directRun(parentExecutionId);
      await observer.runStart?.(scope);
      await observer.runEnd?.({ ...scope, status: 'success', redaction: noRedaction, redacted: false });
      const [run] = named(await spansOf(collector, scope.executionId, 1), 'workflow.execute');
      return run;
    };
    // the oldest was dropped (and has no stored context): a new root
    expect((await childOf(ids[0])).parentSpanId).toBe('');
    // the newest still gives its span as the parent
    expect((await childOf(ids[ids.length - 1])).parentSpanId).not.toBe('');
  }, 120_000);
});

describe('open spans when a run ends', () => {
  it("a canceled run's workflow span is OK and its open node spans ERROR", async () => {
    const { scope } = directRun();
    const observer = server.ctx.tracingObserver;
    await observer.runStart?.(scope);
    await observer.nodeStart?.({ ...scope, nodeName: 'Slow', nodeType: 'core.set', runIndex: 0 });
    await observer.runCancelled?.({
      tenantId: scope.tenantId,
      executionId: scope.executionId,
      row: scope.row,
    });
    const spans = await spansOf(collector, scope.executionId, 2);
    const [run] = named(spans, 'workflow.execute');
    expect(run.attributes['execution.status']).toBe('canceled');
    expect(run.status.code).toBe(1);
    const slow = nodeSpan(spans, 'Slow')!;
    expect(slow.status.code).toBe(2);
    expect(slow.attributes['node.termination_reason']).toBe('canceled');
  });
});

describe('no run text where it must not go', () => {
  it('a seeded secret appears in no decoded attribute, event or status', async () => {
    const canary = `canary-${randomUUID()}`;
    const token = 'Bearer abcdefghijklmnop0123456789';
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        setNode('Seed', 'secret', canary),
        node('Boom', 'test.fail', { message: `failed with ${token}` }, [400, 0]),
      ],
      chain('Start', 'Seed', 'Boom'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    const spans = await spansOf(collector, executionId, 4);
    const text = JSON.stringify(spans, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(text).not.toContain(canary);
    expect(text).not.toContain('abcdefghijklmnop0123456789');
    expect(text).toContain('Bearer [redacted]');
    for (const request of collector.requests) {
      expect(request.body.includes(canary)).toBe(false);
      expect(request.body.includes('abcdefghijklmnop0123456789')).toBe(false);
    }
  });

  it('a redacted failing run has ERROR, no exception message and no message anywhere', async () => {
    const secret = `secret-message-${randomUUID()}`;
    const { executionId } = await manualRun(
      [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', { message: secret }, [200, 0])],
      chain('Start', 'Boom'),
      { redactionPolicy: 'all' },
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    const spans = await spansOf(collector, executionId, 3);
    const [run] = named(spans, 'workflow.execute');
    expect(run.status.code).toBe(2);
    expect(run.status.message).toBe('');
    const exception = run.events.find((e) => e.name === 'exception');
    expect(typeof exception?.attributes['exception.type']).toBe('string');
    expect(exception?.attributes['exception.message']).toBeUndefined();
    const boom = nodeSpan(spans, 'Boom')!;
    expect(boom.status.code).toBe(2);
    expect(boom.events.find((e) => e.name === 'exception')?.attributes['exception.message']).toBeUndefined();
    for (const request of collector.requests) expect(request.body.includes(secret)).toBe(false);
  });

  it('a redacted run leaves node tags out of the node span; an unredacted one keeps them', async () => {
    const observer = server.ctx.tracingObserver;
    const definition: WorkflowDefinition = {
      name: 'Direct',
      nodes: [node('Tagged', 'core.set')],
      connections: {},
      settings: {},
    } as WorkflowDefinition;
    const runOnce = async (redacted: boolean) => {
      const executionId = randomUUID();
      const scope: RunScope = {
        tenantId: owner.tenant.id,
        executionId,
        row: {
          mode: 'trigger',
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
      const taskData: TaskData = {
        startTime: Date.now(),
        executionTime: 1,
        executionStatus: 'success',
        data: { main: [[{ json: {} }]] },
        source: [],
        metadata: { tracing: { team: 'blue' } },
      };
      const redaction = { production: redacted, manual: false };
      await observer.runStart?.(scope);
      await observer.nodeStart?.({ ...scope, nodeName: 'Tagged', nodeType: 'core.set', runIndex: 0 });
      await observer.nodeEnd?.({
        ...scope,
        nodeName: 'Tagged',
        nodeType: 'core.set',
        runIndex: 0,
        taskData,
        redaction,
        redacted,
      });
      await observer.runEnd?.({ ...scope, status: 'success', redaction, redacted });
      return nodeSpan(await spansOf(collector, executionId, 2), 'Tagged')!;
    };
    expect((await runOnce(false)).attributes['node.custom.team']).toBe('blue');
    expect((await runOnce(true)).attributes['node.custom.team']).toBeUndefined();
  });
});
