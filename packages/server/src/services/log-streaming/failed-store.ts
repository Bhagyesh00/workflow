/**
 * P6-63 (S5 L7): events a destination could not take (a failed send or an open breaker), kept in
 * `log_stream_failed` and replayed when the breaker closes or the destination reloads; the Pruner drops old rows.
 * The event is stored as sent (already anonymized). A destination keeps at most 10000 rows and 50 MB of event
 * JSON (the oldest are dropped). `replay` sends in id order, 100 per batch, deletes each row on success and
 * stops at the first failure. Error text on a row passes `redactSecrets` and is cut to 1000 characters.
 */
import { redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { LOG_STREAM_FAILED_RETENTION_DAYS } from '../../repositories/log-stream-failed';
import type { StreamEvent } from '../events/stream';

export const FAILED_MAX_ROWS = 10_000;
export const FAILED_MAX_BYTES = 50 * 1024 * 1024;
export const FAILED_REPLAY_BATCH = 100;
export const FAILED_RETENTION_MS = LOG_STREAM_FAILED_RETENTION_DAYS * 86_400_000;

export interface FailedStoreLimits {
  maxRows: number;
  maxBytes: number;
}

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Send failed';
  return redactSecrets(text).slice(0, 1000);
};

export class FailedEventStore {
  constructor(
    readonly deps: ServiceDeps,
    private readonly limits: FailedStoreLimits = { maxRows: FAILED_MAX_ROWS, maxBytes: FAILED_MAX_BYTES },
  ) {}

  /** keeps one event for the destination, then drops the oldest rows beyond the row and byte caps */
  async add(tenantId: string, destinationId: string, event: StreamEvent, error: string): Promise<void> {
    const repo = this.deps.repos.logStreamFailed;
    await repo.add(
      tenantId,
      destinationId,
      event.id,
      event as unknown as Record<string, unknown>,
      errorText(error),
    );
    await repo.trim(tenantId, destinationId, this.limits.maxRows, this.limits.maxBytes);
  }

  /** sends the kept events oldest first, returns how many went out */
  async replay(
    tenantId: string,
    destinationId: string,
    send: (event: StreamEvent) => Promise<void>,
  ): Promise<number> {
    const repo = this.deps.repos.logStreamFailed;
    let sent = 0;
    for (;;) {
      const rows = await repo.listOldest(tenantId, destinationId, FAILED_REPLAY_BATCH);
      if (!rows.length) return sent;
      for (const row of rows) {
        try {
          await send(row.event as unknown as StreamEvent);
        } catch (error) {
          await repo.recordAttempt(tenantId, row.id, errorText(error));
          return sent;
        }
        await repo.remove(tenantId, [row.id]);
        sent += 1;
      }
      if (rows.length < FAILED_REPLAY_BATCH) return sent;
      // one batch per tick: let the sender loop and other work run between batches
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** removes rows older than the retention (7 days), returns how many */
  prune(now: Date): Promise<number> {
    return this.deps.repos.logStreamFailed.pruneBefore(new Date(now.getTime() - FAILED_RETENTION_MS));
  }
}
