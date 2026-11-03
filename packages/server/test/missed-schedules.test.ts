/**
 * P2-11 missed schedules: a restart after a missed slot follows the Schedule Trigger settings, and
 * two leaders never both run a slot. Uses database workflow_test_p2_sched and Redis db 5.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chain,
  createTestServer,
  createWorkflow,
  executionsOf,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
} from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});
afterAll(async () => {
  await server.ctx.activeWorkflows.stopAll();
  await server.close();
});
beforeEach(async () => {
  await server.ctx.activeWorkflows.stopAll();
  await resetDatabase(server.ctx);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pool = () => server.ctx.database.pool;

/** every minute at second 0; the slot grid is stable for the few seconds a test needs */
const EVERY_MINUTE = '0 * * * * *';

/** wait for a second of the minute where no slot is close (neither fresh nor about to tick) */
async function quietSecond() {
  while (true) {
    const s = new Date().getSeconds();
    if (s >= 6 && s <= 40) return;
    await sleep(500);
  }
}

async function scheduled(settings: Record<string, unknown>) {
  const { client, tenant } = await signup(server.app);
  const wf = await createWorkflow(client, {
    nodes: [
      node(
        'Schedule',
        'core.scheduleTrigger',
        { rule: { interval: [{ field: 'cronExpression', expression: EVERY_MINUTE }] }, ...settings },
        [0, 0],
      ),
      setNode('Set', 'seen', 'yes'),
    ],
    connections: chain('Schedule', 'Set'),
  });
  await client.data(client.post(`/rest/workflows/${wf.id}/activate`));
  return { client, tenant, wf };
}

async function slotRows(workflowId: string) {
  const res = await pool().query(
    'SELECT rule_key, last_slot, node_name, tenant_id FROM schedule_slots WHERE workflow_id = $1',
    [workflowId],
  );
  return res.rows as Array<{ rule_key: string; last_slot: Date; node_name: string; tenant_id: string }>;
}

async function restartAfterMiss(workflowId: string, minutesAgo: number) {
  await server.ctx.activeWorkflows.stopAll();
  await pool().query('UPDATE schedule_slots SET last_slot = $2 WHERE workflow_id = $1', [
    workflowId,
    new Date(Date.now() - minutesAgo * 60_000),
  ]);
  await server.ctx.activeWorkflows.startAll();
}

describe('P2-11 missed schedules', () => {
  it('activation stores a slot row for the rule (tenant, workflow, node, key)', async () => {
    await quietSecond();
    const { wf, tenant } = await scheduled({});
    const rows = await waitFor(async () => {
      const r = await slotRows(wf.id);
      return r.length ? r : undefined;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node_name: 'Schedule', tenant_id: tenant.id });
    expect(rows[0].rule_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skip (default): a restart after a missed slot runs nothing', async () => {
    await quietSecond();
    const { wf, tenant } = await scheduled({ misfireGraceSeconds: 1 });
    await waitFor(async () => (await slotRows(wf.id)).length > 0);
    await restartAfterMiss(wf.id, 5);
    await sleep(1500);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(0);
    // the dropped slots are not looked at again: the stored slot moved to the newest one
    const [row] = await slotRows(wf.id);
    expect(Date.now() - row.last_slot.getTime()).toBeLessThan(60_000 + 1000);
  });

  it('coalesce_owner: the newest missed slot runs once', async () => {
    await quietSecond();
    const { wf, tenant } = await scheduled({ misfirePolicy: 'coalesce_owner', misfireGraceSeconds: 1 });
    await waitFor(async () => (await slotRows(wf.id)).length > 0);
    await restartAfterMiss(wf.id, 5);
    const runs = await waitFor(async () => {
      const list = await executionsOf(server.ctx, tenant.id, wf.id);
      return list.length ? list : undefined;
    });
    await sleep(1500);
    expect(runs).toHaveLength(1);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
    // a second restart has nothing left to catch up
    await server.ctx.activeWorkflows.stopAll();
    await server.ctx.activeWorkflows.startAll();
    await sleep(1000);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
  });

  it('coalesce: the newest missed slot of the rule runs once', async () => {
    await quietSecond();
    const { wf, tenant } = await scheduled({ misfirePolicy: 'coalesce', misfireGraceSeconds: 1 });
    await waitFor(async () => (await slotRows(wf.id)).length > 0);
    await restartAfterMiss(wf.id, 5);
    await waitFor(async () => (await executionsOf(server.ctx, tenant.id, wf.id)).length > 0);
    await sleep(1500);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
  });

  it('two leaders never both run a slot', async () => {
    await quietSecond();
    const { wf, tenant } = await scheduled({ misfirePolicy: 'coalesce', misfireGraceSeconds: 1 });
    await waitFor(async () => (await slotRows(wf.id)).length > 0);
    await server.ctx.activeWorkflows.stopAll();
    await pool().query('UPDATE schedule_slots SET last_slot = $2 WHERE workflow_id = $1', [
      wf.id,
      new Date(Date.now() - 5 * 60_000),
    ]);
    // two "leaders" start the same workflow at once, as after a failover
    await Promise.all([server.ctx.activeWorkflows.startAll(), server.ctx.activeWorkflows.startAll()]);
    await sleep(2000);
    expect(await executionsOf(server.ctx, tenant.id, wf.id)).toHaveLength(1);
  });

  it('the store: claims are atomic and only move forward, reset overwrites, rows cascade', async () => {
    const { client, tenant } = await signup(server.app);
    const wf = await createWorkflow(client, { nodes: [node('Schedule', 'core.scheduleTrigger')] });
    const a = server.ctx.repos.scheduleSlots.storeFor(tenant.id, wf.id, 'Schedule', 60);
    const b = server.ctx.repos.scheduleSlots.storeFor(tenant.id, wf.id, 'Schedule', 60);
    expect(a.defaultGraceSeconds).toBe(60);
    expect(await a.last('k')).toBeUndefined();

    const slot = new Date('2026-11-03T12:00:00.000Z');
    const results = await Promise.all([
      a.claim('k', slot),
      b.claim('k', slot),
      a.claim('k', slot),
      b.claim('k', slot),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await a.last('k'))?.toISOString()).toBe(slot.toISOString());

    expect(await b.claim('k', new Date('2026-11-03T11:00:00.000Z'))).toBe(false); // older
    expect(await b.claim('k', slot)).toBe(false); // same
    expect(await b.claim('k', new Date('2026-11-03T12:01:00.000Z'))).toBe(true); // newer
    expect(await a.claim('other', slot)).toBe(true); // another rule is independent

    await a.reset('k', new Date('2026-11-03T10:00:00.000Z'));
    expect((await b.last('k'))?.toISOString()).toBe('2026-11-03T10:00:00.000Z');

    await pool().query('DELETE FROM workflows WHERE id = $1', [wf.id]);
    expect(await slotRows(wf.id)).toHaveLength(0);
  });
});
