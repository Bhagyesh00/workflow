/**
 * P6-05 (L11) insights collection: what a finished run adds (n8n's counting rules), the buffer and its
 * flush, the crash paths, and the tenant line. Runs go through real production webhooks; the buffer is
 * flushed by hand (`ctx.insights.flush()`), the 30 s timer is not waited for.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsightsCollector } from '../src/services/insights/collector';
import {
  countingFacts,
  type InsightRun,
  insightRunOf,
  MAX_INSIGHT_BUCKET_VALUE,
  MAX_INSIGHT_RUNTIME_MS,
} from '../src/services/insights/rules';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  teamProjectOf,
  waitFor,
  waitForExecution,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await server.ctx.insights.flush().catch(() => {});
  await resetDatabase(server.ctx);
});

type Owner = Awaited<ReturnType<typeof signup>>;

const FINISHED = ['success', 'error', 'canceled', 'crashed'];

/** a workflow with a production webhook; `last` runs after it */
async function webhookWorkflow(
  owner: Owner,
  name: string,
  last: ReturnType<typeof node> = setNode('Done', 'ok', 'yes'),
  settings: Record<string, unknown> = {},
) {
  const path = `p-${randomUUID().slice(0, 8)}`;
  const workflow = await createWorkflow(owner.client, {
    name,
    nodes: [
      node('Hook', 'core.webhook', { path, httpMethod: 'POST' }, [0, 0], { webhookId: randomUUID() }),
      last,
    ],
    connections: chain('Hook', last.name),
    settings: settings as never,
  });
  await owner.client.data(owner.client.post(`/rest/workflows/${workflow.id}/activate`));
  return { id: workflow.id, path };
}

/** calls the webhook `times` times, one after the other, each until its run has finished */
async function fire(owner: Owner, flow: { id: string; path: string }, times: number) {
  for (let i = 0; i < times; i++) {
    const before = (
      await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: flow.id, limit: 100 })
    ).length;
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/${flow.path}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const row = await waitFor(
      async () =>
        (await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: flow.id, limit: 100 }))
          .length > before
          ? (await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: flow.id, limit: 1 }))[0]
          : undefined,
      { message: 'the run to start' },
    );
    await waitForExecution(server.ctx, owner.tenant.id, row.id, FINISHED);
  }
}

const summary = async (owner: Owner, query = '') =>
  owner.client.data<Record<string, { value: number; unit: string; deviation: number | null }>>(
    owner.client.get(`/rest/insights/summary${query}`),
  );

const periodRows = async (tenantId: string) =>
  (
    await server.ctx.database.pool.query(
      'select type, period_unit, value::int as value from insights_by_period where tenant_id = $1 order by type, period_start',
      [tenantId],
    )
  ).rows as Array<{ type: number; period_unit: number; value: number }>;

/** a finished run of a saved workflow, as `finish` hands it to the collector */
function runOf(tenantId: string, workflowId: string | null, over: Partial<InsightRun> = {}): InsightRun {
  return {
    tenantId,
    workflowId,
    workflowName: 'Flow',
    mode: 'webhook',
    status: 'success',
    startedAt: new Date(),
    runtimeMs: 100,
    settings: {},
    runData: null,
    ...over,
  };
}

