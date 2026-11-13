/**
 * P6-06 (S5 L3): the log streaming manager. Destinations are saved through the REST routes, events go in through
 * `ctx.events.emit`, and a sender type the test registers (`ctx.logStreaming.registerType`) records what it gets;
 * no test reaches a network. Breaker, anonymize, payload and secret splitting are checked on their own too.
 * Values here are fixed fakes; no test prints a secret.
 */
import { randomUUID } from 'node:crypto';
import type { LogDestination, LogDestinationType } from '@workflow/workflow';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayload, StreamEvent } from '../src/services/events/stream';
import { anonymizeAuditPayload } from '../src/services/log-streaming/anonymize';
import {
  BREAKER_HALF_OPEN_REQUESTS,
  BREAKER_OPEN_MS,
  CircuitBreaker,
} from '../src/services/log-streaming/breaker';
import { FailedEventStore } from '../src/services/log-streaming/failed-store';
import { LogStreamingManager } from '../src/services/log-streaming/manager';
import { destinationMessage } from '../src/services/log-streaming/payload';
import {
  destinationSecretBinding,
  mergeDestinationSecrets,
  splitDestinationSecrets,
} from '../src/services/log-streaming/secrets';
import { createTestServer, resetDatabase, signup, type TestServer, waitFor } from './helpers';

let server: TestServer;
let ip = 1;

interface Sent {
  destinationId: string;
  type: string;
  event: StreamEvent;
  test: boolean;
}
const sent: Sent[] = [];
let attempts = 0;
let failure: string | null = null;
let gate: Promise<void> | null = null;

const fakeEntry = (validate: (settings: unknown) => string | null = () => null) => ({
  create: (_deps: unknown, destination: { id: string; type: string }) => ({
    async send(event: StreamEvent, options: { test?: boolean }) {
      attempts += 1;
      if (gate) await gate;
      if (failure) throw new Error(failure);
      sent.push({
        destinationId: destination.id,
        type: destination.type,
        event,
        test: options.test === true,
      });
    },
  }),
  validate,
});

function registerFakes(manager: LogStreamingManager = server.ctx.logStreaming) {
  for (const type of ['webhook', 'syslog', 'sentry'] as LogDestinationType[]) {
    manager.registerType(type, fakeEntry() as never);
  }
}

