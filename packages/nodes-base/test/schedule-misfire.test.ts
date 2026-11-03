/** P2-11: Schedule Trigger misfirePolicy and misfireGraceSeconds (unit tests with a fake slot store). */
import { createHash } from 'node:crypto';
import type { ScheduleSlotStore, TriggerContext } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { ScheduleTriggerNode } from '../src/nodes/core/ScheduleTrigger.node';

const NOW = new Date('2026-11-03T12:00:30.000Z');
const TZ = 'UTC';
/** the slot key of the rule at `index` (default the first) */
const ruleKey = (cron: string, index = 0, weeks = 1) =>
  createHash('sha256').update(`${index}|${cron}|${TZ}|${weeks}`).digest('hex');

/** slots every `stepMs` since the epoch (a stand-in for getCronSlots of a fixed-step cron) */
function slotsOf(stepMs: number) {
  return (after: Date, before: Date, max = 100) => {
    const out: Date[] = [];
    let t = Math.floor(after.getTime() / stepMs) * stepMs + stepMs;
    for (; t < before.getTime() && out.length < max; t += stepMs) out.push(new Date(t));
    return out;
  };
}

function memoryStore(initial: Record<string, Date> = {}, graceS = 60) {
  const rows = new Map<string, Date>(Object.entries(initial));
  const store: ScheduleSlotStore & { rows: Map<string, Date> } = {
    rows,
    defaultGraceSeconds: graceS,
    async last(key) {
      return rows.get(key);
    },
    async claim(key, slot) {
      const stored = rows.get(key);
      if (stored && stored.getTime() >= slot.getTime()) return false;
      rows.set(key, slot);
      return true;
    },
    async reset(key, slot) {
      rows.set(key, slot);
    },
  };
  return store;
}

interface Harness {
  emitted: number;
  ticks: Array<{ cron: string; fire: (slot: Date) => void }>;
  ctx: TriggerContext;
}

function harness(opts: {
  params: Record<string, unknown>;
  mode?: 'init' | 'create' | 'update' | 'activate' | 'manual';
  store?: ScheduleSlotStore;
  stepMs?: number;
}): Harness {
  const h: Harness = { emitted: 0, ticks: [], ctx: undefined as never };
  const step = opts.stepMs ?? 600_000; // every 10 minutes
  h.ctx = {
    getMode: () => 'trigger',
    getTimezone: () => TZ,
    getActivationMode: () => opts.mode ?? 'init',
    getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
      name in opts.params ? opts.params[name] : fallback,
    emit: () => {
      h.emitted++;
    },
    emitError: () => {},
    registerCron: (cron: string, onTick: (slot: Date) => void) => {
      h.ticks.push({ cron, fire: onTick });
      return () => {};
    },
    getCronSlots: (_cron: string, after: Date, before: Date, max?: number) =>
      slotsOf(step)(after, before, max),
    scheduleSlots: opts.store,
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  } as unknown as TriggerContext;
  return h;
}

const rule = (expression: string) => ({ interval: [{ field: 'cronExpression', expression }] });
const CRON = '0 */10 * * * *';
const OTHER = '0 */20 * * * *';
const settle = () => new Promise((r) => setTimeout(r, 30));

async function start(h: Harness) {
  const realNow = Date.now;
  Date.now = () => NOW.getTime();
  try {
    const res = await ScheduleTriggerNode.trigger!(h.ctx);
    await settle();
    return res;
  } finally {
    Date.now = realNow;
  }
}

// slots after it: 11:10 11:20 11:30 11:40 11:50 12:00 (the last is 30 s old at NOW)
const lastSlot = new Date('2026-11-03T11:00:00.000Z');

