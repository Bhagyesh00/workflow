/**
 * P6-05 (L11) insights compaction and pruning: hours older than 90 days roll into days, days older than 180
 * into weeks (weeks from Monday), in bounded batches under one lock, and the totals never change; buckets older
 * than INSIGHTS_MAX_AGE_DAYS are pruned. Passes are run by hand with `runOnce(now)` and `pruneOnce(now)`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InsightsCompaction } from '../src/services/insights/compaction';
import {
  createTestServer,
  resetDatabase,
  signup,
  type TestServer,
  teamProjectOf,
  workflowIn,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer({}, { startMain: false });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
});

type Owner = Awaited<ReturnType<typeof signup>>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

/** a workflow row of the insights with `rows` buckets: [type 0..3, unit 0..2, start, value] */
async function seeded(s: TestServer, owner: Owner, rows: Array<[0 | 1 | 2 | 3, 0 | 1 | 2, number, number]>) {
  const project = await teamProjectOf(s, owner.tenant.id);
  const workflow = await workflowIn(s, owner.tenant.id, project, {
    name: `Flow ${randomUUID().slice(0, 6)}`,
  });
  const meta = await s.ctx.repos.insights.upsertMetadata([
    {
      tenantId: owner.tenant.id,
      workflowId: workflow.id,
      workflowName: workflow.name,
      projectId: project,
      projectName: 'Team',
    },
  ]);
  const metaId = meta.get(workflow.id) as number;
  await s.ctx.repos.insights.addPeriods(
    rows.map(([type, periodUnit, at, value]) => ({
      tenantId: owner.tenant.id,
      metaId,
      type,
      periodUnit,
      periodStart: new Date(at),
      value,
    })),
  );
  return { workflowId: workflow.id, metaId };
}

const bucketsOf = async (s: TestServer, tenantId: string) =>
  (
    await s.ctx.database.pool.query(
      'select type, period_unit as unit, period_start, value::int as value from insights_by_period where tenant_id = $1 order by period_unit, type, period_start',
      [tenantId],
    )
  ).rows.map((r) => ({
    type: r.type as number,
    unit: r.unit as number,
    start: new Date(r.period_start).getTime(),
    value: r.value as number,
  }));

/** what the buckets add up to, per type, whatever their unit */
const totalsOf = async (s: TestServer, tenantId: string) => {
  const totals: Record<number, number> = {};
  for (const b of await bucketsOf(s, tenantId)) totals[b.type] = (totals[b.type] ?? 0) + b.value;
  return totals;
};

