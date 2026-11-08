/**
 * The Assistant's event log (P5-67, lane L1). Durable events go to `assistant_events` first (their id is
 * the SSE id), then live on `ctx.bus` channel `assistant:<tenantId>:<threadId>`; `text-delta` and
 * `status` are live only. A reconnect replays stored events after its cursor, then follows the live ones.
 * Every string of an event passes `redactSecrets` before it is stored or published.
 */
import { type AssistantEvent, isDurableAssistantEvent, redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';

/** the bus channel of one thread's live events */
export function assistantChannel(tenantId: string, threadId: string): string {
  return `assistant:${tenantId}:${threadId}`;
}

/** the bus channel a cancel crosses mains on (`{ tenantId, threadId }`) */
export const ASSISTANT_CANCEL_CHANNEL = 'assistant-cancel';

/** stored events read per page when a stream replays */
export const ASSISTANT_REPLAY_PAGE = 500;

/** every string inside `value` through `redactSecrets` (objects and arrays copied) */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(entry);
    return out as T;
  }
  return value;
}

/** an event as a client may see it: known type, every string redacted */
function cleanEvent(event: AssistantEvent): AssistantEvent {
  return {
    ...event,
    runId: event.runId ?? null,
    payload: redactDeep(event.payload),
  } as AssistantEvent;
}

export class AssistantEventLog {
  private readonly subscriptions = new Set<() => void>();

  constructor(readonly deps: ServiceDeps) {}

  /**
   * Stores a durable event (then publishes it with its id) or only publishes a live one; the stored id,
   * null for a live-only event.
   */
  async append(tenantId: string, threadId: string, event: AssistantEvent): Promise<number | null> {
    const clean = cleanEvent(event);
    if (!isDurableAssistantEvent(clean.type)) {
      this.live(tenantId, threadId, clean);
      return null;
    }
    const { id: _ignored, ...stored } = clean;
    const id = await this.deps.repos.assistantThreads.appendEvent(
      tenantId,
      threadId,
      clean.runId,
      stored as AssistantEvent,
    );
    await this.deps
      .context()
      .bus.publish(assistantChannel(tenantId, threadId), { ...stored, id })
      .catch(() => {});
    return id;
  }

  /** publishes a live-only event (`text-delta`, `status`); never stored */
  live(tenantId: string, threadId: string, event: AssistantEvent): void {
    const { id: _ignored, ...clean } = cleanEvent(event);
    void this.deps
      .context()
      .bus.publish(assistantChannel(tenantId, threadId), clean)
      .catch(() => {});
  }

  /** stored events after `afterId` in id order (at most `limit`), each with its `id` */
  async replay(
    tenantId: string,
    threadId: string,
    afterId: number,
    limit = ASSISTANT_REPLAY_PAGE,
  ): Promise<AssistantEvent[]> {
    const rows = await this.deps.repos.assistantThreads.listEvents(tenantId, threadId, afterId, limit);
    return rows.map((row) => ({ ...row.payload, runId: row.runId, id: Number(row.id) }) as AssistantEvent);
  }

  /** follows the thread's live events; resolves with the unsubscribe function */
  async subscribe(
    tenantId: string,
    threadId: string,
    onEvent: (event: AssistantEvent) => void,
  ): Promise<() => void> {
    const off = await this.deps.context().bus.subscribe(assistantChannel(tenantId, threadId), (message) => {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      try {
        onEvent(message as AssistantEvent);
      } catch {
        /* a failing listener must not break the bus */
      }
    });
    let done = false;
    const unsubscribe = () => {
      if (done) return;
      done = true;
      this.subscriptions.delete(unsubscribe);
      off();
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  /** drops every subscription (server close) */
  async close(): Promise<void> {
    for (const unsubscribe of [...this.subscriptions]) unsubscribe();
  }
}
