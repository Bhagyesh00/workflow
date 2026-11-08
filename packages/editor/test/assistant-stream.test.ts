/**
 * P5-67 (L2): the Assistant's server stream (fetch with the tenant header, own SSE parser, highest id kept,
 * reconnect with backoff from it, stop on abort), the pure event reducer (deltas, text blocks, replays, tool
 * rows, cards, tasks, artifacts, run ends) and the store's open order (messages, status, then the stream from
 * `nextEventId - 1`).
 */
import type { AssistantConfirmation, AssistantEvent } from '@workflow/workflow';
import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSseParser,
  setAssistantStreamConnector,
  setAssistantStreamRetry,
  streamAssistantEvents,
} from '../src/api/assistant-stream';
import { ApiError, setCurrentTenant } from '../src/api/client';
import { assistantApi } from '../src/api/endpoints';
import { assistantDemoState } from '../src/demo/mock-assistant';
import {
  ASSISTANT_RUN_FAILED,
  ASSISTANT_TOOL_STOPPED,
  reduceAssistantEvent,
} from '../src/features/assistant/event-reducer';
import {
  type AssistantThreadState,
  initialAssistantState,
  useAssistantStore,
} from '../src/stores/assistant-store';
import { backend, signedIn } from './backend';
import { server } from './setup';

const EVENTS_URL = '*/rest/assistant/events/:threadId';

/** an SSE body that sends `parts` (as split as given) and then closes, or stays open until the request aborts */
function sse(parts: string[], request: Request, keepOpen = false) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (!keepOpen) controller.close();
      else
        request.signal.addEventListener('abort', () => {
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
    },
  });
  return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } });
}

const frame = (event: Record<string, unknown>, id?: number) =>
  `${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`;

afterEach(() => {
  setAssistantStreamRetry(null);
  setAssistantStreamConnector(null);
  setCurrentTenant(null);
  useAssistantStore.getState().reset();
});

describe('server stream (P5-67)', () => {
  beforeEach(() => {
    setAssistantStreamRetry({ initialMs: 5, maxMs: 20 });
  });

  it('reads split SSE frames with the tenant header, drops replays and reconnects from the highest id', async () => {
    setCurrentTenant('tenant-1');
    const seen: Array<{ lastEventId: string | null; tenant: string | null; header: string | null }> = [];
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        const url = new URL(request.url);
        seen.push({
          lastEventId: url.searchParams.get('lastEventId'),
          tenant: request.headers.get('x-tenant-id'),
          header: request.headers.get('last-event-id'),
        });
        if (seen.length === 1) {
          return sse(
            [
              ': ping\n\n',
              'id: 5\ndata: {"type":"run-start","runId":"r1","pay',
              'load":{"resumed":false}}\n\n',
              'data: {"type":"text-delta","runId":"r1","payload":{"text":"Hel"}}\r\n\r\n',
              'data: not json\n\n',
              frame({ type: 'nope', runId: null, payload: {} }),
              // an older id than one already delivered
              frame({ type: 'tasks-update', id: 4, runId: 'r1', payload: { tasks: [] } }),
            ],
            request,
          );
        }
        return sse(
          [
            frame({ type: 'run-start', runId: 'r1', payload: { resumed: false } }, 5),
            frame({ type: 'text-block', runId: 'r1', payload: { messageId: 'm1', text: 'Hello' } }, 6),
          ],
          request,
          true,
        );
      }),
    );
    const events: AssistantEvent[] = [];
    const controller = new AbortController();
    await streamAssistantEvents(
      'th-1',
      3,
      (event) => {
        events.push(event);
        if (event.type === 'text-block') controller.abort();
      },
      controller.signal,
    );
    expect(events.map((event) => [event.type, event.id])).toEqual([
      ['run-start', 5],
      ['text-delta', undefined],
      ['text-block', 6],
    ]);
    expect(seen).toEqual([
      { lastEventId: '3', tenant: 'tenant-1', header: '3' },
      { lastEventId: '5', tenant: 'tenant-1', header: '5' },
    ]);
  });

  it('retries a server error and a network failure, then streams', async () => {
    let calls = 0;
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ error: { message: 'down' } }, { status: 503 });
        if (calls === 2) return HttpResponse.error();
        return sse([frame({ type: 'error', runId: null, payload: { message: 'x' } }, 1)], request, true);
      }),
    );
    const controller = new AbortController();
    const events: AssistantEvent[] = [];
    await streamAssistantEvents(
      'th-1',
      0,
      (event) => {
        events.push(event);
        controller.abort();
      },
      controller.signal,
    );
    expect(calls).toBe(3);
    expect(events).toHaveLength(1);
  });

  it('ends with the error of an answer a retry cannot fix', async () => {
    let calls = 0;
    server.use(
      http.get(EVENTS_URL, () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'Thread not found' } },
          { status: 404 },
        );
      }),
    );
    const failure = streamAssistantEvents('th-x', 0, () => undefined, new AbortController().signal);
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 404, message: 'Thread not found' });
    expect(calls).toBe(1);
  });

  it('stops on abort while it waits to reconnect', async () => {
    setAssistantStreamRetry({ initialMs: 60_000, maxMs: 60_000 });
    let calls = 0;
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        calls += 1;
        return sse([], request);
      }),
    );
    const controller = new AbortController();
    const done = streamAssistantEvents('th-1', 0, () => undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('joins data lines and handles a CRLF split across chunks', () => {
    const frames: Array<[string, string | null]> = [];
    const parser = createSseParser((data, id) => frames.push([data, id]));
    parser.push('id: 7\r');
    parser.push('\ndata: a\ndata: b\r\n');
    parser.push('\r\n: comment\n\ndata: c');
    parser.end();
    expect(frames).toEqual([['a\nb', '7']]);
  });
});

