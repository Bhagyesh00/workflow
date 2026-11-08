/**
 * P5-67: a thread's events, `GET /rest/assistant/events/:threadId?lastEventId=<n>`, read as server-sent events
 * through `fetch` with the tenant header (the browser's built-in SSE client cannot send headers). The demo
 * build has no server: it swaps the connector (`setAssistantStreamConnector` in demo/install.ts) for scripted
 * events.
 *
 * The server stream: its own small SSE parser (`data:` lines hold one JSON event, `id:` the stored event's id,
 * comments and pings are skipped), each id once (a bounded set of delivered ids: two writers of one thread
 * can send id N after N+1), reconnect with backoff from the highest id seen, stop on abort. An answer that cannot get better by retrying (401, 403, 404, 409, 400) ends the
 * stream with an `ApiError`; a network failure, a 429 or a 5xx retries.
 */
import { ASSISTANT_EVENT_TYPES, type AssistantEvent, isDurableAssistantEvent } from '@workflow/workflow';
import { ApiError, buildUrl, getCurrentTenant } from './client';

/**
 * Streams the events of `threadId` after event id `afterId` and calls `onEvent` for each one until `signal`
 * aborts. Durable events carry their id; live-only ones (`text-delta`, `status`) carry none.
 */
export type AssistantStreamConnector = (
  threadId: string,
  afterId: number,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

let connector: AssistantStreamConnector | null = null;

/** how many delivered event ids a stream (and the thread state) remembers to drop a replay */
export const ASSISTANT_DELIVERED_IDS = 1000;

/** Replace the stream (the demo's seam); `null` goes back to the server stream. */
export function setAssistantStreamConnector(next: AssistantStreamConnector | null): void {
  connector = next;
}

/** the connector set last, or null for the server stream */
export function getAssistantStreamConnector(): AssistantStreamConnector | null {
  return connector;
}

/** reconnect delays of the server stream: doubled after each failed try, from `initialMs` up to `maxMs` */
export interface AssistantStreamRetry {
  initialMs: number;
  maxMs: number;
}

const DEFAULT_RETRY: AssistantStreamRetry = { initialMs: 1000, maxMs: 30000 };
let retry: AssistantStreamRetry = { ...DEFAULT_RETRY };

/** Sets the reconnect delays (tests shorten them); `null` restores the defaults. */
export function setAssistantStreamRetry(next: AssistantStreamRetry | null): void {
  retry = next ? { ...next } : { ...DEFAULT_RETRY };
}

/** the delay before reconnect try `attempt` (0 for the first) */
export function assistantStreamDelay(attempt: number): number {
  return Math.min(retry.maxMs, retry.initialMs * 2 ** Math.max(0, attempt));
}

const KNOWN_TYPES: readonly string[] = ASSISTANT_EVENT_TYPES;
/** answers a retry cannot fix */
const FINAL_STATUSES = new Set([400, 401, 403, 404, 409, 410, 413]);

/** one SSE frame as an event; a frame without JSON data or with an unknown type is skipped */
export function parseAssistantFrame(data: string, sseId: string | null): AssistantEvent | null {
  if (!data.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<AssistantEvent> & Record<string, unknown>;
  if (typeof event.type !== 'string' || !KNOWN_TYPES.includes(event.type)) return null;
  if (!event.payload || typeof event.payload !== 'object') return null;
  const out = { ...event, runId: typeof event.runId === 'string' ? event.runId : null } as AssistantEvent;
  if (typeof out.id !== 'number' || !Number.isFinite(out.id)) {
    delete out.id;
    const frameId = sseId === null ? Number.NaN : Number(sseId);
    if (isDurableAssistantEvent(out.type) && Number.isFinite(frameId)) out.id = frameId;
  }
  return out;
}

/**
 * A small SSE parser: feed it decoded text, it calls `onFrame(data, id)` for each frame ended by a blank line.
 * Lines end with LF, CRLF or CR; `:` lines are comments; several `data:` lines join with LF.
 */
export function createSseParser(onFrame: (data: string, id: string | null) => void) {
  let buffer = '';
  let data: string[] = [];
  let id: string | null = null;
  let sawCr = false;

  const line = (text: string) => {
    if (text === '') {
      if (data.length) onFrame(data.join('\n'), id);
      data = [];
      id = null;
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  };

  return {
    push(chunk: string) {
      let text = chunk;
      // a CRLF split across two chunks: the LF belongs to the CR already handled
      if (sawCr && text.startsWith('\n')) text = text.slice(1);
      sawCr = false;
      buffer += text;
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match) break;
        if (match[0] === '\r' && match.index === buffer.length - 1) {
          sawCr = true;
        }
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
    /** the end of the body: a last frame without its blank line is dropped, as a browser SSE client does */
    end() {
      buffer = '';
      data = [];
      id = null;
      sawCr = false;
    },
  };
}

async function failureOf(response: Response): Promise<ApiError> {
  type Envelope = { error?: { code?: string; message?: string; details?: unknown } };
  let body: Envelope | null = null;
  try {
    body = (await response.json()) as Envelope | null;
  } catch {
    body = null;
  }
  return new ApiError(
    response.status,
    body?.error?.code ?? `http_${response.status}`,
    body?.error?.message ?? `Request failed with status ${response.status}`,
    body?.error?.details,
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error as Error | null)?.name === 'AbortError';
}

/**
 * One connection: reads frames until the body ends. Returns whether any frame arrived (a healthy connection
 * resets the backoff); throws an `ApiError` for an answer a retry cannot fix.
 */
async function connectOnce(
  threadId: string,
  afterId: number,
  deliver: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const headers: Record<string, string> = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
  const tenantId = getCurrentTenant();
  if (tenantId) headers['x-tenant-id'] = tenantId;
  if (afterId > 0) headers['last-event-id'] = String(afterId);
  const url = buildUrl(`/assistant/events/${encodeURIComponent(threadId)}`, { lastEventId: afterId });
  const response = await fetch(url, { method: 'GET', credentials: 'same-origin', headers, signal });
  if (!response.ok) {
    const failure = await failureOf(response);
    if (FINAL_STATUSES.has(response.status)) throw failure;
    return false;
  }
  let received = false;
  const parser = createSseParser((data, id) => {
    received = true;
    const event = parseAssistantFrame(data, id);
    if (event && !signal.aborted) deliver(event);
  });
  const reader = response.body?.getReader();
  if (!reader) {
    parser.push(await response.text());
    parser.end();
    return received;
  }
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } finally {
    parser.end();
  }
  return received;
}

/** the server stream: reconnects from the highest id seen until `signal` aborts */
async function serverStream(
  threadId: string,
  afterId: number,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  // the reconnect cursor only: two writers of one thread can send id N after N+1
  const floor = Number.isFinite(afterId) ? afterId : 0;
  let highest = floor;
  const delivered = new Set<number>();
  const deliver = (event: AssistantEvent) => {
    if (typeof event.id === 'number') {
      // the caller holds it already, or a replay of an event already delivered
      if (event.id <= floor || delivered.has(event.id)) return;
      delivered.add(event.id);
      if (delivered.size > ASSISTANT_DELIVERED_IDS) {
        delivered.delete(delivered.values().next().value as number);
      }
      highest = Math.max(highest, event.id);
    }
    onEvent(event);
  };
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const healthy = await connectOnce(threadId, highest, deliver, signal);
      if (healthy) attempt = 0;
    } catch (error) {
      if (isAbort(error, signal)) return;
      if (error instanceof ApiError) throw error;
      // network failure: try again after the delay
    }
    if (signal.aborted) return;
    await wait(assistantStreamDelay(attempt), signal);
    attempt += 1;
  }
}

/** Streams a thread's events: through the connector when one is set, else from the server. */
export function streamAssistantEvents(
  threadId: string,
  afterId: number,
  onEvent: (event: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return (connector ?? serverStream)(threadId, afterId, onEvent, signal);
}