beforeAll(async () => {
  server = await createTestServer({ LOGIN_RATE_LIMIT_MAX: '1000' });
});
afterAll(async () => {
  await server.close();
});
beforeEach(async () => {
  await resetDatabase(server.ctx);
  sent.length = 0;
  attempts = 0;
  failure = null;
  gate = null;
  registerFakes();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const world = () => signup(server.app, { remoteAddress: `127.8.7.${(ip++ % 250) + 1}` });
type World = Awaited<ReturnType<typeof signup>>;

const webhookSettings = (over: Record<string, unknown> = {}) => ({
  url: 'https://hooks.example.test/in',
  method: 'POST',
  sendQuery: false,
  queryParameters: [],
  sendHeaders: false,
  headerParameters: [],
  sendPayload: true,
  responseCodeMustMatch: false,
  expectedStatusCode: 200,
  options: {
    allowUnauthorizedCerts: false,
    queryParameterArrays: 'brackets',
    redirect: { followRedirects: false, maxRedirects: 21 },
    timeout: 5000,
  },
  ...over,
});

async function destination(w: World, body: Record<string, unknown> = {}): Promise<LogDestination> {
  return w.client.data<LogDestination>(
    w.client.post('/rest/eventbus/destination', {
      type: 'webhook',
      label: 'Test destination',
      enabled: true,
      subscribedEvents: ['workflow', 'audit.user.login.success'],
      settings: webhookSettings(),
      ...body,
    }),
  );
}

const emit = (w: World, name: string, payload: EventPayload = {}) =>
  server.ctx.events.emit(w.tenant.id, name, payload);
const settle = async () => {
  await server.ctx.events.flush();
  await new Promise((r) => setTimeout(r, 150));
};

/**
 * A new destination first replays its stored failed events (P6-63: they are older, so they go first) and only then
 * takes the queue. Wait until that first loop is idle, so the test's first event is the one in flight.
 */
async function ready(w: World) {
  const manager = server.ctx.logStreaming as unknown as {
    tenants: Map<string, { runtimes: Map<string, { draining: boolean }> }>;
  };
  await waitFor(async () => {
    const runtimes = [...(manager.tenants.get(w.tenant.id)?.runtimes.values() ?? [])];
    return runtimes.length > 0 && runtimes.every((runtime) => !runtime.draining);
  });
}

describe('circuit breaker', () => {
  it('opens after 5 failures in 60 s, half-opens after 3 minutes, closes after 2 good requests', () => {
    let at = 1_000_000;
    const breaker = new CircuitBreaker(undefined, () => at);
    expect(breaker.state).toBe('closed');
    for (let i = 0; i < 4; i++) {
      expect(breaker.recordFailure()).toBe(false);
      at += 1000;
    }
    expect(breaker.state).toBe('closed');
    expect(breaker.recordFailure()).toBe(true);
    expect(breaker.state).toBe('open');
    expect(breaker.canSend()).toBe(false);
    at += BREAKER_OPEN_MS - 1;
    expect(breaker.canSend()).toBe(false);
    at += 1;
    expect(breaker.state).toBe('half-open');
    // one at a time
    expect(breaker.canSend()).toBe(true);
    expect(breaker.canSend()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe('half-open');
    expect(breaker.canSend()).toBe(true);
    breaker.recordSuccess();
    expect(BREAKER_HALF_OPEN_REQUESTS).toBe(2);
    expect(breaker.state).toBe('closed');
    expect(breaker.canSend()).toBe(true);
  });

  it('does not count failures older than the window, and a failure while half-open reopens it', () => {
    let at = 5_000_000;
    const breaker = new CircuitBreaker({ maxFailures: 3, failureWindowMs: 10_000 }, () => at);
    breaker.recordFailure();
    breaker.recordFailure();
    at += 10_001;
    expect(breaker.recordFailure()).toBe(false);
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.recordFailure()).toBe(true);
    at += BREAKER_OPEN_MS;
    expect(breaker.canSend()).toBe(true);
    expect(breaker.recordFailure()).toBe(true);
    expect(breaker.state).toBe('open');
    expect(breaker.canSend()).toBe(false);
  });
});

describe('anonymize and payload', () => {
  it('masks every string under a _ key of an audit event and leaves other groups alone', () => {
    const payload = {
      _email: 'a@example.test',
      userId: 'u1',
      _firstName: 'Ada',
      nested: { _name: 'x', keep: 'y' },
      _list: ['p', 'q'],
      _count: 3,
    };
    const masked = anonymizeAuditPayload('audit.user.login.success', payload);
    expect(masked).toEqual({
      _email: '*',
      userId: 'u1',
      _firstName: '*',
      nested: { _name: '*', keep: 'y' },
      _list: ['*', '*'],
      _count: 3,
    });
    expect(payload._email).toBe('a@example.test');
    expect(anonymizeAuditPayload('workflow.started', payload)).toEqual(payload);
  });

  it('builds the message with the time as an ISO string, anonymized on request', () => {
    const event: StreamEvent = {
      id: randomUUID(),
      ts: '2026-11-12T10:00:00.000Z',
      eventName: 'audit.user.login.success',
      message: 'audit.user.login.success',
      payload: { _email: 'a@example.test', userId: 'u1' },
      tenantId: randomUUID(),
    };
    const plain = destinationMessage(event, { anonymizeAuditMessages: false });
    expect(plain).toMatchObject({
      id: event.id,
      ts: '2026-11-12T10:00:00.000Z',
      eventName: event.eventName,
      payload: { _email: 'a@example.test' },
    });
    expect(typeof plain.ts).toBe('string');
    const masked = destinationMessage(event, { anonymizeAuditMessages: true });
    expect(masked.payload).toEqual({ _email: '*', userId: 'u1' });
    expect(event.payload._email).toBe('a@example.test');
  });
});

describe('secret splitting', () => {
  const settings = webhookSettings({
    url: 'https://u:pw@hooks.example.test/in?token=T1&plain&other=O2',
    sendHeaders: true,
    headerParameters: [
      { name: 'X-Key', value: 'K1' },
      { name: 'X-Key', value: 'K2' },
    ],
    sendQuery: true,
    queryParameters: [{ name: 'q', value: 'Q1' }],
  });

  it('moves every secret value out of the settings and merges them back', () => {
    const split = splitDestinationSecrets('webhook', settings);
    const text = JSON.stringify(split.settings);
    for (const secret of ['T1', 'O2', 'pw', 'K1', 'K2', 'Q1']) expect(text).not.toContain(secret);
    expect(Object.keys(split.secrets).length).toBeGreaterThanOrEqual(6);
    expect(split.settings.url).toContain('token=');
    expect(split.settings.url).toContain('&plain&');
    const merged = mergeDestinationSecrets('webhook', split.settings, split.secrets);
    expect(merged).toEqual(settings);
  });

  it('does not overwrite a value that is not blank', () => {
    const split = splitDestinationSecrets('webhook', settings);
    const incoming = {
      ...split.settings,
      headerParameters: [
        { name: 'X-Key', value: 'NEW' },
        { name: 'X-Key', value: '' },
      ],
    };
    const merged = mergeDestinationSecrets('webhook', incoming, split.secrets) as typeof settings;
    expect(merged.headerParameters).toEqual([
      { name: 'X-Key', value: 'NEW' },
      { name: 'X-Key', value: 'K2' },
    ]);
  });

  it('splits the Sentry DSN key and leaves the host and project', () => {
    const dsn = { dsn: 'https://pubkey123@o1.ingest.example.test/42', sendPayload: true };
    const split = splitDestinationSecrets('sentry', dsn);
    expect(split.settings.dsn).toBe('https://@o1.ingest.example.test/42');
    expect(Object.values(split.secrets)).toContain('pubkey123');
    expect(mergeDestinationSecrets('sentry', split.settings, split.secrets)).toEqual(dsn);
    expect(splitDestinationSecrets('syslog', { host: 'h', port: 514 })).toEqual({
      settings: { host: 'h', port: 514 },
      secrets: {},
    });
  });

  it('binds the cipher payload to the destination', () => {
    expect(destinationSecretBinding('t1', 'd1')).toEqual({
      tenantId: 't1',
      credentialId: 'logDestination:d1',
    });
  });
});

describe('events reach the destinations', () => {
  it('a destination subscribed to workflow and audit.user.login.success gets exactly those', async () => {
    const w = await world();
    await destination(w);
    emit(w, 'workflow.started', { executionId: 'e1' });
    emit(w, 'node.started', { nodeName: 'A' });
    emit(w, 'audit.user.login.success', { userId: 'u1' });
    emit(w, 'audit.user.login.failed', { userId: 'u1' });
    emit(w, 'workflow.success', { executionId: 'e1' });
    await waitFor(async () => sent.length >= 3);
    await settle();
    expect(sent.map((s) => s.event.eventName)).toEqual([
      'workflow.started',
      'audit.user.login.success',
      'workflow.success',
    ]);
    expect(sent[0].test).toBe(false);
    expect(sent[0].event.tenantId).toBe(w.tenant.id);
  });

  it('a disabled destination gets nothing, and a wildcard gets everything', async () => {
    const w = await world();
    await destination(w, { enabled: false });
    await destination(w, { subscribedEvents: ['*'], label: 'All' });
    emit(w, 'queue.job.failed', {});
    emit(w, 'worker.started', {});
    await settle();
    expect(sent.map((s) => s.event.eventName)).toEqual(['queue.job.failed', 'worker.started']);
  });

  it('tenant B events never reach the destination of tenant A', async () => {
    const a = await world();
    const b = await world();
    await destination(a);
    emit(b, 'workflow.started', { executionId: 'b1' });
    emit(a, 'workflow.started', { executionId: 'a1' });
    await waitFor(async () => sent.length >= 1);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].event.tenantId).toBe(a.tenant.id);
    expect(sent[0].event.payload.executionId).toBe('a1');
  });

  it('builds the payload only when a destination subscribes', async () => {
    const w = await world();
    await destination(w, { subscribedEvents: ['audit'] });
    await settle();
    const payload = vi.fn(() => ({}));
    emit(w, 'workflow.started', payload);
    await settle();
    expect(payload).not.toHaveBeenCalled();
    emit(w, 'audit.user.invited', payload);
    await settle();
    expect(payload).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it('anonymizes the _ fields of audit events for a destination that asks for it', async () => {
    const w = await world();
    const masked = await destination(w, { anonymizeAuditMessages: true, label: 'Masked' });
    const plain = await destination(w, { label: 'Plain' });
    emit(w, 'audit.user.login.success', { userId: 'u1', _email: 'a@example.test' });
    emit(w, 'workflow.started', { _email: 'keep@example.test' });
    await waitFor(async () => sent.length >= 4);
    const of = (id: string, name: string) =>
      sent.find((s) => s.destinationId === id && s.event.eventName === name)!;
    expect(of(masked.id, 'audit.user.login.success').event.payload._email).toBe('*');
    expect(of(plain.id, 'audit.user.login.success').event.payload._email).toBe('a@example.test');
    expect(of(masked.id, 'workflow.started').event.payload._email).toBe('keep@example.test');
  });

  it('a replay applies the anonymize switch as it is now (failed-4)', async () => {
    const w = await world();
    const created = await destination(w, { subscribedEvents: ['audit'] });
    failure = 'upstream said no';
    emit(w, 'audit.user.login.success', { userId: 'u1', _email: 'stored@example.test' });
    await waitFor(async () => attempts >= 1);
    await settle();
    expect(sent).toHaveLength(0);
    // the event was kept unmasked (the flag was off); turning it on and reloading replays it masked
    failure = null;
    await destination(w, { id: created.id, subscribedEvents: ['audit'], anonymizeAuditMessages: true });
    await waitFor(async () => sent.length >= 1);
    expect(sent[0].event.eventName).toBe('audit.user.login.success');
    expect(sent[0].event.payload._email).toBe('*');
    expect(sent[0].event.payload.userId).toBe('u1');
  });

  it('a change of subscriptions takes effect on the next event', async () => {
    const w = await world();
    const created = await destination(w, { subscribedEvents: ['workflow'] });
    emit(w, 'queue.job.enqueued', {});
    await settle();
    expect(sent).toHaveLength(0);
    await w.client.data(
      w.client.post('/rest/eventbus/destination', { ...created, subscribedEvents: ['queue'] }),
    );
    emit(w, 'queue.job.enqueued', {});
    await waitFor(async () => sent.length >= 1);
    expect(sent[0].event.eventName).toBe('queue.job.enqueued');
  });

  it('deleting a destination stops its events', async () => {
    const w = await world();
    const created = await destination(w);
    emit(w, 'workflow.started', {});
    await waitFor(async () => sent.length >= 1);
    expect((await w.client.delete(`/rest/eventbus/destination?id=${created.id}`)).statusCode).toBe(200);
    emit(w, 'workflow.started', {});
    await settle();
    expect(sent).toHaveLength(1);
  });
});

describe('failures, the breaker and the failed store', () => {
  it('opens after 5 failed sends, hands events to the failed store and records a redacted last error', async () => {
    const w = await world();
    const added = vi.spyOn(FailedEventStore.prototype, 'add');
    const created = await destination(w);
    failure = 'upstream said no, Bearer abcdefghijklmnop0123456789';
    for (let i = 0; i < 7; i++) emit(w, 'workflow.started', { n: i });
    await waitFor(async () => added.mock.calls.length >= 7);
    expect(attempts).toBe(5);
    expect(added.mock.calls[0][0]).toBe(w.tenant.id);
    expect(added.mock.calls[0][1]).toBe(created.id);
    const shown = await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination'));
    expect(shown[0].lastError).toContain('upstream said no');
    expect(shown[0].lastError).not.toContain('abcdefghijklmnop0123456789');
    expect((shown[0].lastError ?? '').length).toBeLessThanOrEqual(1000);
  });

  it('half-opens after the open time, closes after 2 good sends and replays the failed store', async () => {
    const w = await world();
    const added = vi.spyOn(FailedEventStore.prototype, 'add');
    const replay = vi.spyOn(FailedEventStore.prototype, 'replay');
    await destination(w);
    vi.useFakeTimers({ toFake: ['Date'] });
    failure = 'down';
    for (let i = 0; i < 5; i++) emit(w, 'workflow.started', { n: i });
    await waitFor(async () => added.mock.calls.length >= 5);
    expect(attempts).toBe(5);
    vi.setSystemTime(Date.now() + BREAKER_OPEN_MS + 1000);
    failure = null;
    emit(w, 'workflow.started', { n: 'a' });
    emit(w, 'workflow.started', { n: 'b' });
    await waitFor(async () => sent.length >= 2);
    await waitFor(async () => replay.mock.calls.length >= 1);
    expect(replay.mock.calls[0][0]).toBe(w.tenant.id);
    // closed again: a later event is sent straight away
    emit(w, 'workflow.started', { n: 'c' });
    await waitFor(async () => sent.length >= 3);
  });

  it('the test message skips the breaker, returns the redacted error and keeps no event', async () => {
    const w = await world();
    const added = vi.spyOn(FailedEventStore.prototype, 'add');
    const created = await destination(w);
    const ok = await w.client.data<{ success: boolean }>(
      w.client.post(`/rest/eventbus/testmessage?id=${created.id}`),
    );
    expect(ok.success).toBe(true);
    expect(sent.at(-1)?.test).toBe(true);
    expect(sent.at(-1)?.event.eventName).toBe('destination.test');
    failure = 'refused with Bearer abcdefghijklmnop0123456789';
    for (let i = 0; i < 8; i++) {
      const bad = await w.client.data<{ success: boolean; error?: string }>(
        w.client.post(`/rest/eventbus/testmessage?id=${created.id}`),
      );
      expect(bad.success).toBe(false);
      expect(bad.error).toContain('refused');
      expect(bad.error).not.toContain('abcdefghijklmnop0123456789');
    }
    expect(attempts).toBe(9);
    expect(added).not.toHaveBeenCalled();
    failure = null;
    const again = await w.client.data<{ success: boolean }>(
      w.client.post(`/rest/eventbus/testmessage?id=${created.id}`),
    );
    expect(again.success).toBe(true);
    const shown = await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination'));
    expect(shown[0].lastError ?? null).toBeNull();
  });
});

describe('the bounded queue', () => {
  it('drops the oldest above 16 MB and counts it', async () => {
    const w = await world();
    const created = await destination(w, { subscribedEvents: ['*'] });
    await ready(w);
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blob = 'x'.repeat(5 * 1024 * 1024);
    for (const n of [1, 2, 3, 4, 5, 6]) emit(w, 'workflow.started', { n, blob });
    await waitFor(async () => attempts >= 1);
    await settle();
    const shown = await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination'));
    expect(shown[0].droppedEvents).toBeGreaterThanOrEqual(2);
    release();
    await waitFor(async () => sent.length >= 4);
    await settle();
    const order = sent.map((s) => s.event.payload.n);
    expect(order[0]).toBe(1);
    expect(order.at(-1)).toBe(6);
    expect(order).not.toContain(2);
    expect(order.length + (shown[0].droppedEvents ?? 0)).toBe(6);
    expect(created.id).toBe(sent[0].destinationId);
  });

  it('drops the oldest above 2000 events', async () => {
    const w = await world();
    await destination(w, { subscribedEvents: ['*'] });
    await ready(w);
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (let n = 0; n < 2005; n++) emit(w, 'workflow.started', { n });
    await waitFor(async () => attempts >= 1);
    await settle();
    release();
    await waitFor(async () => sent.length >= 2000, { timeout: 30_000 });
    await settle();
    const order = sent.map((s) => s.event.payload.n as number);
    expect(order[0]).toBe(0);
    expect(order.at(-1)).toBe(2004);
    expect(order.length).toBe(2001);
    const shown = await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination'));
    expect(shown[0].droppedEvents).toBe(4);
  });
});

describe('events held before the destinations load (logstream-3)', () => {
  it('keeps at most 16 MB of them, the oldest dropped, while the load keeps failing', async () => {
    const tenantId = randomUUID();
    vi.spyOn(server.ctx.repos.logDestinations, 'list').mockRejectedValue(new Error('database down'));
    const blob = 'x'.repeat(5 * 1024 * 1024);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      server.ctx.logStreaming.sink.deliver({
        id: randomUUID(),
        ts: new Date().toISOString(),
        eventName: 'workflow.started',
        message: 'workflow.started',
        payload: { n, blob },
        tenantId,
      });
    }
    const state = (
      server.ctx.logStreaming as unknown as {
        tenants: Map<string, { pending: Array<{ event: StreamEvent }>; pendingBytes: number }>;
      }
    ).tenants.get(tenantId)!;
    expect(state.pendingBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(state.pending.map((held) => held.event.payload.n)).toEqual([4, 5, 6]);
  });
});

describe('several processes', () => {
  it('two managers on one bus: a save on one reloads the other', async () => {
    const w = await world();
    const ctx = server.ctx;
    const second = new LogStreamingManager({
      config: ctx.config,
      database: ctx.database,
      repos: ctx.repos,
      logger: ctx.logger,
      context: () => ctx,
    });
    registerFakes(second);
    try {
      second.sink.accepts(w.tenant.id, 'workflow.started');
      await waitFor(async () => second.sink.accepts(w.tenant.id, 'workflow.started') === false);
      await destination(w);
      await waitFor(async () => second.sink.accepts(w.tenant.id, 'workflow.started') === true);
      expect(second.sink.accepts(w.tenant.id, 'node.started')).toBe(false);
      await w.client.delete(
        `/rest/eventbus/destination?id=${(await w.client.data<LogDestination[]>(w.client.get('/rest/eventbus/destination')))[0].id}`,
      );
      await waitFor(async () => second.sink.accepts(w.tenant.id, 'workflow.started') === false);
    } finally {
      await second.close();
    }
  });

  it('close() sends what is queued and later events are ignored', async () => {
    const w = await world();
    await destination(w);
    emit(w, 'workflow.started', { n: 1 });
    await server.ctx.events.flush();
    await server.ctx.logStreaming.close();
    expect(sent.map((s) => s.event.payload.n)).toEqual([1]);
  });
});
