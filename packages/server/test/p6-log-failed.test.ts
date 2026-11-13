/**
 * P6-63 (S5 L7): the failed event store. A sender type the test registers (`ctx.logStreaming.registerType`) posts
 * to an in-process sink on 127.0.0.1; with the sink answering 500 the events of a run are stored, and when it
 * recovers and the breaker closes they arrive in id order, then the new ones. The row cap and the 50 MB cap each
 * drop the oldest; prune removes an 8-day-old row; another tenant's rows stay. Fixed fake values only.
 */
import { randomUUID } from 'node:crypto';
import type { LogDestination, LogDestinationType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../src/services/events/stream';
import { BREAKER_OPEN_MS } from '../src/services/log-streaming/breaker';
import {
  FAILED_MAX_BYTES,
  FAILED_MAX_ROWS,
  FAILED_REPLAY_BATCH,
  FailedEventStore,
} from '../src/services/log-streaming/failed-store';
import { Pruner } from '../src/services/maintenance';
import { type HttpSink, startHttpSink } from './fakes/http-sink';
import {
  chain,
  createTestServer,
  createWorkflow,
  node,
  resetDatabase,
  setNode,
  signup,
  type TestServer,
  waitFor,
  waitForExecution,
} from './helpers';

let server: TestServer;
let sink: HttpSink;
let ip = 1;

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
  sink = await startHttpSink();
}, 120_000);
afterAll(async () => {
  await sink?.close();
  await server?.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  sink.requests.length = 0;
  sink.respondWith(200);
  // the test's own sender: one POST of the event JSON to the sink, a non-2xx answer is a failure
  const entry = {
    create: () => ({
      async send(event: StreamEvent) {
        const response = await fetch(`${sink.url}/in`, { method: 'POST', body: JSON.stringify(event) });
        if (!response.ok) throw new Error(`Destination answered ${response.status}`);
      },
    }),
    validate: () => null,
  };
  for (const type of ['webhook', 'syslog', 'sentry'] as LogDestinationType[]) {
    server.ctx.logStreaming.registerType(type, entry as never);
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const world = () => signup(server.app, { remoteAddress: `127.9.7.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof signup>>;

async function destination(w: World, body: Record<string, unknown> = {}): Promise<LogDestination> {
  return w.client.data<LogDestination>(
    w.client.post('/rest/eventbus/destination', {
      type: 'webhook',
      label: 'Failed store test',
      enabled: true,
      subscribedEvents: ['workflow'],
      settings: { url: 'https://hooks.example.test/in' },
      ...body,
    }),
  );
}

const emit = (w: World, name: string, payload: Record<string, unknown> = {}) =>
  server.ctx.events.emit(w.tenant.id, name, payload as never);

const eventOf = (tenantId: string, n: number): StreamEvent => ({
  id: randomUUID(),
  ts: new Date().toISOString(),
  eventName: 'workflow.started',
  message: 'workflow.started',
  payload: { n },
  tenantId,
});

const repo = () => server.ctx.repos.logStreamFailed;
const count = async (tenantId: string, destinationId: string) =>
  (await repo().listOldest(tenantId, destinationId, 100_000)).length;
const numberOf = (row: { event: Record<string, unknown> }) => (row.event.payload as { n: number }).n;
const sinkEvents = () =>
  sink.requests.map((request) => JSON.parse(request.body.toString('utf8')) as StreamEvent);

describe('the failed store through a destination', () => {
  it('stores the events while the sink answers 500, then replays them in order and sends new ones', async () => {
    const w = await world();
    const created = await destination(w);
    sink.respondWith(500);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 7; i++) emit(w, 'workflow.started', { n: i });
    // 5 failed sends open the breaker, the other 2 events are kept without a send
    await waitFor(async () => (await count(w.tenant.id, created.id)) === 7, { message: '7 kept events' });
    expect(sink.requests).toHaveLength(5);
    const kept = await repo().listOldest(w.tenant.id, created.id, 10);
    expect(kept.map(numberOf)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(kept.every((row) => row.eventId === (row.event as { id: string }).id)).toBe(true);

    // the sink recovers; after the open time two good sends close the breaker and the replay runs
    sink.respondWith(200);
    sink.requests.length = 0;
    vi.setSystemTime(Date.now() + BREAKER_OPEN_MS + 1000);
    emit(w, 'workflow.started', { n: 'a' });
    emit(w, 'workflow.started', { n: 'b' });
    await waitFor(async () => (await count(w.tenant.id, created.id)) === 0, { message: 'the replay' });
    await waitFor(async () => sink.requests.length >= 9);
    emit(w, 'workflow.started', { n: 'c' });
    await waitFor(async () => sink.requests.length >= 10);
    expect(sinkEvents().map((event) => (event.payload as { n: unknown }).n)).toEqual([
      'a',
      'b',
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      'c',
    ]);
  });

  it('stores the events of a run when the sink fails and delivers them on a reload', async () => {
    const w = await world();
    const created = await destination(w);
    sink.respondWith(500);
    const workflow = await createWorkflow(w.client, {
      name: `Failed ${randomUUID().slice(0, 8)}`,
      nodes: [node('Start', 'core.manualTrigger'), setNode('Mark', 'done', 'yes')],
      connections: chain('Start', 'Mark'),
    });
    const { executionId } = await w.client.data<{ executionId: string }>(
      w.client.post(`/rest/workflows/${workflow.id}/run`, {}),
    );
    await waitForExecution(server.ctx, w.tenant.id, executionId, ['success']);
    await server.ctx.events.flush();
    await waitFor(async () => (await count(w.tenant.id, created.id)) >= 2, { message: 'the run events' });
    const rows = await repo().listOldest(w.tenant.id, created.id, 10);
    expect(rows.map((row) => row.event.eventName)).toEqual(['workflow.started', 'workflow.success']);
    expect(
      rows.every((row) => (row.event.payload as { executionId: string }).executionId === executionId),
    ).toBe(true);
    expect(rows[0].lastError).toContain('answered 500');

    // saving the destination again reloads it, and the replay sends what was kept, oldest first
    sink.respondWith(200);
    sink.requests.length = 0;
    await destination(w, { id: created.id });
    await waitFor(async () => (await count(w.tenant.id, created.id)) === 0, { message: 'the replay' });
    expect(sinkEvents().map((event) => event.eventName)).toEqual(['workflow.started', 'workflow.success']);
  });

  it("a replay through the manager scrubs the destination's secret values out of the kept error text", async () => {
    const secret = 'tkn-secret-9876';
    server.ctx.logStreaming.registerType('webhook', {
      create: () => ({
        async send() {
          throw new Error(`Destination refused the key ${secret}`);
        },
      }),
      validate: () => null,
    } as never);
    const w = await world();
    const body = { settings: { url: `https://hook:${secret}@hooks.example.test/in` } };
    const created = await destination(w, body);
    emit(w, 'workflow.started', { n: 1 });
    await waitFor(async () => (await count(w.tenant.id, created.id)) === 1, { message: 'the kept event' });

    // a save reloads the destination; its replay fails again and records the attempt on the row
    await destination(w, { ...body, id: created.id });
    await waitFor(async () => (await repo().listOldest(w.tenant.id, created.id, 1))[0]?.attempts >= 1, {
      message: 'the replay attempt',
    });
    const [row] = await repo().listOldest(w.tenant.id, created.id, 1);
    expect(row.lastError).not.toContain(secret);
    expect(row.lastError).toContain('[redacted]');
  });

  it('a replay through the manager stops when the destination is turned off mid-replay', async () => {
    let failing = true;
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.ctx.logStreaming.registerType('webhook', {
      create: () => ({
        async send() {
          if (failing) throw new Error('Destination answered 500');
          calls++;
          await gate;
        },
      }),
      validate: () => null,
    } as never);
    const w = await world();
    const created = await destination(w);
    for (let i = 0; i < 3; i++) emit(w, 'workflow.started', { n: i });
    await waitFor(async () => (await count(w.tenant.id, created.id)) === 3, { message: '3 kept events' });

    failing = false;
    await destination(w, { id: created.id });
    await waitFor(async () => calls === 1, { message: 'the first resend' });
    await destination(w, { id: created.id, enabled: false });
    release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(1);
    expect(await count(w.tenant.id, created.id)).toBe(2);
  });
});

describe('the store', () => {
  it('a failed resend stops the replay at that event, keeps it and counts the attempt', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    for (let i = 0; i < 4; i++) await store.add(w.tenant.id, created.id, eventOf(w.tenant.id, i), 'down');
    const seen: number[] = [];
    const sent = await store.replay(w.tenant.id, created.id, async (event) => {
      const n = (event.payload as { n: number }).n;
      if (n === 2) throw new Error('refused with Bearer abcdefghijklmnop0123456789');
      seen.push(n);
    });
    expect(sent).toBe(2);
    expect(seen).toEqual([0, 1]);
    const left = await repo().listOldest(w.tenant.id, created.id, 10);
    expect(left.map(numberOf)).toEqual([2, 3]);
    expect(left[0].attempts).toBe(1);
    expect(left[0].lastError).toContain('refused');
    expect(left[0].lastError).not.toContain('abcdefghijklmnop0123456789');
    expect(left[1].attempts).toBe(0);
    // the next replay starts at the failed event
    expect(await store.replay(w.tenant.id, created.id, async () => {})).toBe(2);
    expect(await count(w.tenant.id, created.id)).toBe(0);
  });

  it('replays more than one batch of 100, in id order', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    const total = FAILED_REPLAY_BATCH * 2 + 5;
    await server.ctx.database.pool.query(
      `INSERT INTO log_stream_failed (tenant_id, destination_id, event_id, event)
       SELECT $1, $2, gen_random_uuid(), jsonb_build_object('payload', jsonb_build_object('n', g))
       FROM generate_series(1, $3::int) g`,
      [w.tenant.id, created.id, total],
    );
    const seen: number[] = [];
    const sent = await store.replay(w.tenant.id, created.id, async (event) => {
      seen.push((event.payload as { n: number }).n);
    });
    expect(sent).toBe(total);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(await count(w.tenant.id, created.id)).toBe(0);
  });

  it('the row cap drops the oldest rows', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps, { maxRows: 3, maxBytes: FAILED_MAX_BYTES });
    for (let i = 0; i < 5; i++) await store.add(w.tenant.id, created.id, eventOf(w.tenant.id, i), 'down');
    const left = await repo().listOldest(w.tenant.id, created.id, 10);
    expect(left.map(numberOf)).toEqual([2, 3, 4]);
  });

  it('the default row cap is 10000: the 10001st event drops the oldest', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    expect(FAILED_MAX_ROWS).toBe(10_000);
    await server.ctx.database.pool.query(
      `INSERT INTO log_stream_failed (tenant_id, destination_id, event_id, event)
       SELECT $1, $2, gen_random_uuid(), jsonb_build_object('payload', jsonb_build_object('n', g))
       FROM generate_series(1, 10000) g`,
      [w.tenant.id, created.id],
    );
    await new FailedEventStore(server.ctx.serviceDeps).add(
      w.tenant.id,
      created.id,
      eventOf(w.tenant.id, 10_001),
      'down',
    );
    const rows = await repo().listOldest(w.tenant.id, created.id, 20_000);
    expect(rows).toHaveLength(10_000);
    expect(numberOf(rows[0])).toBe(2);
    expect(numberOf(rows[rows.length - 1])).toBe(10_001);
  });

  it('the byte cap drops the oldest rows once the event JSON passes 50 MB', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    expect(FAILED_MAX_BYTES).toBe(50 * 1024 * 1024);
    // 100 rows of about 0.5 MB (n = 1..100) are 50 000 000 bytes, under the cap; a 3 MB event passes it
    await server.ctx.database.pool.query(
      `INSERT INTO log_stream_failed (tenant_id, destination_id, event_id, event)
       SELECT $1, $2, gen_random_uuid(),
         jsonb_build_object('payload', jsonb_build_object('n', g, 'pad', repeat('x', 500000)))
       FROM generate_series(1, 100) g`,
      [w.tenant.id, created.id],
    );
    expect(await count(w.tenant.id, created.id)).toBe(100);
    const big = eventOf(w.tenant.id, 101);
    (big.payload as Record<string, unknown>).pad = 'x'.repeat(3_000_000);
    await new FailedEventStore(server.ctx.serviceDeps).add(w.tenant.id, created.id, big, 'down');
    const rows = await repo().listOldest(w.tenant.id, created.id, 100);
    const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row.event).length, 0);
    expect(bytes).toBeLessThanOrEqual(FAILED_MAX_BYTES);
    expect(rows.length).toBeLessThan(101);
    expect(numberOf(rows[0])).toBeGreaterThan(1);
    expect(numberOf(rows[rows.length - 1])).toBe(101);
  });

  it('the caps are per destination and per tenant', async () => {
    const a = await world();
    const b = await world();
    const first = await destination(a, { enabled: false });
    const second = await destination(a, { enabled: false, label: 'Second' });
    const other = await destination(b, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps, { maxRows: 2, maxBytes: FAILED_MAX_BYTES });
    await store.add(b.tenant.id, other.id, eventOf(b.tenant.id, 0), 'down');
    await store.add(a.tenant.id, second.id, eventOf(a.tenant.id, 0), 'down');
    for (let i = 0; i < 4; i++) await store.add(a.tenant.id, first.id, eventOf(a.tenant.id, i), 'down');
    expect(await count(a.tenant.id, first.id)).toBe(2);
    expect(await count(a.tenant.id, second.id)).toBe(1);
    expect(await count(b.tenant.id, other.id)).toBe(1);
    // the other tenant reads nothing of this destination, removes nothing and replays nothing
    const ids = (await repo().listOldest(a.tenant.id, first.id, 10)).map((row) => row.id);
    expect(await repo().listOldest(b.tenant.id, first.id, 10)).toEqual([]);
    expect(await repo().remove(b.tenant.id, ids)).toBe(0);
    expect(await store.replay(b.tenant.id, first.id, async () => {})).toBe(0);
    expect(await count(a.tenant.id, first.id)).toBe(2);
  });

  it('keeps the error text redacted and at most 1000 characters', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    await store.add(
      w.tenant.id,
      created.id,
      eventOf(w.tenant.id, 0),
      `${'e'.repeat(1500)} Bearer abcdefghijklmnop0123456789`,
    );
    await store.add(
      w.tenant.id,
      created.id,
      eventOf(w.tenant.id, 1),
      'plain Bearer abcdefghijklmnop0123456789',
    );
    const rows = await repo().listOldest(w.tenant.id, created.id, 2);
    expect((rows[0].lastError ?? '').length).toBeLessThanOrEqual(1000);
    expect(rows[1].lastError).toContain('plain');
    expect(rows[1].lastError).not.toContain('abcdefghijklmnop0123456789');
  });
});

