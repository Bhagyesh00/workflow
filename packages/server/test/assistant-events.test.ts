/**
 * P5-67 (L1): the Assistant's event stream. `Last-Event-ID` (and `?lastEventId`) replays only later
 * events; live events reach two subscribers of the bus at once; `text-delta` and `status` are live only;
 * an event sent outside a turn (`publish`) is stored with a null run id; the stream refuses another user,
 * another tenant and a signed-out client; every string is redacted before it is stored or sent.
 */
import { type AssistantEvent, isDurableAssistantEvent } from '@workflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssistantEventLog, assistantChannel } from '../src/services/assistant/events';
import { type AssistantHarness, createAssistantHarness, parseSseEvents } from './fakes/assistant-harness';
import type { FakeLlmStep } from './fakes/fake-llm';

function queue(h: AssistantHarness, ...steps: FakeLlmStep[]) {
  // the fake reads by request count: fill the places of requests already made (provider retries)
  while (h.script.length < h.fake.requests.length) h.script.push({ status: 500, error: 'used up' });
  h.script.splice(h.fake.requests.length, 0, ...steps);
}

const finished = (events: AssistantEvent[]) => events.some((e) => e.type === 'run-finish');

describe('Assistant events', () => {
  let h: AssistantHarness;

  beforeAll(async () => {
    h = await createAssistantHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('replays only the events after Last-Event-ID, and after ?lastEventId', async () => {
    const threadId = await h.createThread(h.editor);
    queue(h, { text: 'First answer.' });
    await h.chat(h.editor, threadId, 'one');
    await h.waitForStatus(h.editor, threadId, 'idle');
    const first = await h.events(h.editor, threadId);
    const lastOfFirst = Math.max(...first.map((e) => e.id ?? 0));

    queue(h, { text: 'Second answer.' });
    await h.chat(h.editor, threadId, 'two');
    await h.waitForStatus(h.editor, threadId, 'idle');
    const later = await h.events(h.editor, threadId, lastOfFirst);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((e) => (e.id ?? 0) > lastOfFirst)).toBe(true);
    expect(later.find((e) => e.type === 'text-block')?.payload).toMatchObject({ text: 'Second answer.' });
    expect(later.filter((e) => e.type === 'run-start')).toHaveLength(1);

    // the query cursor, as a client without the header sends it
    const res = await fetch(`${h.baseUrl}/rest/assistant/events/${threadId}?lastEventId=${lastOfFirst}`, {
      headers: { cookie: h.editor.client.cookie ?? '' },
      signal: AbortSignal.timeout(1500),
    }).catch(() => undefined);
    expect(res?.status).toBe(200);
    let text = '';
    try {
      const reader = res?.body?.getReader();
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
        if (text.includes('run-finish')) break;
      }
    } catch {
      /* the timeout ends the read */
    }
    const viaQuery = parseSseEvents(text);
    expect(viaQuery.map((e) => e.id)).toEqual(later.map((e) => e.id));

    // stored events are durable ones only, each with an id; live-only types never come back
    expect(later.every((e) => isDurableAssistantEvent(e.type))).toBe(true);
    expect(text).toMatch(/^id: \d+$/m);
  });

  it('sends live events, deltas included, to two subscribers at once', async () => {
    const threadId = await h.createThread(h.viewer);
    queue(h, { text: 'Streaming to everyone listening here.', delayMs: 400, chunkSize: 5 });
    const a = h.events(h.viewer, threadId, 0, { until: finished, idleMs: 5000 });
    const b = h.events(h.viewer, threadId, 0, { until: finished, idleMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await h.chat(h.viewer, threadId, 'hello');
    const [one, two] = await Promise.all([a, b]);
    const textOf = (events: AssistantEvent[]) =>
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => (e.payload as { text: string }).text)
        .join('');
    expect(textOf(one)).toBe('Streaming to everyone listening here.');
    expect(textOf(two)).toBe(textOf(one));
    expect(one.filter((e) => e.id !== undefined).map((e) => e.id)).toEqual(
      two.filter((e) => e.id !== undefined).map((e) => e.id),
    );
    // deltas carry no id and are not stored
    expect(one.filter((e) => e.type === 'text-delta').every((e) => e.id === undefined)).toBe(true);
    const stored = await h.ctx.database.pool.query(
      `select count(*)::int as n from assistant_events where thread_id = $1 and type in ('text-delta', 'status')`,
      [threadId],
    );
    expect(stored.rows[0].n).toBe(0);
    await h.waitForStatus(h.viewer, threadId, 'idle');
  });

  it('crosses two event logs on one bus, and publish stores an event outside a turn', async () => {
    const threadId = await h.createThread(h.owner);
    const deps = {
      config: h.ctx.config,
      database: h.ctx.database,
      repos: h.ctx.repos,
      logger: h.ctx.logger,
      context: () => h.ctx,
    };
    const first = new AssistantEventLog(deps);
    const second = new AssistantEventLog(deps);
    const seenA: AssistantEvent[] = [];
    const seenB: AssistantEvent[] = [];
    const offA = await first.subscribe(h.tenantId, threadId, (e) => seenA.push(e));
    const offB = await second.subscribe(h.tenantId, threadId, (e) => seenB.push(e));
    const id = await h.ctx.assistant.publish(h.tenantId, threadId, {
      type: 'artifact',
      runId: null,
      payload: {
        artifact: { type: 'workflow', id: 'w1', name: 'Billing sk-proj-abcdefghijklmnopqrstuvwxyz' },
      },
    });
    first.live(h.tenantId, threadId, { type: 'status', runId: 'r1', payload: { message: 'working' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(id).toBeGreaterThan(0);
    for (const seen of [seenA, seenB]) {
      expect(seen.map((e) => e.type)).toEqual(['artifact', 'status']);
      expect(seen[0].id).toBe(id);
      expect(JSON.stringify(seen[0])).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
    }
    const replayed = await first.replay(h.tenantId, threadId, 0);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: 'artifact', id, runId: null });
    expect(JSON.stringify(replayed)).toContain('[redacted]');
    // a live-only event appended is not stored
    expect(
      await second.append(h.tenantId, threadId, { type: 'text-delta', runId: 'r1', payload: { text: 'x' } }),
    ).toBe(null);
    expect(await first.replay(h.tenantId, threadId, 0)).toHaveLength(1);
    offA();
    offB();
    await first.close();
    await second.close();
    expect(assistantChannel('t', 'x')).toBe('assistant:t:x');
  });

  it('refuses the stream to a signed-out client, another user and another tenant', async () => {
    const threadId = await h.createThread(h.admin);
    const plain = await fetch(`${h.baseUrl}/rest/assistant/events/${threadId}`);
    expect(plain.status).toBe(401);
    for (const user of [h.viewer, h.other.owner]) {
      const res = await fetch(`${h.baseUrl}/rest/assistant/events/${threadId}`, {
        headers: { cookie: user.client.cookie ?? '' },
      });
      expect(res.status).toBe(404);
    }
    const bad = await fetch(`${h.baseUrl}/rest/assistant/events/${threadId}`, {
      headers: { cookie: h.admin.client.cookie ?? '', 'last-event-id': 'abc' },
    });
    expect(bad.status).toBe(400);
  });

  it('answers 404 on every route while the Assistant is off for the workspace', async () => {
    const threadId = await h.createThread(h.owner);
    await h.setSettings({ enabled: false });
    try {
      expect((await h.owner.client.get('/rest/assistant/threads')).statusCode).toBe(404);
      expect(
        (await h.owner.client.post(`/rest/assistant/chat/${threadId}`, { message: 'x' })).statusCode,
      ).toBe(404);
      const res = await fetch(`${h.baseUrl}/rest/assistant/events/${threadId}`, {
        headers: { cookie: h.owner.client.cookie ?? '' },
      });
      expect(res.status).toBe(404);
    } finally {
      await h.setSettings({});
    }
  });
});
