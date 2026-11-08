/**
 * Demo Assistant (P5-67, lane L2): the thread routes of `assistantApi` (api/endpoints.ts) on the in-memory
 * MockBackend and the scripted events of a turn. The demo has no model and no server stream: install.ts sets the
 * stream connector (`setAssistantStreamConnector`) to `demoAssistantStream(backend)`, which plays scripted events
 * for the thread instead of `GET /assistant/events/:threadId`.
 *
 * Routes (all under /rest): POST and GET `/assistant/threads`, PATCH and DELETE `/assistant/threads/:threadId`,
 * GET `.../messages`, GET `.../status`, POST `/assistant/chat/:threadId`, POST `/assistant/chat/:threadId/cancel`.
 *
 * The state sits in a WeakMap keyed by the backend (one per test and per demo session). Threads belong to one
 * user in one workspace; another user's thread is 404. Durable events get ids and are kept, so a reconnect or a
 * reload replays them; `text-delta` and `status` are live only. The script: a message about data tables lists
 * them and shows the first as an artifact, one about workflows does the same for workflows, anything else gets
 * a plain answer. `publishAssistantDemoEvent` lets other demo modules (cards, drafts) add events to a thread.
 */
import {
  type AssistantConfirmation,
  type AssistantEvent,
  type AssistantEventPayloads,
  type AssistantEventType,
  type AssistantMessageDTO,
  type AssistantRunStatus,
  type AssistantThreadDTO,
  type DataObject,
  isDurableAssistantEvent,
} from '@workflow/workflow';
import type { AssistantStreamConnector } from '../api/assistant-stream';
import type { MockBackend } from './mock-backend';
import { searchDataTables } from './mock-data-tables';
import { copy, HttpError, now } from './mock-http';

/** the title of a thread until its first message names it */
export const DEMO_ASSISTANT_TITLE = 'New chat';
/** characters of the first message that become the title (as the server) */
const TITLE_CHARS = 60;

interface DemoRun {
  id: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** tool calls of this run that have no result yet */
  openCalls: Map<string, string>;
}

export interface DemoAssistantThread extends AssistantThreadDTO {
  tenantId: string;
  userId: string;
  /** false until the first message names the thread */
  titled: boolean;
  messages: AssistantMessageDTO[];
  /** durable events with their ids, in order */
  events: AssistantEvent[];
  nextEventId: number;
  run: DemoRun | null;
  /** cards waiting for a person (other demo modules add them) */
  pending: AssistantConfirmation[];
}

export interface AssistantDemoState {
  threads: Map<string, DemoAssistantThread>;
  listeners: Map<string, Set<(event: AssistantEvent) => void>>;
  /** pause between two scripted events; tests set 0 (or a long one to stop a turn halfway) */
  stepMs: number;
}

const states = new WeakMap<MockBackend, AssistantDemoState>();
let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/** the demo Assistant state of one backend (created on first use) */
export function assistantDemoState(backend: MockBackend): AssistantDemoState {
  let state = states.get(backend);
  if (!state) {
    state = { threads: new Map(), listeners: new Map(), stepMs: 250 };
    states.set(backend, state);
  }
  return state;
}