describe('the store under load and edge cases (S5 fix round)', () => {
  const seed = (tenantId: string, destinationId: string, total: number) =>
    server.ctx.database.pool.query(
      `INSERT INTO log_stream_failed (tenant_id, destination_id, event_id, event)
       SELECT $1, $2, gen_random_uuid(), jsonb_build_object('payload', jsonb_build_object('n', g))
       FROM generate_series(1, $3::int) g`,
      [tenantId, destinationId, total],
    );

  it('two replays at once send each row once (failed-1, sweep-3)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    await seed(w.tenant.id, created.id, 20);
    const sends: number[] = [];
    const send = async (event: StreamEvent) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sends.push((event.payload as { n: number }).n);
    };
    // two stores stand for two processes, each with its own manager and store
    const first = new FailedEventStore(server.ctx.serviceDeps);
    const second = new FailedEventStore(server.ctx.serviceDeps);
    const [a, b] = await Promise.all([
      first.replay(w.tenant.id, created.id, send),
      second.replay(w.tenant.id, created.id, send),
    ]);
    expect(a + b).toBe(20);
    expect(sends).toHaveLength(20);
    expect(new Set(sends).size).toBe(20);
    expect(await count(w.tenant.id, created.id)).toBe(0);
    // the lock is gone: the next replay goes through
    await seed(w.tenant.id, created.id, 2);
    expect(await first.replay(w.tenant.id, created.id, async () => {})).toBe(2);
  });

  it('one store does not start a second replay of a destination it is replaying', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    await seed(w.tenant.id, created.id, 6);
    const store = new FailedEventStore(server.ctx.serviceDeps);
    const sends: number[] = [];
    const send = async (event: StreamEvent) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      sends.push((event.payload as { n: number }).n);
    };
    const results = await Promise.all([
      store.replay(w.tenant.id, created.id, send),
      store.replay(w.tenant.id, created.id, send),
    ]);
    expect(results.sort()).toEqual([0, 6]);
    expect(sends).toHaveLength(6);
  });

  it('a replay stops when told to: nothing more is sent and nothing is recorded (failed-2)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    await seed(w.tenant.id, created.id, 300);
    const store = new FailedEventStore(server.ctx.serviceDeps);
    let off = false;
    let sent = 0;
    const result = await store.replay(
      w.tenant.id,
      created.id,
      async () => {
        sent += 1;
        if (sent === 13) off = true;
      },
      { shouldStop: () => off },
    );
    expect(result).toBe(13);
    expect(sent).toBe(13);
    const left = await repo().listOldest(w.tenant.id, created.id, 1000);
    expect(left).toHaveLength(287);
    expect(left.every((row) => row.attempts === 0)).toBe(true);
    // a send that fails after the stop is not recorded either
    const again = await store.replay(
      w.tenant.id,
      created.id,
      async () => {
        off = true;
        throw new Error('late failure');
      },
      { shouldStop: () => off },
    );
    expect(again).toBe(0);
    expect((await repo().listOldest(w.tenant.id, created.id, 1))[0].attempts).toBe(0);
  });

  it('the row cap trims by an index walk and the byte scan runs once, not on every add (failed-3, sweep-2)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps, { maxRows: 5, maxBytes: FAILED_MAX_BYTES });
    const trim = vi.spyOn(repo(), 'trim');
    const usage = vi.spyOn(repo(), 'usage');
    for (let i = 0; i < 30; i++) await store.add(w.tenant.id, created.id, eventOf(w.tenant.id, i), 'down');
    expect(trim).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledTimes(1);
    expect((await repo().listOldest(w.tenant.id, created.id, 100)).map(numberOf)).toEqual([
      25, 26, 27, 28, 29,
    ]);
  });

  it('the byte cap trims to 90% of it, then the next adds do not scan (failed-3)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const pad = 'x'.repeat(900);
    const store = new FailedEventStore(server.ctx.serviceDeps, { maxRows: 1000, maxBytes: 50_000 });
    const trim = vi.spyOn(repo(), 'trim');
    for (let i = 0; i < 80; i++) {
      const event = eventOf(w.tenant.id, i);
      (event.payload as Record<string, unknown>).pad = pad;
      await store.add(w.tenant.id, created.id, event, 'down');
    }
    const rows = await repo().listOldest(w.tenant.id, created.id, 100);
    const bytes = rows.reduce((sum, row) => sum + JSON.stringify(row.event).length, 0);
    expect(bytes).toBeLessThanOrEqual(50_000);
    expect(numberOf(rows[rows.length - 1])).toBe(79);
    // a trim every few adds, not one per add
    expect(trim.mock.calls.length).toBeGreaterThan(0);
    expect(trim.mock.calls.length).toBeLessThan(12);
  });

  it('keeps an event with a NUL character, as U+FFFD (failed-5)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    const event = eventOf(w.tenant.id, 0);
    (event.payload as Record<string, unknown>).text = 'a\u0000b';
    (event.payload as Record<string, unknown>)['k\u0000ey'] = ['x\u0000'];
    await store.add(w.tenant.id, created.id, event, 'bad\u0000text');
    const [row] = await repo().listOldest(w.tenant.id, created.id, 1);
    const payload = row.event.payload as Record<string, unknown>;
    expect(payload.text).toBe('a�b');
    expect(payload['k�ey']).toEqual(['x�']);
    expect(row.lastError).toBe('bad�text');
    // an event without a NUL is stored as it is, and a literal backslash-u0000 text is not touched
    const plain = eventOf(w.tenant.id, 1);
    (plain.payload as Record<string, unknown>).text = 'back\\u0000slash';
    await store.add(w.tenant.id, created.id, plain, 'down');
    const rows = await repo().listOldest(w.tenant.id, created.id, 2);
    expect((rows[1].event.payload as Record<string, unknown>).text).toBe('back\\u0000slash');
  });

  it('scrubs the secret values and any scheme:// run out of a replay error (destinations-1)', async () => {
    const w = await world();
    const created = await destination(w, { enabled: false });
    await seed(w.tenant.id, created.id, 1);
    const store = new FailedEventStore(server.ctx.serviceDeps);
    await store.replay(
      w.tenant.id,
      created.id,
      async () => {
        throw new Error('connect to https://user:pw@hooks.example.test/in?k=1 failed, token tkn-1234-secret');
      },
      { secretValues: ['tkn-1234-secret'] },
    );
    const [row] = await repo().listOldest(w.tenant.id, created.id, 1);
    expect(row.attempts).toBe(1);
    expect(row.lastError).not.toContain('tkn-1234-secret');
    expect(row.lastError).not.toContain('hooks.example.test');
    expect(row.lastError).not.toContain('pw@');
    expect(row.lastError).toContain('connect to');
  });
});