describe('counting rules', () => {
  it('counts cli, retry, trigger, webhook, evaluation and error; success and failure only', () => {
    const id = randomUUID();
    const t = randomUUID();
    for (const mode of ['cli', 'retry', 'trigger', 'webhook', 'evaluation', 'error'] as const) {
      expect(
        countingFacts(runOf(t, id, { mode })).map((f) => f.type),
        mode,
      ).toEqual(['success', 'runtime_ms']);
    }
    for (const status of ['error', 'crashed'] as const) {
      expect(countingFacts(runOf(t, id, { status })).map((f) => f.type)).toEqual(['failure', 'runtime_ms']);
    }
    // a run that failed before its first node
    expect(countingFacts(runOf(t, id, { status: 'blocked' as never })).map((f) => f.type)).toEqual([
      'failure',
      'runtime_ms',
    ]);
    for (const mode of ['manual', 'chat', 'internal', 'integrated'] as const) {
      expect(countingFacts(runOf(t, id, { mode })), mode).toEqual([]);
    }
    for (const status of ['canceled', 'waiting', 'new', 'running'] as const) {
      expect(countingFacts(runOf(t, id, { status })), status).toEqual([]);
    }
    expect(countingFacts(runOf(t, null))).toEqual([]);
  });

  it('clamps the runtime to 0..2^31-1 and adds time saved on a success of a production run', () => {
    const id = randomUUID();
    const t = randomUUID();
    const run = (over: Partial<InsightRun>) =>
      Object.fromEntries(countingFacts(runOf(t, id, over)).map((f) => [f.type, f.value]));
    expect(run({ runtimeMs: 12 })).toEqual({ success: 1, runtime_ms: 12 });
    const huge = insightRunOf(
      { tenantId: t, workflowId: id, workflowName: 'x', mode: 'webhook', startedAt: new Date() } as never,
      { name: 'x' },
      { status: 'success' },
      2 ** 40,
    );
    expect(Object.fromEntries(countingFacts(huge).map((f) => [f.type, f.value])).runtime_ms).toBe(
      2_147_483_647,
    );
    expect(run({ settings: { timeSavedPerExecution: 5 } })).toEqual({
      success: 1,
      runtime_ms: 100,
      time_saved_min: 5,
    });
    // a failure and an error workflow save no time
    expect(run({ status: 'error', settings: { timeSavedPerExecution: 5 } }).time_saved_min).toBeUndefined();
    expect(run({ mode: 'error', settings: { timeSavedPerExecution: 5 } }).time_saved_min).toBeUndefined();
    const dynamic = {
      timeSavedMode: 'dynamic' as const,
      timeSavedPerExecution: 99,
    };
    const runData = {
      A: [{ metadata: { timeSaved: { minutes: 3 } } }, { metadata: { timeSaved: { minutes: 4 } } }],
      B: [{ metadata: {} }],
    } as never;
    expect(run({ settings: dynamic, runData }).time_saved_min).toBe(7);
  });
});

describe('time saved is capped', () => {
  const savedOf = (over: Partial<InsightRun>) =>
    countingFacts(runOf(randomUUID(), randomUUID(), over)).find((f) => f.type === 'time_saved_min')?.value;

  it('one run adds at most 2^31-1 minutes, from a setting, an expression or an overflow', () => {
    expect(savedOf({ settings: { timeSavedPerExecution: Number.MAX_SAFE_INTEGER } })).toBe(
      MAX_INSIGHT_RUNTIME_MS,
    );
    const dynamic = { timeSavedMode: 'dynamic' as const };
    const huge = (minutes: number) => ({ A: [{ metadata: { timeSaved: { minutes } } }] }) as never;
    expect(savedOf({ settings: dynamic, runData: huge(1e300) })).toBe(MAX_INSIGHT_RUNTIME_MS);
    expect(savedOf({ settings: dynamic, runData: huge(Number.MAX_VALUE) })).toBe(MAX_INSIGHT_RUNTIME_MS);
    expect(savedOf({ settings: { timeSavedPerExecution: 7 } })).toBe(7);
  });

  it('one huge run never stops the flush of other tenants', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const wa = await workflowIn(server, a.tenant.id, await teamProjectOf(server, a.tenant.id));
    const wb = await workflowIn(server, b.tenant.id, await teamProjectOf(server, b.tenant.id));
    const at = new Date('2026-03-04T10:15:00Z');
    const dynamic = { timeSavedMode: 'dynamic' as const };
    // 1e300 minutes (an expression) and 1100 runs at the largest fixed setting, all in one hour
    server.ctx.insights.record(
      runOf(a.tenant.id, wa.id, {
        startedAt: at,
        settings: dynamic,
        runData: { A: [{ metadata: { timeSaved: { minutes: 1e300 } } }] } as never,
      }),
    );
    for (let i = 0; i < 1100; i++) {
      server.ctx.insights.record(
        runOf(a.tenant.id, wa.id, {
          startedAt: at,
          settings: { timeSavedPerExecution: Number.MAX_SAFE_INTEGER },
        }),
      );
    }
    server.ctx.insights.record(runOf(b.tenant.id, wb.id, { startedAt: at }));
    await server.ctx.insights.flush();
    const saved = await server.ctx.database.pool.query(
      'select value::text as value from insights_by_period where tenant_id = $1 and type = 0',
      [a.tenant.id],
    );
    expect(Number(saved.rows[0].value)).toBe(1101 * MAX_INSIGHT_RUNTIME_MS);
    expect((await periodRows(b.tenant.id)).reduce((s, r) => s + r.value, 0)).toBeGreaterThan(0);
  });
});