function toDto(thread: DemoAssistantThread): AssistantThreadDTO {
  return { id: thread.id, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
}

/** the signed-in user's own thread (404 for anyone else's, as the server) */
function ownThread(backend: MockBackend, threadId: string): DemoAssistantThread {
  const { user, tenant } = backend.auth();
  const thread = assistantDemoState(backend).threads.get(threadId);
  if (!thread || thread.userId !== user.id || thread.tenantId !== tenant.id) {
    throw new HttpError(404, 'not_found', 'Thread not found');
  }
  return thread;
}

/**
 * Adds one event to a thread: a durable one gets the next id and is kept for replays; every listener of the
 * thread gets a copy. Returns the event as sent.
 */
export function publishAssistantDemoEvent<K extends AssistantEventType>(
  backend: MockBackend,
  threadId: string,
  type: K,
  payload: AssistantEventPayloads[K],
  runId: string | null = null,
): AssistantEvent {
  const state = assistantDemoState(backend);
  const thread = state.threads.get(threadId);
  const event = { type, runId, payload } as unknown as AssistantEvent;
  if (thread && isDurableAssistantEvent(type)) {
    event.id = thread.nextEventId;
    thread.nextEventId += 1;
    thread.events.push(copy(event));
  }
  for (const listener of state.listeners.get(threadId) ?? []) listener(copy(event));
  return event;
}

// ---- the script ----

type Step = (thread: DemoAssistantThread, run: DemoRun) => void;

function words(text: string, parts: number): string[] {
  const tokens = text.split(/(?<=\s)/);
  const size = Math.max(1, Math.ceil(tokens.length / parts));
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += size) out.push(tokens.slice(i, i + size).join(''));
  return out;
}

function saveAssistantMessage(
  backend: MockBackend,
  thread: DemoAssistantThread,
  run: DemoRun,
  text: string,
  toolCalls: Array<{ id: string; name: string; args: DataObject }> = [],
): Step[] {
  const messageId = nextId('msg');
  const steps: Step[] = words(text, 3).map(
    (piece) => () =>
      void publishAssistantDemoEvent(backend, thread.id, 'text-delta', { text: piece }, run.id),
  );
  steps.push(() => {
    thread.messages.push({
      id: messageId,
      runId: run.id,
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      summarized: false,
      createdAt: now(),
    });
    publishAssistantDemoEvent(backend, thread.id, 'text-block', { messageId, text }, run.id);
    for (const call of toolCalls) {
      run.openCalls.set(call.id, call.name);
      publishAssistantDemoEvent(
        backend,
        thread.id,
        'tool-call',
        { toolCallId: call.id, toolName: call.name, args: call.args },
        run.id,
      );
    }
  });
  return steps;
}

function saveToolResult(
  backend: MockBackend,
  thread: DemoAssistantThread,
  run: DemoRun,
  toolCallId: string,
  toolName: string,
  result: string,
): void {
  run.openCalls.delete(toolCallId);
  thread.messages.push({
    id: nextId('msg'),
    runId: run.id,
    role: 'tool',
    content: result,
    toolCallId,
    name: toolName,
    summarized: false,
    createdAt: now(),
  });
  publishAssistantDemoEvent(backend, thread.id, 'tool-result', { toolCallId, toolName, result }, run.id);
}

const PLAIN_ANSWER =
  'This is the demo Assistant. It has no model, so it answers with a script. Ask about your **workflows** ' +
  'or your **data tables** to see a tool run and a preview in the artifacts panel.';

/** the steps of one scripted turn for `message` */
function script(backend: MockBackend, thread: DemoAssistantThread, run: DemoRun, message: string): Step[] {
  const text = message.toLowerCase();
  const { tenant } = backend.auth();
  const steps: Step[] = [
    () => void publishAssistantDemoEvent(backend, thread.id, 'run-start', { resumed: false }, run.id),
  ];

  const tables = /\btables?\b/.test(text) ? searchDataTables('').results : [];
  const workflows = /\bworkflows?\b/.test(text)
    ? backend.workflows.filter((w) => w.tenantId === tenant.id && !w.isArchived)
    : [];
  const listed =
    tables.length > 0
      ? {
          tool: 'list_data_tables',
          rows: tables.map((t) => ({ id: String(t.value), name: t.name })),
          artifact: { type: 'data-table' as const, id: String(tables[0].value), name: tables[0].name },
          noun: 'data table',
        }
      : workflows.length > 0
        ? {
            tool: 'list_workflows',
            rows: workflows.map((w) => ({ id: w.id, name: w.name, active: w.active })),
            artifact: { type: 'workflow' as const, id: workflows[0].id, name: workflows[0].name },
            noun: 'workflow',
          }
        : null;

  if (!listed) {
    steps.push(...saveAssistantMessage(backend, thread, run, PLAIN_ANSWER));
    return steps;
  }
  const callId = nextId('call');
  steps.push(
    ...saveAssistantMessage(backend, thread, run, `Let me look at your ${listed.noun}s.`, [
      { id: callId, name: listed.tool, args: { limit: 20 } },
    ]),
  );
  steps.push(() =>
    saveToolResult(backend, thread, run, callId, listed.tool, JSON.stringify({ data: listed.rows })),
  );
  steps.push(
    () =>
      void publishAssistantDemoEvent(backend, thread.id, 'artifact', { artifact: listed.artifact }, run.id),
  );
  const count = listed.rows.length;
  steps.push(
    ...saveAssistantMessage(
      backend,
      thread,
      run,
      `You have ${count} ${listed.noun}${count === 1 ? '' : 's'}. I added **${listed.artifact.name}** to the ` +
        'artifacts panel, so you can preview it.',
    ),
  );
  return steps;
}

