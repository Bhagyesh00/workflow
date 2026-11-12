/**
 * P6 S5 (C0d): the run path wiring of commit 0. With every C0 stub passing, a run, a wait and its resume, a failed
 * run, a crash through `markCrashed`, a stop, a Code node, a poll, a form, a webhook and a delete answer as
 * before; a test observer added to `ctx.observers` sees `runStart`, `nodeStart` and `nodeEnd` per node, then
 * `runEnd` (after the status write), a resume, a crash and a cancel; an audit row reaches the listener, also
 * when written inside a transaction; the delete writes `execution.deleted`; a production webhook's
 * `traceparent` lands in the run's stored options and an over-long `baggage` is dropped; the webhook, form and
 * poll metrics are called with the registered path. Fixed fake header values only, never printed.
 */
import { randomUUID } from 'node:crypto';
import type { WorkflowNode } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type AuditEntry, addAuditListener, createRepositories } from '../src/repositories';
import { type StoredRunOptions, TRACE_HEADER_LIMITS, traceContextOf } from '../src/services/executions';
import type { LifecycleObserver } from '../src/services/observability/lifecycle';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  outputOf,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;
let owner: Awaited<ReturnType<typeof signup>>;

interface Seen {
  hook: string;
  executionId: string;
  kind?: string;
  nodeName?: string;
  nodeType?: string;
  status?: string;
  /** the row's status when `runEnd` ran: the status write comes first */
  rowStatus?: string;
  detector?: string;
  redacted?: boolean;
  hasDefinition?: boolean;
}

const seen: Seen[] = [];
const recorder: LifecycleObserver = {
  runStart: (c) => {
    seen.push({ hook: 'runStart', executionId: c.executionId, kind: c.kind });
  },
  nodeStart: (c) => {
    seen.push({ hook: 'nodeStart', executionId: c.executionId, nodeName: c.nodeName, nodeType: c.nodeType });
  },
  nodeEnd: (c) => {
    seen.push({ hook: 'nodeEnd', executionId: c.executionId, nodeName: c.nodeName, redacted: c.redacted });
  },
  runEnd: async (c) => {
    const row = await server.ctx.repos.executions.get(c.tenantId, c.executionId);
    seen.push({
      hook: 'runEnd',
      executionId: c.executionId,
      status: c.status,
      rowStatus: row?.status ?? 'deleted',
      redacted: c.redacted,
    });
  },
  runCancelled: (c) => {
    seen.push({ hook: 'runCancelled', executionId: c.executionId, hasDefinition: Boolean(c.definition) });
  },
  crash: (c) => {
    seen.push({ hook: 'crash', executionId: c.executionId, detector: c.detector });
  },
};

const seenOf = (executionId: string) => seen.filter((s) => s.executionId === executionId);
const hooksOf = (executionId: string) =>
  seenOf(executionId).map((s) => (s.nodeName ? `${s.hook}:${s.nodeName}` : s.hook));
const ended = (executionId: string, status: string) =>
  waitFor(
    () => Promise.resolve(seenOf(executionId).find((s) => s.hook === 'runEnd' && s.status === status)),
    {
      message: `runEnd ${status}`,
    },
  );

beforeAll(async () => {
  server = await createTestServer();
  server.ctx.observers.add(recorder);
  owner = await signup(server.app);
});
afterAll(async () => {
  server?.ctx.observers.remove(recorder);
  vi.restoreAllMocks();
  await server?.close();
});

async function manualRun(nodes: WorkflowNode[], connections: unknown) {
  const workflow = await createWorkflow(owner.client, { nodes, connections });
  const { executionId } = await owner.client.data<{ executionId: string }>(
    owner.client.post(`/rest/workflows/${workflow.id}/run`, {}),
  );
  return { workflowId: workflow.id, executionId };
}