describe('compaction', () => {
  it('rolls hours older than 90 days into days and leaves newer hours', async () => {
    const owner = await signup(server.app);
    const old = dayOf(Date.now() - 100 * DAY);
    const recent = Math.floor((Date.now() - 2 * DAY) / HOUR) * HOUR;
    await seeded(server, owner, [
      [2, 0, old + 2 * HOUR, 3],
      [2, 0, old + 5 * HOUR, 4],
      [3, 0, old + 5 * HOUR, 1],
      [1, 0, old + 2 * HOUR, 30],
      [1, 0, old + 5 * HOUR, 50],
      [2, 0, recent, 9],
    ]);
    const before = await totalsOf(server, owner.tenant.id);
    const result = await server.ctx.insightsCompaction.runOnce(new Date());
    expect(result).toMatchObject({ hourToDay: 5, dayToWeek: 0 });
    expect(await bucketsOf(server, owner.tenant.id)).toEqual([
      { type: 2, unit: 0, start: recent, value: 9 },
      { type: 1, unit: 1, start: old, value: 80 },
      { type: 2, unit: 1, start: old, value: 7 },
      { type: 3, unit: 1, start: old, value: 1 },
    ]);
    expect(await totalsOf(server, owner.tenant.id)).toEqual(before);
    // nothing is left to roll: a second pass moves nothing
    expect(await server.ctx.insightsCompaction.runOnce(new Date())).toMatchObject({
      hourToDay: 0,
      dayToWeek: 0,
    });
  });

  it('rolls days older than 180 days into weeks that start on Monday', async () => {
    const owner = await signup(server.app);
    let monday = dayOf(Date.now() - 200 * DAY);
    while (new Date(monday).getUTCDay() !== 1) monday -= DAY;
    const recentDay = dayOf(Date.now() - 100 * DAY);
    await seeded(server, owner, [
      // Sunday: the week before; Monday and Tuesday: the week of the Monday
      [2, 1, monday - DAY, 2],
      [2, 1, monday, 5],
      [2, 1, monday + DAY, 7],
      [3, 1, monday + DAY, 1],
      [2, 1, recentDay, 11],
    ]);
    const before = await totalsOf(server, owner.tenant.id);
    expect(await server.ctx.insightsCompaction.runOnce(new Date())).toMatchObject({
      hourToDay: 0,
      dayToWeek: 4,
    });
    expect(await bucketsOf(server, owner.tenant.id)).toEqual([
      { type: 2, unit: 1, start: recentDay, value: 11 },
      { type: 2, unit: 2, start: monday - 7 * DAY, value: 2 },
      { type: 2, unit: 2, start: monday, value: 12 },
      { type: 3, unit: 2, start: monday, value: 1 },
    ]);
    expect(await totalsOf(server, owner.tenant.id)).toEqual(before);
  });

  it('takes hours all the way to weeks in one pass, and adds to a bucket that exists', async () => {
    const owner = await signup(server.app);
    const old = dayOf(Date.now() - 300 * DAY);
    let monday = old;
    while (new Date(monday).getUTCDay() !== 1) monday -= DAY;
    await seeded(server, owner, [
      [2, 0, old + HOUR, 1],
      [2, 0, old + 20 * HOUR, 2],
      [2, 1, old, 10],
      [2, 2, monday, 100],
    ]);
    expect(await server.ctx.insightsCompaction.runOnce(new Date())).toMatchObject({
      hourToDay: 2,
      dayToWeek: 1,
    });
    expect(await bucketsOf(server, owner.tenant.id)).toEqual([
      { type: 2, unit: 2, start: monday, value: 113 },
    ]);
  });

  it('compacts every workspace on its own', async () => {
    const a = await signup(server.app);
    const b = await signup(server.app);
    const old = dayOf(Date.now() - 100 * DAY);
    await seeded(server, a, [[2, 0, old + HOUR, 3]]);
    await seeded(server, b, [
      [2, 0, old + HOUR, 40],
      [2, 0, old + 2 * HOUR, 2],
    ]);
    await server.ctx.insightsCompaction.runOnce(new Date());
    expect(await bucketsOf(server, a.tenant.id)).toEqual([{ type: 2, unit: 1, start: old, value: 3 }]);
    expect(await bucketsOf(server, b.tenant.id)).toEqual([{ type: 2, unit: 1, start: old, value: 42 }]);
  });

  it('keeps the numbers the routes answer', async () => {
    const owner = await signup(server.app);
    const old = dayOf(Date.now() - 120 * DAY);
    await seeded(server, owner, [
      [2, 0, old + HOUR, 3],
      [3, 0, old + 3 * HOUR, 1],
      [1, 0, old + HOUR, 40],
      [1, 0, old + 3 * HOUR, 20],
      [0, 0, old + HOUR, 9],
    ]);
    const query = `startDate=${new Date(old - 5 * DAY).toISOString()}&endDate=${new Date().toISOString()}`;
    const read = async () => owner.client.data(owner.client.get(`/rest/insights/summary?${query}`));
    const before = await read();
    expect(before.total.value).toBe(4);
    await server.ctx.insightsCompaction.runOnce(new Date());
    expect(await read()).toEqual(before);
    const byTime = await owner.client.data<Array<{ date: string; values: { total: number } }>>(
      owner.client.get(`/rest/insights/by-time?${query}`),
    );
    expect(byTime.reduce((sum, row) => sum + row.values.total, 0)).toBe(4);
  });
});