/** ends a run: open tool calls get an error result first, so no call is left without one */
function finishRun(backend: MockBackend, thread: DemoAssistantThread, status: AssistantRunStatus): void {
  const run = thread.run;
  if (!run) return;
  if (run.timer) clearTimeout(run.timer);
  run.timer = null;
  for (const [toolCallId, toolName] of run.openCalls) {
    const error = status === 'cancelled' ? 'Cancelled' : 'The run ended before the tool answered';
    thread.messages.push({
      id: nextId('msg'),
      runId: run.id,
      role: 'tool',
      content: error,
      toolCallId,
      name: toolName,
      summarized: false,
      createdAt: now(),
    });
    publishAssistantDemoEvent(backend, thread.id, 'tool-error', { toolCallId, toolName, error }, run.id);
  }
  run.openCalls.clear();
  thread.run = null;
  publishAssistantDemoEvent(backend, thread.id, 'run-finish', { status }, run.id);
}

function play(backend: MockBackend, thread: DemoAssistantThread, run: DemoRun, steps: Step[]): void {
  const state = assistantDemoState(backend);
  let index = 0;
  const next = () => {
    run.timer = null;
    if (thread.run !== run) return;
    const step = steps[index];
    index += 1;
    if (!step) {
      finishRun(backend, thread, 'completed');
      return;
    }
    step(thread, run);
    run.timer = setTimeout(next, state.stepMs);
  };
  run.timer = setTimeout(next, state.stepMs);
}

// ---- routes ----