async function active(nodes: WorkflowNode[], connections: unknown) {
  const workflow = await createWorkflow(owner.client, { nodes, connections });
  await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/activate`));
  return workflow;
}

async function latestRun(workflowId: string) {
  return waitFor(
    async () => (await server.ctx.repos.executions.list(owner.tenant.id, { workflowId, limit: 1 }))[0],
    { message: 'the run to start' },
  );
}

describe('run lifecycle observers', () => {
  it('a run: runStart, nodeStart and nodeEnd per node, then runEnd after the status write', async () => {
    const { executionId } = await manualRun(
      [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
      chain('Start', 'Mark'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    await ended(executionId, 'success');
    expect(hooksOf(executionId)).toEqual([
      'runStart',
      'nodeStart:Start',
      'nodeEnd:Start',
      'nodeStart:Mark',
      'nodeEnd:Mark',
      'runEnd',
    ]);
    const all = seenOf(executionId);
    expect(all[0].kind).toBe('run');
    expect(all.find((s) => s.nodeName === 'Mark' && s.hook === 'nodeStart')?.nodeType).toBe('core.set');
    expect(all.find((s) => s.nodeName === 'Mark' && s.hook === 'nodeEnd')?.redacted).toBe(false);
    expect(all.at(-1)).toMatchObject({ status: 'success', rowStatus: 'success', redacted: false });
  });

  it('a wait ends with runEnd waiting; its resume starts with kind resume and ends with success', async () => {
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'test.wait', {}, [200, 0]),
        setNode('After', 'done', 'yes', [400, 0]),
      ],
      chain('Start', 'Wait', 'After'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['waiting']);
    expect(await ended(executionId, 'waiting')).toMatchObject({ rowStatus: 'waiting' });
    const resumePath = new URL(server.ctx.executions.resumeUrl(executionId)).pathname;
    const res = await server.app.inject({ method: 'POST', url: resumePath, payload: { approved: true } });
    expect(res.statusCode).toBe(200);
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    await ended(executionId, 'success');
    const starts = seenOf(executionId).filter((s) => s.hook === 'runStart');
    expect(starts.map((s) => s.kind)).toEqual(['run', 'resume']);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, executionId);
    expect(outputOf(data?.state, 'After')).toEqual([{ approved: true, done: 'yes' }]);
  });

  it('a failed run ends with runEnd error, after the status write', async () => {
    const { executionId } = await manualRun(
      [node('Start', 'core.manualTrigger'), node('Boom', 'test.fail', { message: 'boom' }, [200, 0])],
      chain('Start', 'Boom'),
    );
    const row = await waitForExecution(server.ctx, owner.tenant.id, executionId, ['error']);
    expect(row.errorMessage).toBe('boom');
    expect(await ended(executionId, 'error')).toMatchObject({ rowStatus: 'error' });
    expect(hooksOf(executionId).at(0)).toBe('runStart');
  });

  it('a crash through markCrashed reaches crash with detector startup', async () => {
    const id = randomUUID();
    const workflow = await createWorkflow(owner.client, {
      nodes: [node('Start', 'core.manualTrigger')],
    });
    await server.ctx.repos.executions.create(
      owner.tenant.id,
      {
        id,
        workflowId: workflow.id,
        mode: 'webhook',
        status: 'running',
        workflowName: 'Crashy',
        startedAt: new Date(),
      } as never,
      { workflowData: { name: 'Crashy', nodes: [], connections: {}, settings: {} }, runOptions: {} },
    );
    expect(await server.ctx.executions.markCrashed()).toBeGreaterThanOrEqual(1);
    expect((await server.ctx.repos.executions.get(owner.tenant.id, id))?.status).toBe('crashed');
    expect(seenOf(id)).toEqual([{ hook: 'crash', executionId: id, detector: 'startup' }]);
  });

  it('a stop of a waiting run cancels it and reaches runCancelled', async () => {
    const { executionId } = await manualRun(
      [node('Start', 'core.manualTrigger'), node('Wait', 'test.wait', {}, [200, 0])],
      chain('Start', 'Wait'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['waiting']);
    expect(await owner.client.data(owner.client.post(`/rest/executions/${executionId}/stop`))).toEqual({
      status: 'canceled',
    });
    expect(seenOf(executionId).filter((s) => s.hook === 'runCancelled')).toEqual([
      { hook: 'runCancelled', executionId, hasDefinition: true },
    ]);
  });

  it('a Code node runs through the observed runner', async () => {
    const { executionId } = await manualRun(
      [
        node('Start', 'core.manualTrigger'),
        node(
          'Code',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: 'return [{ json: { n: 21 * 2 } }]' },
          [200, 0],
        ),
      ],
      chain('Start', 'Code'),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, executionId);
    expect(outputOf(data?.state, 'Code')).toEqual([{ n: 42 }]);
    await ended(executionId, 'success');
  });
});

describe('triggers, webhooks and forms', () => {
  it('a poll runs and is counted with recordPoll', async () => {
    const recordPoll = vi.spyOn(server.ctx.metrics, 'recordPoll');
    const workflow = await active(
      [node('Poller', 'test.poll', { pollTimes: { item: [{ mode: 'everyHour', minute: 59 }] } })],
      {},
    );
    const run = await latestRun(workflow.id);
    expect((await waitForExecution(server.ctx, owner.tenant.id, run.id)).status).toBe('success');
    await waitFor(() => Promise.resolve(recordPoll.mock.calls.find((c) => c[0] === 'test.poll')), {
      message: 'recordPoll',
    });
    const call = recordPoll.mock.calls.find((c) => c[0] === 'test.poll')!;
    expect(call[1]).toBe(true);
    expect(typeof call[2]).toBe('number');
    await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/deactivate`));
  });

  it('a form POST runs and is counted with observeForm and its registered path', async () => {
    const observeForm = vi.spyOn(server.ctx.metrics, 'observeForm');
    const path = `f-${randomUUID().slice(0, 8)}`;
    const workflow = await active(
      [
        node('Start', 'core.formTrigger', {
          formTitle: 'Sign up',
          path,
          formFields: { values: [{ fieldLabel: 'Name', fieldType: 'text' }] },
        }),
        setNode('Mark', 'done', 'yes'),
      ],
      chain('Start', 'Mark'),
    );
    const boundary = 'F0RMB0UNDARY';
    const res = await server.app.inject({
      method: 'POST',
      url: `/form/${owner.tenant.slug}/${path}`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="field-0"',
        '',
        'Ann',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    });
    expect(res.statusCode).toBe(200);
    const run = await latestRun(workflow.id);
    expect((await waitForExecution(server.ctx, owner.tenant.id, run.id)).status).toBe('success');
    const call = observeForm.mock.calls.find((c) => c[0].workflowId === workflow.id);
    expect(call?.[0]).toMatchObject({ statusCode: 200, formPath: path, workflowId: workflow.id });
    expect(typeof call?.[0].ms).toBe('number');
  });

  it("a webhook's traceparent lands in the run's stored options; an over-long baggage is dropped", async () => {
    const observeWebhook = vi.spyOn(server.ctx.metrics, 'observeWebhook');
    const path = `w-${randomUUID().slice(0, 8)}`;
    const workflow = await active(
      [
        node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() }),
        setNode('Done', 'ok', 'yes'),
      ],
      chain('Hook', 'Done'),
    );
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    expect(traceparent).toHaveLength(TRACE_HEADER_LIMITS.traceparent);
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/${path}`,
      headers: { traceparent, tracestate: 'congo=t61rcWkgMzE', baggage: 'k='.padEnd(8193, 'v') },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const run = await latestRun(workflow.id);
    await waitForExecution(server.ctx, owner.tenant.id, run.id, ['success']);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, run.id);
    const stored = (data?.runOptions ?? {}) as StoredRunOptions;
    expect(stored.traceContext).toEqual({ traceparent, tracestate: 'congo=t61rcWkgMzE' });
    const call = observeWebhook.mock.calls.find((c) => c[0].workflowId === workflow.id);
    expect(call?.[0]).toMatchObject({ method: 'POST', statusCode: 200, webhookPath: path });
  });

  it('a webhook without trace headers stores no trace context', async () => {
    const path = `w-${randomUUID().slice(0, 8)}`;
    const workflow = await active(
      [node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() })],
      {},
    );
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/${path}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const run = await latestRun(workflow.id);
    await waitForExecution(server.ctx, owner.tenant.id, run.id, ['success']);
    const data = await server.ctx.repos.executions.getData(owner.tenant.id, run.id);
    expect(((data?.runOptions ?? {}) as StoredRunOptions).traceContext).toBeUndefined();
  });

  it('traceContextOf keeps values up to each limit and drops longer ones', () => {
    const at = (n: number) => 'a'.repeat(n);
    expect(
      traceContextOf({ traceparent: at(55), tracestate: at(512), baggage: at(8192), other: 'x' }),
    ).toEqual({ traceparent: at(55), tracestate: at(512), baggage: at(8192) });
    expect(traceContextOf({ traceparent: at(56), tracestate: at(513), baggage: at(8193) })).toBeUndefined();
    expect(traceContextOf({ traceparent: [at(10), at(11)] })).toEqual({ traceparent: at(10) });
    expect(traceContextOf({})).toBeUndefined();
    expect(traceContextOf(undefined)).toBeUndefined();
  });
});

describe('delete and audit', () => {
  it('a delete answers as before and writes execution.deleted with the id and no data', async () => {
    const got: Array<{ tenantId: string; entry: AuditEntry }> = [];
    const remove = addAuditListener((tenantId, entry) => got.push({ tenantId, entry }));
    try {
      const { executionId } = await manualRun(
        [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
        chain('Start', 'Mark'),
      );
      await waitForExecution(server.ctx, owner.tenant.id, executionId, ['success']);
      expect(await owner.client.data(owner.client.delete(`/rest/executions/${executionId}`))).toEqual({
        ok: true,
      });
      expect((await owner.client.get(`/rest/executions/${executionId}`)).statusCode).toBe(404);
      const rows = await server.ctx.repos.audit.list(owner.tenant.id, 50);
      const row = rows.find((r) => r.action === 'execution.deleted' && r.resourceId === executionId);
      expect(row).toMatchObject({
        userId: owner.user.id,
        resourceType: 'execution',
        resourceId: executionId,
      });
      expect(row?.metadata ?? {}).toEqual({});
      const heard = got.find((g) => g.entry.action === 'execution.deleted');
      expect(heard?.tenantId).toBe(owner.tenant.id);
      expect(heard?.entry).toMatchObject({ userId: owner.user.id, resourceId: executionId });
    } finally {
      remove();
    }
  });

  it('an audit row reaches the listener, also when written inside a transaction', async () => {
    const got: string[] = [];
    const remove = addAuditListener((_tenantId, entry) => got.push(entry.action));
    try {
      await server.ctx.repos.audit.add(owner.tenant.id, { action: 'p6s5.wiring.plain' });
      await server.ctx.database.db.transaction(async (tx) => {
        await createRepositories(tx).audit.add(owner.tenant.id, { action: 'p6s5.wiring.tx' });
      });
      expect(got).toEqual(['p6s5.wiring.plain', 'p6s5.wiring.tx']);
    } finally {
      remove();
    }
  });
});