describe('what a real run adds', () => {
  it('5 successes and 2 failures match GET /executions', async () => {
    const owner = await signup(server.app);
    const ok = await webhookWorkflow(owner, 'Fine');
    const bad = await webhookWorkflow(
      owner,
      'Fragile',
      node('Boom', 'test.fail', { message: 'kaputt' }, [200, 0]),
    );
    await fire(owner, ok, 5);
    await fire(owner, bad, 2);
    await server.ctx.insights.flush();

    const list = (await owner.client.get('/rest/executions?limit=100')).json().data as Array<{
      status: string;
    }>;
    expect(list).toHaveLength(7);
    const failed = list.filter((e) => e.status === 'error').length;
    expect(failed).toBe(2);

    const s = await summary(owner);
    expect(s.total.value).toBe(7);
    expect(s.failed.value).toBe(2);
    expect(s.failureRate.value).toBe(0.286);
    expect(s.total.unit).toBe('count');
    expect(s.failureRate.unit).toBe('ratio');
    // the runtime adds up to what the workspace's usage counter measured for the same runs
    const usage = await server.ctx.database.pool.query(
      'select executions, execution_ms::int as ms from usage_counters where tenant_id = $1',
      [owner.tenant.id],
    );
    expect(usage.rows[0].executions).toBe(7);
    const page = await owner.client.data<{ data: Array<{ runTime: number; workflowName: string }> }>(
      owner.client.get('/rest/insights/by-workflow'),
    );
    const total = page.data.reduce((sum, row) => sum + row.runTime, 0);
    expect(total).toBe(usage.rows[0].ms);
    expect(s.averageRunTime.value).toBeCloseTo(total / 7, 1);
    expect(page.data.map((r) => r.workflowName).sort()).toEqual(['Fine', 'Fragile']);
  });

  it('manual runs add nothing', async () => {
    const owner = await signup(server.app);
    const flow = await webhookWorkflow(owner, 'Manual');
    const { executionId } = await owner.client.data<{ executionId: string }>(
      owner.client.post(`/rest/workflows/${flow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, owner.tenant.id, executionId, FINISHED);
    await server.ctx.insights.flush();
    expect(await periodRows(owner.tenant.id)).toEqual([]);
    expect((await summary(owner)).total.value).toBe(0);
  });

  it('chat, internal, integrated, canceled, waiting and workflow-less runs add nothing', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    const { insights } = server.ctx;
    for (const mode of ['chat', 'internal', 'integrated', 'manual'] as const) {
      insights.record(runOf(owner.tenant.id, workflow.id, { mode }));
    }
    for (const status of ['canceled', 'waiting'] as const) {
      insights.record(runOf(owner.tenant.id, workflow.id, { status }));
    }
    insights.record(runOf(owner.tenant.id, null));
    await insights.flush();
    expect(await periodRows(owner.tenant.id)).toEqual([]);
  });

  it('an error workflow run adds a run and no time saved', async () => {
    const owner = await signup(server.app);
    const handler = await createWorkflow(owner.client, {
      name: 'On error',
      nodes: [node('Error Trigger', 'core.errorTrigger'), setNode('Note', 'handled', 'yes')],
      connections: chain('Error Trigger', 'Note'),
      settings: { timeSavedPerExecution: 9 },
    });
    const bad = await webhookWorkflow(owner, 'Fragile', node('Boom', 'test.fail', {}, [200, 0]), {
      errorWorkflow: handler.id,
      timeSavedPerExecution: 4,
    });
    await fire(owner, bad, 1);
    const errorRun = await waitFor(
      async () =>
        (await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: handler.id, limit: 1 }))[0],
      { message: 'the error workflow run' },
    );
    await waitForExecution(server.ctx, owner.tenant.id, errorRun.id, ['success']);
    expect(errorRun.mode).toBe('error');
    await server.ctx.insights.flush();
    const s = await summary(owner);
    expect(s.total.value).toBe(2);
    expect(s.failed.value).toBe(1);
    expect(s.timeSaved.value).toBe(0);
  });

  it('a run that is not saved still counts, with its time saved', async () => {
    const owner = await signup(server.app);
    const flow = await webhookWorkflow(owner, 'Quiet', setNode('Done', 'ok', 'yes'), {
      saveDataSuccessExecution: 'none',
      timeSavedPerExecution: 6,
    });
    const res = await server.app.inject({
      method: 'POST',
      url: `/webhook/${owner.tenant.slug}/${flow.path}`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    await waitFor(
      async () => {
        await server.ctx.insights.flush();
        return (await summary(owner)).total.value === 1;
      },
      { message: 'the unsaved run to count' },
    );
    expect((await summary(owner)).timeSaved.value).toBe(6);
    const saved = await server.ctx.repos.executions.list(owner.tenant.id, { workflowId: flow.id, limit: 10 });
    expect(saved).toHaveLength(0);
  });
});

describe('the buffer', () => {
  it('adds runs of one workflow and hour into one row per type, written in one sorted upsert', async () => {
    const owner = await signup(server.app);
    const project = await teamProjectOf(server, owner.tenant.id);
    const a = await workflowIn(server, owner.tenant.id, project, { name: 'A' });
    const b = await workflowIn(server, owner.tenant.id, project, { name: 'B' });
    const at = new Date('2026-03-04T10:15:00Z');
    const { insights } = server.ctx;
    for (const w of [b, a, b, a, a]) {
      insights.record(runOf(owner.tenant.id, w.id, { startedAt: at, runtimeMs: 10 }));
    }
    insights.record(runOf(owner.tenant.id, a.id, { startedAt: at, status: 'error', runtimeMs: 10 }));

    const written: Array<Array<{ metaId: number; type: number; value: number }>> = [];
    const addPeriods = server.ctx.repos.insights.addPeriods.bind(server.ctx.repos.insights);
    server.ctx.repos.insights.addPeriods = async (rows) => {
      written.push(rows.map((r) => ({ metaId: r.metaId, type: r.type, value: r.value })));
      return addPeriods(rows);
    };
    try {
      await insights.flush();
    } finally {
      server.ctx.repos.insights.addPeriods = addPeriods;
    }
    expect(written).toHaveLength(1);
    const keys = written[0].map((r) => [r.metaId, r.type]);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || x[1] - y[1]));
    // A: 3 successes and 1 failure, B: 2 successes; one runtime row each
    expect(written[0]).toHaveLength(5);
    const rows = await server.ctx.database.pool.query(
      `select m.workflow_name as name, p.type, p.value::int as value, p.period_unit, p.period_start
       from insights_by_period p join insights_metadata m on m.id = p.meta_id and m.tenant_id = p.tenant_id
       where p.tenant_id = $1 order by m.workflow_name, p.type`,
      [owner.tenant.id],
    );
    expect(rows.rows.map((r) => [r.name, r.type, r.value, r.period_unit])).toEqual([
      ['A', 1, 40, 0],
      ['A', 2, 3, 0],
      ['A', 3, 1, 0],
      ['B', 1, 20, 0],
      ['B', 2, 2, 0],
    ]);
    expect(new Date(rows.rows[0].period_start).toISOString()).toBe('2026-03-04T10:00:00.000Z');
    // the buffer was emptied: another flush writes nothing
    await insights.flush();
    expect((await periodRows(owner.tenant.id)).reduce((s, r) => s + r.value, 0)).toBe(40 + 3 + 1 + 20 + 2);
  });

  it('buckets a run by the hour it ended, not the hour it started', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    // a run that waited two days: started Monday 10:15, ended Wednesday 12:40
    server.ctx.insights.record(
      runOf(owner.tenant.id, workflow.id, {
        startedAt: new Date('2026-03-02T10:15:00Z'),
        endedAt: new Date('2026-03-04T12:40:00Z'),
      }),
    );
    await server.ctx.insights.flush();
    const starts = (
      await server.ctx.database.pool.query(
        'select distinct period_start from insights_by_period where tenant_id = $1',
        [owner.tenant.id],
      )
    ).rows.map((r) => new Date(r.period_start).toISOString());
    expect(starts).toEqual(['2026-03-04T12:00:00.000Z']);
  });

  it('insightRunOf stamps the end of the run, now unless given', () => {
    const row = { tenantId: randomUUID(), workflowId: randomUUID(), workflowName: 'x', mode: 'webhook' };
    const before = Date.now();
    const run = insightRunOf(
      { ...row, startedAt: null, createdAt: new Date(0) } as never,
      { name: 'x' },
      { status: 'success' },
      5,
    );
    expect(run.startedAt.getTime()).toBe(0);
    expect(run.endedAt?.getTime()).toBeGreaterThanOrEqual(before);
    const stopped = new Date('2026-01-01T00:00:00Z');
    expect(
      insightRunOf(
        { ...row, startedAt: null, createdAt: new Date(0) } as never,
        { name: 'x' },
        { status: 'success' },
        5,
        stopped,
      ).endedAt,
    ).toBe(stopped);
  });

  it('a buffered bucket holds at most 2^53-1', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    const at = new Date('2026-03-04T10:15:00Z');
    const held = (server.ctx.insights as unknown as { buffer: Map<string, { type: string; value: number }> })
      .buffer;
    for (let i = 0; i < 3; i++) {
      server.ctx.insights.record(
        runOf(owner.tenant.id, workflow.id, { startedAt: at, runtimeMs: MAX_INSIGHT_RUNTIME_MS }),
      );
    }
    expect([...held.values()].find((b) => b.type === 'runtime_ms')?.value).toBe(3 * MAX_INSIGHT_RUNTIME_MS);
    for (const b of held.values()) b.value = MAX_INSIGHT_BUCKET_VALUE - 1;
    server.ctx.insights.record(runOf(owner.tenant.id, workflow.id, { startedAt: at, runtimeMs: 5 }));
    expect([...held.values()].every((b) => b.value <= MAX_INSIGHT_BUCKET_VALUE)).toBe(true);
    await server.ctx.insights.flush();
  });

  it('flushes by itself when the buffer holds flushBatchSize keys', async () => {
    const small = await createTestServer({ INSIGHTS_FLUSH_BATCH_SIZE: '4' }, { reset: false });
    try {
      const owner = await signup(small.app);
      const workflow = await workflowIn(small, owner.tenant.id, await teamProjectOf(small, owner.tenant.id));
      for (let hour = 0; hour < 2; hour++) {
        small.ctx.insights.record(
          runOf(owner.tenant.id, workflow.id, { startedAt: new Date(Date.UTC(2026, 0, 1, hour)) }),
        );
      }
      const rows = await waitFor(
        async () => {
          const found = (
            await small.ctx.database.pool.query('select 1 from insights_by_period where tenant_id = $1', [
              owner.tenant.id,
            ])
          ).rowCount;
          return found ? found : undefined;
        },
        { message: 'the full buffer to flush' },
      );
      expect(rows).toBe(4);
    } finally {
      await small.close();
    }
  });

  it('a failing flush puts the facts back and the next flush writes them once', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    const { insights } = server.ctx;
    insights.record(runOf(owner.tenant.id, workflow.id));
    const addPeriods = server.ctx.repos.insights.addPeriods.bind(server.ctx.repos.insights);
    let failures = 1;
    server.ctx.repos.insights.addPeriods = async (rows) => {
      if (failures-- > 0) throw new Error('the database is away');
      return addPeriods(rows);
    };
    try {
      await expect(insights.flush()).rejects.toThrow('the database is away');
      // a run that finishes while the store is down joins the facts that were put back
      insights.record(runOf(owner.tenant.id, workflow.id));
      await insights.flush();
    } finally {
      server.ctx.repos.insights.addPeriods = addPeriods;
    }
    const rows = await periodRows(owner.tenant.id);
    expect(rows.find((r) => r.type === 2)?.value).toBe(2);
    await insights.flush();
    expect((await periodRows(owner.tenant.id)).find((r) => r.type === 2)?.value).toBe(2);
  });

  it('record returns at once, throws nothing and calls no database, even when the store hangs', () => {
    const hung = new Promise<never>(() => {});
    const calls: string[] = [];
    const collector = new InsightsCollector({
      ...server.ctx.serviceDeps,
      repos: {
        ...server.ctx.repos,
        insights: {
          addPeriods: () => {
            calls.push('addPeriods');
            return hung;
          },
          workflowInfos: () => {
            calls.push('workflowInfos');
            return hung;
          },
        },
      } as never,
    });
    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      expect(
        collector.record(runOf(randomUUID(), randomUUID(), { startedAt: new Date(i * 3_600_000) })),
      ).toBe(undefined);
    }
    expect(performance.now() - started).toBeLessThan(200);
    expect(calls).toEqual([]);
    // a run with a broken date is counted nowhere and throws nothing
    expect(collector.record(runOf(randomUUID(), randomUUID(), { startedAt: new Date(Number.NaN) }))).toBe(
      undefined,
    );
  });

  it('keeps a workflow row current when the name or the project changes', async () => {
    const owner = await signup(server.app);
    const project = await teamProjectOf(server, owner.tenant.id);
    const workflow = await workflowIn(server, owner.tenant.id, project, { name: 'Before' });
    const { insights } = server.ctx;
    insights.record(runOf(owner.tenant.id, workflow.id));
    await insights.flush();
    const meta = () =>
      server.ctx.database.pool
        .query(
          'select id, workflow_name, project_id, project_name from insights_metadata where tenant_id = $1',
          [owner.tenant.id],
        )
        .then((r) => r.rows);
    const [first] = await meta();
    expect(first).toMatchObject({ workflow_name: 'Before', project_id: project });

    await owner.client.data(
      owner.client.patch(`/rest/workflows/${workflow.id}`, { name: 'After', versionId: workflow.versionId }),
    );
    insights.record(runOf(owner.tenant.id, workflow.id));
    await insights.flush();
    const rows = await meta();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, workflow_name: 'After' });
  });
});

describe('crashes', () => {
  /** a run left 'running' with its stored workflow, as a stopped process leaves it */
  async function runningRun(owner: Owner, workflowId: string) {
    const row = await server.ctx.repos.executions.create(
      owner.tenant.id,
      {
        id: randomUUID(),
        workflowId,
        mode: 'webhook',
        status: 'running',
        workflowName: 'Crashy',
        startedAt: new Date(),
      } as never,
      { workflowData: { name: 'Crashy', nodes: [], connections: {}, settings: {} }, runOptions: {} },
    );
    return row;
  }

  it('markCrashed adds one failure with runtime 0', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    await runningRun(owner, workflow.id);
    expect(await server.ctx.executions.markCrashed()).toBe(1);
    await server.ctx.insights.flush();
    const rows = await periodRows(owner.tenant.id);
    expect(rows.filter((r) => r.type === 3).map((r) => r.value)).toEqual([1]);
    expect(rows.filter((r) => r.type === 2)).toEqual([]);
    expect(rows.find((r) => r.type === 1)?.value ?? 0).toBe(0);
  });

  it('the worker crash path adds one failure, not two', async () => {
    const owner = await signup(server.app);
    const workflow = await workflowIn(server, owner.tenant.id, await teamProjectOf(server, owner.tenant.id));
    const row = await runningRun(owner, workflow.id);
    await server.ctx.executions.runQueued(
      { tenantId: owner.tenant.id, executionId: row.id, kind: 'run' } as never,
      { redelivered: true },
    );
    await server.ctx.insights.flush();
    const rows = await periodRows(owner.tenant.id);
    expect(rows.filter((r) => r.type === 3).map((r) => r.value)).toEqual([1]);
    expect(rows.filter((r) => r.type === 2)).toEqual([]);
  });

  it('a crash after the run was counted adds nothing more', async () => {
    const owner = await signup(server.app);
    const flow = await webhookWorkflow(owner, 'Fine');
    const { executions } = server.ctx.repos;
    const saveState = executions.saveState.bind(executions);
    executions.saveState = async () => {
      throw new Error('the store is full');
    };
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: `/webhook/${owner.tenant.slug}/${flow.path}`,
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      await waitFor(
        async () => {
          const [row] = await executions.list(owner.tenant.id, { workflowId: flow.id, limit: 1 });
          return row && FINISHED.includes(row.status) ? row : undefined;
        },
        { message: 'the crashed run to close' },
      );
    } finally {
      executions.saveState = saveState;
    }
    await server.ctx.insights.flush();
    // the run finished as a success before the store failed: one success, no failure
    const s = await summary(owner);
    expect(s.total.value).toBe(1);
    expect(s.failed.value).toBe(0);
  });
});

describe('the tenant line', () => {
  it("tenant B sees none of A's runs", async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const flow = await webhookWorkflow(a, 'Mine');
    await fire(a, flow, 2);
    await server.ctx.insights.flush();
    expect((await summary(a)).total.value).toBe(2);
    expect((await summary(b)).total.value).toBe(0);
    const page = await b.client.data<{ count: number; data: unknown[] }>(
      b.client.get('/rest/insights/by-workflow'),
    );
    expect(page).toEqual({ count: 0, data: [] });
    expect(await periodRows(b.tenant.id)).toEqual([]);
  });
});