/** P5-67: registers the demo Assistant's thread and chat routes. */
export function registerAssistantRoutes(backend: MockBackend): void {
  const state = assistantDemoState(backend);
  const feature = () => backend.options.assistant ?? { enabled: true, modelSet: true };
  const gate = () => {
    const auth = backend.auth();
    if (!feature().enabled) throw new HttpError(403, 'forbidden', 'The Assistant is off for this workspace');
    return auth;
  };

  backend.on('POST', '/assistant/threads', ({ body }) => {
    const { user, tenant } = gate();
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
    const at = now();
    const thread: DemoAssistantThread = {
      id: nextId('thread'),
      title: title ?? DEMO_ASSISTANT_TITLE,
      titled: title !== null,
      createdAt: at,
      updatedAt: at,
      tenantId: tenant.id,
      userId: user.id,
      messages: [],
      events: [],
      nextEventId: 1,
      run: null,
      pending: [],
    };
    state.threads.set(thread.id, thread);
    return toDto(thread);
  });

  backend.on('GET', '/assistant/threads', () => {
    const { user, tenant } = gate();
    const data = [...state.threads.values()]
      .filter((t) => t.userId === user.id && t.tenantId === tenant.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toDto);
    return { data, nextCursor: null };
  });

  backend.on('PATCH', '/assistant/threads/:threadId', ({ params, body }) => {
    gate();
    const thread = ownThread(backend, params[0]);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) throw new HttpError(400, 'bad_request', 'Give the chat a name');
    thread.title = title.slice(0, 200);
    thread.titled = true;
    thread.updatedAt = now();
    return toDto(thread);
  });

  backend.on('DELETE', '/assistant/threads/:threadId', ({ params }) => {
    gate();
    const thread = ownThread(backend, params[0]);
    finishRun(backend, thread, 'cancelled');
    state.threads.delete(thread.id);
    return { ok: true };
  });

  backend.on('GET', '/assistant/threads/:threadId/messages', ({ params }) => {
    gate();
    const thread = ownThread(backend, params[0]);
    return { messages: copy(thread.messages), nextEventId: thread.nextEventId };
  });

  backend.on('GET', '/assistant/threads/:threadId/status', ({ params }) => {
    gate();
    const thread = ownThread(backend, params[0]);
    return {
      hasActiveRun: thread.run !== null,
      isSuspended: thread.run === null && thread.pending.length > 0,
      pending: copy(thread.pending),
    };
  });

  backend.on('POST', '/assistant/chat/:threadId', ({ params, body }) => {
    gate();
    if (!feature().modelSet) throw new HttpError(400, 'bad_request', 'Set a model in Settings first');
    const thread = ownThread(backend, params[0]);
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) throw new HttpError(400, 'bad_request', 'Write a message first');
    if (thread.pending.length) throw new HttpError(409, 'conflict', 'Answer the request above first');
    if (thread.run) throw new HttpError(409, 'conflict', 'A run is already active for this thread');
    const files = Array.isArray(body.attachments)
      ? (body.attachments as Array<{ data?: unknown; mimeType?: unknown; fileName?: unknown }>)
      : [];
    thread.messages.push({
      id: nextId('msg'),
      runId: null,
      role: 'user',
      content: message,
      attachments: files.length
        ? files.map((file) => ({
            fileName: String(file.fileName ?? 'file'),
            mimeType: String(file.mimeType ?? 'application/octet-stream'),
            size: Math.floor((String(file.data ?? '').length * 3) / 4),
          }))
        : undefined,
      summarized: false,
      createdAt: now(),
    });
    thread.updatedAt = now();
    if (!thread.titled) {
      thread.titled = true;
      thread.title = message.trim().slice(0, TITLE_CHARS);
      publishAssistantDemoEvent(backend, thread.id, 'thread-title-updated', { title: thread.title });
    }
    const run: DemoRun = { id: nextId('run'), timer: null, openCalls: new Map() };
    thread.run = run;
    play(backend, thread, run, script(backend, thread, run, message));
    return { runId: run.id };
  });

  backend.on('POST', '/assistant/chat/:threadId/cancel', ({ params }) => {
    gate();
    const thread = ownThread(backend, params[0]);
    finishRun(backend, thread, 'cancelled');
    return { ok: true };
  });
}

/**
 * P5-67: the demo's thread stream for `backend`: the kept events after `afterId`, then live ones, until
 * `signal` aborts (it then resolves). A thread the signed-in user does not own rejects with its 404.
 */
export function demoAssistantStream(backend: MockBackend): AssistantStreamConnector {
  return (threadId, afterId, onEvent, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve();
      let thread: DemoAssistantThread;
      try {
        thread = ownThread(backend, threadId);
      } catch (error) {
        return reject(error);
      }
      const state = assistantDemoState(backend);
      let highest = afterId;
      const deliver = (event: AssistantEvent) => {
        if (signal.aborted) return;
        if (typeof event.id === 'number') {
          if (event.id <= highest) return;
          highest = event.id;
        }
        onEvent(event);
      };
      for (const event of thread.events) deliver(copy(event));
      let listeners = state.listeners.get(threadId);
      if (!listeners) {
        listeners = new Set();
        state.listeners.set(threadId, listeners);
      }
      const set = listeners;
      set.add(deliver);
      signal.addEventListener(
        'abort',
        () => {
          set.delete(deliver);
          resolve();
        },
        { once: true },
      );
    });
}