describe('bounds and lock', () => {
  it('moves at most batch size rows a batch and stops at the batch bound', async () => {
    const small = await createTestServer(
      {
        INSIGHTS_COMPACTION_BATCH_SIZE: '2',
        INSIGHTS_COMPACTION_MAX_BATCHES_PER_RUN: '2',
        INSIGHTS_COMPACTION_BATCH_DELAY_MILLISECONDS: '0',
      },
      { startMain: false, reset: false },
    );
    try {
      const owner = await signup(small.app);
      const old = dayOf(Date.now() - 100 * DAY);
      await seeded(
        small,
        owner,
        [0, 1, 2, 3, 4, 5].map((h) => [2, 0, old + h * HOUR, 1] as [2, 0, number, number]),
      );
      const first = await small.ctx.insightsCompaction.runOnce(new Date());
      expect(first).toMatchObject({ hourToDay: 4, batches: 2 });
      expect((await bucketsOf(small, owner.tenant.id)).filter((b) => b.unit === 0)).toHaveLength(2);
      const second = await small.ctx.insightsCompaction.runOnce(new Date());
      expect(second.hourToDay).toBe(2);
      expect(await bucketsOf(small, owner.tenant.id)).toEqual([{ type: 2, unit: 1, start: old, value: 6 }]);
    } finally {
      await small.close();
    }
  });

  it('moves nothing while another process holds the compaction lock', async () => {
    const owner = await signup(server.app);
    const old = dayOf(Date.now() - 100 * DAY);
    await seeded(server, owner, [[2, 0, old + HOUR, 3]]);
    const holder = await server.ctx.database.pool.connect();
    try {
      await holder.query('begin');
      await holder.query("select pg_advisory_xact_lock(hashtext('insights:compaction'))");
      expect(await server.ctx.insightsCompaction.runOnce(new Date())).toMatchObject({ hourToDay: 0 });
      expect((await bucketsOf(server, owner.tenant.id))[0]).toMatchObject({ unit: 0 });
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect(await server.ctx.insightsCompaction.runOnce(new Date())).toMatchObject({ hourToDay: 1 });
  });

  it('starts and stops with the leadership, waits for a pass and is quiet when stopped twice', async () => {
    const compaction = new InsightsCompaction(server.ctx.serviceDeps);
    compaction.start();
    compaction.start();
    await compaction.stop();
    await compaction.stop();
  });
});

describe('pruning', () => {
  it('deletes buckets older than the maximum age and the rows of workflows that are gone', async () => {
    const owner = await signup(server.app);
    const now = Date.now();
    const kept = await seeded(server, owner, [
      [2, 2, dayOf(now - 400 * DAY), 5],
      [2, 1, dayOf(now - 364 * DAY), 6],
      [2, 0, Math.floor(now / HOUR) * HOUR, 7],
    ]);
    const gone = await seeded(server, owner, [[2, 2, dayOf(now - 500 * DAY), 3]]);
    await server.ctx.database.pool.query('delete from workflows where id = $1', [gone.workflowId]);
    const removed = await server.ctx.insightsCompaction.pruneOnce(new Date(now));
    expect(removed).toBe(2);
    expect((await bucketsOf(server, owner.tenant.id)).map((b) => b.value)).toEqual([7, 6]);
    const meta = await server.ctx.database.pool.query(
      'select id from insights_metadata where tenant_id = $1',
      [owner.tenant.id],
    );
    expect(meta.rows.map((r) => Number(r.id))).toEqual([kept.metaId]);
  });

  it('keeps a deleted workflow row that still has buckets, and uses the configured age', async () => {
    const short = await createTestServer({ INSIGHTS_MAX_AGE_DAYS: '30' }, { startMain: false, reset: false });
    try {
      const owner = await signup(short.app);
      const now = Date.now();
      const flow = await seeded(short, owner, [
        [2, 1, dayOf(now - 40 * DAY), 1],
        [2, 1, dayOf(now - 10 * DAY), 2],
      ]);
      await short.ctx.database.pool.query('delete from workflows where id = $1', [flow.workflowId]);
      expect(await short.ctx.insightsCompaction.pruneOnce(new Date(now))).toBe(1);
      expect((await bucketsOf(short, owner.tenant.id)).map((b) => b.value)).toEqual([2]);
      const meta = await short.ctx.database.pool.query(
        'select workflow_id from insights_metadata where tenant_id = $1',
        [owner.tenant.id],
      );
      expect(meta.rows).toEqual([{ workflow_id: null }]);
    } finally {
      await short.close();
    }
  });
});
