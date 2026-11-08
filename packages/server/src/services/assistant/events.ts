/**
 * The Assistant's event log (P5-67, lane L1). Durable events go to `assistant_events` first (their id is
 * the SSE id), then live on `ctx.bus` channel `assistant:<tenantId>:<threadId>`; `text-delta` and
 * `status` are live only. A reconnect replays stored events after its cursor, then follows the live ones.
 * C0 stub with the final signatures; the constructor and `close` do not throw.
 */
import type { AssistantEvent } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';

/** the bus channel of one thread's live events */
export function assistantChannel(tenantId: string, threadId: string): string {
  return `assistant:${tenantId}:${threadId}`;
}

/** the bus channel a cancel crosses mains on (`{ tenantId, threadId }`) */
export const ASSISTANT_CANCEL_CHANNEL = 'assistant-cancel';

export class AssistantEventLog {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * Stores a durable event (then publishes it with its id) or only publishes a live one; the stored id,
   * null for a live-only event.
   */
  async append(_tenantId: string, _threadId: string, _event: AssistantEvent): Promise<number | null> {
    throw new Error('not implemented (L1)');
  }

  /** publishes a live-only event (`text-delta`, `status`); never stored */
  live(_tenantId: string, _threadId: string, _event: AssistantEvent): void {
    throw new Error('not implemented (L1)');
  }

  /** stored events after `afterId` in id order (at most `limit`), each with its `id` */
  async replay(
    _tenantId: string,
    _threadId: string,
    _afterId: number,
    _limit?: number,
  ): Promise<AssistantEvent[]> {
    throw new Error('not implemented (L1)');
  }

  /** follows the thread's live events; resolves with the unsubscribe function */
  async subscribe(
    _tenantId: string,
    _threadId: string,
    _onEvent: (event: AssistantEvent) => void,
  ): Promise<() => void> {
    throw new Error('not implemented (L1)');
  }

  /** drops every subscription (server close) */
  async close(): Promise<void> {}
}