describe('prune', () => {
  async function ageRow(id: number, days: number) {
    await server.ctx.database.pool.query(
      `UPDATE log_stream_failed SET created_at = now() - make_interval(days => $2::int) WHERE id = $1`,
      [id, days],
    );
  }

  it('removes an 8-day-old row, keeps a 6-day-old one and leaves another tenant untouched', async () => {
    const a = await world();
    const b = await world();
    const mine = await destination(a, { enabled: false });
    const theirs = await destination(b, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    for (let i = 0; i < 3; i++) await store.add(a.tenant.id, mine.id, eventOf(a.tenant.id, i), 'down');
    await store.add(b.tenant.id, theirs.id, eventOf(b.tenant.id, 0), 'down');
    const rows = await repo().listOldest(a.tenant.id, mine.id, 10);
    await ageRow(rows[0].id, 8);
    await ageRow(rows[1].id, 6);
    expect(await store.prune(new Date())).toBe(1);
    expect((await repo().listOldest(a.tenant.id, mine.id, 10)).map(numberOf)).toEqual([1, 2]);
    expect(await count(b.tenant.id, theirs.id)).toBe(1);
    // three days on, the 6-day-old row is 9 days old and goes; the fresh row stays
    expect(await store.prune(new Date(Date.now() + 3 * 86_400_000))).toBe(1);
    expect((await repo().listOldest(a.tenant.id, mine.id, 10)).map(numberOf)).toEqual([2]);
  });

  it('the Pruner removes the old rows of every tenant', async () => {
    const a = await world();
    const b = await world();
    const mine = await destination(a, { enabled: false });
    const theirs = await destination(b, { enabled: false });
    const store = new FailedEventStore(server.ctx.serviceDeps);
    await store.add(a.tenant.id, mine.id, eventOf(a.tenant.id, 0), 'down');
    await store.add(a.tenant.id, mine.id, eventOf(a.tenant.id, 1), 'down');
    await store.add(b.tenant.id, theirs.id, eventOf(b.tenant.id, 0), 'down');
    const [old] = await repo().listOldest(a.tenant.id, mine.id, 1);
    const [theirOld] = await repo().listOldest(b.tenant.id, theirs.id, 1);
    await ageRow(old.id, 8);
    await ageRow(theirOld.id, 8);
    const pruner = new Pruner(server.ctx.config, server.ctx.repos, server.ctx.executions, server.ctx.logger);
    await pruner.prune();
    expect(await count(a.tenant.id, mine.id)).toBe(1);
    expect(await count(b.tenant.id, theirs.id)).toBe(0);
  });
});