const ev = <T extends AssistantEvent['type']>(
  type: T,
  payload: Extract<AssistantEvent, { type: T }>['payload'],
  id?: number,
  runId: string | null = 'r1',
) => ({ type, payload, runId, ...(id === undefined ? {} : { id }) }) as AssistantEvent;

function thread(): AssistantThreadState {
  const { messages, streamingText, toolRuns, pending, tasks, artifacts, status, cursor, error } =
    initialAssistantState();
  return { messages, streamingText, toolRuns, pending, tasks, artifacts, status, cursor, error };
}

const reduceAll = (events: AssistantEvent[], start = thread()) => events.reduce(reduceAssistantEvent, start);

const CARD: AssistantConfirmation = {
  requestId: 'req-1',
  toolCallId: 'c1',
  toolName: 'delete_workflow',
  title: 'Delete workflow',
  allowSession: false,
  expiresAt: null,
  createdAt: '2026-11-08T00:00:00.000Z',
  inputType: 'approval',
  details: { facts: [{ label: 'Workflow', value: 'Orders' }] },
};

describe('event reducer (P5-67)', () => {
  it('appends deltas to the live segment and a text block replaces it with a message', () => {
    const live = reduceAll([ev('run-start', { resumed: false }, 1), ev('text-delta', { text: 'Hel' })]);
    expect(live.status).toBe('running');
    expect(live.streamingText).toBe('Hel');
    const done = reduceAll(
      [ev('text-delta', { text: 'lo' }), ev('text-block', { messageId: 'm1', text: 'Hello' }, 2)],
      live,
    );
    expect(done.streamingText).toBe('');
    expect(done.messages.map((m) => [m.id, m.role, m.content])).toEqual([['m1', 'assistant', 'Hello']]);
    expect(done.cursor).toBe(2);
  });

  it('keeps one copy of the text across a reconnect mid-block', () => {
    // live deltas, then the connection drops (a delta is missed), then the replay and the block arrive
    const before = reduceAll([ev('run-start', { resumed: false }, 1), ev('text-delta', { text: 'Hello ' })]);
    const replayed = reduceAssistantEvent(before, ev('run-start', { resumed: false }, 1));
    expect(replayed).toBe(before);
    const after = reduceAll(
      [
        ev('text-block', { messageId: 'm1', text: 'Hello world' }, 2),
        // a second replay of the same block
        ev('text-block', { messageId: 'm1', text: 'Hello world' }, 2),
      ],
      replayed,
    );
    expect(after.messages.map((m) => m.content)).toEqual(['Hello world']);
    expect(after.streamingText).toBe('');
    // a block whose message the loaded page already holds replaces it in place
    const again = reduceAssistantEvent(
      { ...after, cursor: 0 },
      ev('text-block', { messageId: 'm1', text: 'Hello world' }, 3),
    );
    expect(again.messages).toHaveLength(1);
  });

  it('tracks tool rows: running, done, failed, and joins calls to the message that asked', () => {
    const state = reduceAll([
      ev('text-block', { messageId: 'm1', text: 'Looking' }, 1),
      ev('tool-call', { toolCallId: 'c1', toolName: 'list_workflows', args: { limit: 5 } }, 2),
      ev('tool-call', { toolCallId: 'c2', toolName: 'get_workflow', args: { id: 'w1' } }, 3),
      ev('tool-result', { toolCallId: 'c1', toolName: 'list_workflows', result: '[]' }, 4),
      ev('tool-error', { toolCallId: 'c2', toolName: 'get_workflow', error: 'Not found' }, 5),
    ]);
    expect(state.toolRuns.map((r) => [r.toolCallId, r.state, r.result ?? r.error])).toEqual([
      ['c1', 'done', '[]'],
      ['c2', 'failed', 'Not found'],
    ]);
    expect(state.toolRuns[0].args).toEqual({ limit: 5 });
    expect(state.messages[0].toolCalls?.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('adds and removes cards, replaces tasks and lists each artifact once', () => {
    const state = reduceAll([
      ev('confirmation-request', { confirmation: CARD }, 1),
      ev('tasks-update', { tasks: [{ id: 't1', description: 'Build', status: 'in_progress' }] }, 2),
      ev('artifact', { artifact: { type: 'workflow', id: 'w1', name: 'Orders' } }, 3),
      ev('artifact', { artifact: { type: 'workflow', id: 'w1', name: 'Orders v2' } }, 4),
      ev('artifact', { artifact: { type: 'draft', draftId: 'd1', name: 'Draft' } }, 5),
    ]);
    expect(state.pending.map((c) => c.requestId)).toEqual(['req-1']);
    expect(state.tasks).toHaveLength(1);
    expect(state.artifacts).toEqual([
      { type: 'workflow', id: 'w1', name: 'Orders v2' },
      { type: 'draft', draftId: 'd1', name: 'Draft' },
    ]);
    const resolved = reduceAssistantEvent(
      state,
      ev('confirmation-resolved', { requestId: 'req-1', toolCallId: 'c1', outcome: 'approved' }, 6),
    );
    expect(resolved.pending).toEqual([]);
  });

  it('ends a run by status: suspended keeps open rows, cancelled fails them, error shows a reason', () => {
    const running = reduceAll([
      ev('run-start', { resumed: false }, 1),
      ev('tool-call', { toolCallId: 'c1', toolName: 'delete_workflow', args: {} }, 2),
      ev('text-delta', { text: 'partial' }),
    ]);
    const suspended = reduceAssistantEvent(running, ev('run-finish', { status: 'suspended' }, 3));
    expect(suspended.status).toBe('suspended');
    expect(suspended.toolRuns[0].state).toBe('running');
    const cancelled = reduceAssistantEvent(running, ev('run-finish', { status: 'cancelled' }, 3));
    expect([cancelled.status, cancelled.streamingText]).toEqual(['idle', '']);
    expect(cancelled.toolRuns[0]).toMatchObject({ state: 'failed', error: ASSISTANT_TOOL_STOPPED });
    expect(reduceAssistantEvent(running, ev('run-finish', { status: 'error' }, 3)).error).toBe(
      ASSISTANT_RUN_FAILED,
    );
    expect(
      reduceAssistantEvent(running, ev('run-finish', { status: 'error', reason: 'Model refused' }, 3)).error,
    ).toBe('Model refused');
    expect(reduceAssistantEvent(running, ev('error', { message: 'Rate limited' }, 3)).error).toBe(
      'Rate limited',
    );
  });

  it('changes nothing for an event at or below the cursor', () => {
    const state = { ...thread(), cursor: 10 };
    expect(reduceAssistantEvent(state, ev('error', { message: 'old' }, 10))).toBe(state);
    expect(reduceAssistantEvent(state, ev('error', { message: 'old' }, 9))).toBe(state);
  });
});

describe('store open order (P5-67)', () => {
  beforeEach(() => void signedIn());

  it('loads messages, then status, then streams from nextEventId - 1', async () => {
    const created = await assistantApi.createThread({});
    const demo = assistantDemoState(backend()).threads.get(created.id);
    if (!demo) throw new Error('no demo thread');
    demo.messages.push({
      id: 'm-old',
      runId: 'r0',
      role: 'assistant',
      content: 'Earlier answer',
      summarized: false,
      createdAt: '2026-11-08T00:00:00.000Z',
    });
    demo.nextEventId = 8;
    const order: string[] = [];
    let streamedAfter = -1;
    setAssistantStreamConnector(async (threadId, afterId, _onEvent, signal) => {
      order.push(`stream ${threadId}`);
      streamedAfter = afterId;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    backend().requests.length = 0;
    await useAssistantStore.getState().openThread(created.id);
    const reads = backend()
      .requests.filter((r) => r.method === 'GET')
      .map((r) => r.path.replace(created.id, ':id'));
    expect(reads).toEqual(['/assistant/threads/:id/messages', '/assistant/threads/:id/status']);
    expect(order).toEqual([`stream ${created.id}`]);
    expect(streamedAfter).toBe(7);
    const state = useAssistantStore.getState();
    expect(state.messages.map((m) => m.content)).toEqual(['Earlier answer']);
    expect([state.cursor, state.status, state.activeThreadId]).toEqual([7, 'idle', created.id]);
  });

  it('drops events of a thread that is no longer open', async () => {
    const a = await assistantApi.createThread({});
    const b = await assistantApi.createThread({});
    const sinks: Array<(event: AssistantEvent) => void> = [];
    setAssistantStreamConnector(async (_threadId, _afterId, onEvent, signal) => {
      sinks.push(onEvent);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await useAssistantStore.getState().openThread(a.id);
    await useAssistantStore.getState().openThread(b.id);
    sinks[0](ev('error', { message: 'from A' }, 1));
    expect(useAssistantStore.getState().error).toBeNull();
    sinks[1](ev('error', { message: 'from B' }, 1));
    expect(useAssistantStore.getState().error).toBe('from B');
  });
});