describe('Schedule Trigger misfire settings', () => {
  it('declares both settings as node settings, version stays 1', () => {
    const props = ScheduleTriggerNode.description.properties;
    const policy = props.find((p) => p.name === 'misfirePolicy');
    const grace = props.find((p) => p.name === 'misfireGraceSeconds');
    expect(policy).toMatchObject({ isNodeSetting: true, noDataExpression: true, default: 'skip' });
    expect(policy?.options?.map((o: any) => o.value)).toEqual(['skip', 'coalesce_owner', 'coalesce']);
    expect(grace).toMatchObject({ isNodeSetting: true, noDataExpression: true, default: 0 });
    expect(ScheduleTriggerNode.description.version).toBe(1);
  });

  it('skip (default) drops old slots after a restart and runs the one inside the grace', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: lastSlot });
    const h = harness({ params: { rule: rule(CRON) }, store });
    await start(h);
    expect(h.emitted).toBe(1);
    expect(store.rows.get(ruleKey(CRON))?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
  });

  it('skip runs nothing when every missed slot is older than the grace', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: lastSlot });
    const h = harness({ params: { rule: rule(CRON), misfireGraceSeconds: 5 }, store });
    await start(h);
    expect(h.emitted).toBe(0);
    expect(store.rows.get(ruleKey(CRON))?.toISOString()).toBe('2026-11-03T12:00:00.000Z');
  });

  it('coalesce runs the newest missed slot once', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: lastSlot });
    const h = harness({
      params: { rule: rule(CRON), misfirePolicy: 'coalesce', misfireGraceSeconds: 5 },
      store,
    });
    await start(h);
    expect(h.emitted).toBe(1);
  });

  it('coalesce_owner runs one slot across several rules', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: lastSlot, [ruleKey(OTHER, 1)]: lastSlot });
    const h = harness({
      params: {
        rule: {
          interval: [
            { field: 'cronExpression', expression: CRON },
            { field: 'cronExpression', expression: OTHER },
          ],
        },
        misfirePolicy: 'coalesce_owner',
        misfireGraceSeconds: 5,
      },
      store,
    });
    await start(h);
    expect(h.emitted).toBe(1);
  });

  it('coalesce runs one slot per rule', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: lastSlot, [ruleKey(OTHER, 1)]: lastSlot });
    const h = harness({
      params: {
        rule: {
          interval: [
            { field: 'cronExpression', expression: CRON },
            { field: 'cronExpression', expression: OTHER },
          ],
        },
        misfirePolicy: 'coalesce',
        misfireGraceSeconds: 5,
      },
      store,
    });
    await start(h);
    expect(h.emitted).toBe(2);
  });

  it('a node grace of 1 or more replaces the instance default; 0 uses the default', async () => {
    // instance default 3600 s: all 6 slots are inside the grace and run
    const a = memoryStore({ [ruleKey(CRON)]: lastSlot }, 3600);
    const ha = harness({ params: { rule: rule(CRON) }, store: a });
    await start(ha);
    expect(ha.emitted).toBe(6);
    // node grace 5 replaces that default
    const b = memoryStore({ [ruleKey(CRON)]: lastSlot }, 3600);
    const hb = harness({ params: { rule: rule(CRON), misfireGraceSeconds: 5 }, store: b });
    await start(hb);
    expect(hb.emitted).toBe(0);
  });

  it('clamps the grace to 30 days', async () => {
    const store = memoryStore({ [ruleKey(CRON)]: new Date('2026-09-01T00:00:00.000Z') });
    const h = harness({
      params: { rule: rule(CRON), misfireGraceSeconds: 99_999_999_999, misfirePolicy: 'coalesce' },
      store,
      stepMs: 86_400_000,
    });
    await start(h);
    // daily slots: the 30 inside 30 days (Oct 5 .. Nov 3) run, older ones coalesce into one more
    expect(h.emitted).toBe(31);
  });

  it('only a restart (init) catches up; other activations reset the slot to now', async () => {
    for (const mode of ['create', 'update', 'activate'] as const) {
      const store = memoryStore({ [ruleKey(CRON)]: lastSlot });
      const h = harness({ params: { rule: rule(CRON), misfirePolicy: 'coalesce' }, store, mode });
      await start(h);
      expect(h.emitted).toBe(0);
      expect(store.rows.get(ruleKey(CRON))?.getTime()).toBe(NOW.getTime());
    }
  });

  it('a first start (nothing stored) stores now and runs nothing', async () => {
    const store = memoryStore();
    const h = harness({ params: { rule: rule(CRON), misfirePolicy: 'coalesce' }, store });
    await start(h);
    expect(h.emitted).toBe(0);
    expect(store.rows.get(ruleKey(CRON))?.getTime()).toBe(NOW.getTime());
  });

  it('every live tick claims its slot: a second leader on the same slot does not emit', async () => {
    const store = memoryStore();
    const a = harness({ params: { rule: rule(CRON) }, store, mode: 'activate' });
    const b = harness({ params: { rule: rule(CRON) }, store, mode: 'activate' });
    await start(a);
    await start(b);
    const slot = new Date('2026-11-03T12:10:00.000Z');
    a.ticks[0].fire(slot);
    b.ticks[0].fire(slot);
    await settle();
    expect(a.emitted + b.emitted).toBe(1);
  });

  it('works without a store (unsaved workflow): ticks emit, no catch-up', async () => {
    const h = harness({ params: { rule: rule(CRON) } });
    await start(h);
    expect(h.emitted).toBe(0);
    h.ticks[0].fire(new Date('2026-11-03T12:10:00.000Z'));
    await settle();
    expect(h.emitted).toBe(1);
  });

  it('the rule key is the sha256 of the rule index, cron, timezone and week interval', async () => {
    const store = memoryStore();
    const h = harness({ params: { rule: rule(CRON) }, store, mode: 'activate' });
    await start(h);
    expect([...store.rows.keys()]).toEqual([ruleKey(CRON)]);
  });

  it('two identical rules are two schedules: each tick emits twice, as in n8n', async () => {
    const store = memoryStore();
    const twice = { interval: [rule(CRON).interval[0], rule(CRON).interval[0]] };
    const h = harness({ params: { rule: twice }, store, mode: 'activate' });
    await start(h);
    const slot = new Date('2026-11-03T12:10:00.000Z');
    for (const tick of h.ticks) tick.fire(slot);
    await settle();
    expect(h.emitted).toBe(2);
    expect(store.rows.size).toBe(2);
  });

  it('rules that differ only in the week interval keep their own slots and both catch up', async () => {
    const weekly = { field: 'weeks', weeksInterval: 1, triggerAtDay: [2], triggerAtHour: 9 };
    const everyOther = { ...weekly, weeksInterval: 2 };
    const store = memoryStore();
    const h = harness({ params: { rule: { interval: [everyOther, weekly] } }, store, mode: 'activate' });
    await start(h);
    expect(new Set(h.ticks.map((t) => t.cron)).size).toBe(1);
    expect([...store.rows.keys()].sort()).toEqual(
      [ruleKey(h.ticks[0].cron, 0, 2), ruleKey(h.ticks[0].cron, 1, 1)].sort(),
    );
    // a Tuesday: the weekly rule fires whatever the other one does
    const slot = new Date('2026-11-10T09:00:00.000Z');
    for (const tick of h.ticks) tick.fire(slot);
    await settle();
    const next = new Date('2026-11-17T09:00:00.000Z');
    for (const tick of h.ticks) tick.fire(next);
    await settle();
    // over two weeks: the weekly rule twice and the every-other-week rule once
    expect(h.emitted).toBe(3);
  });
});
