/**
 * P6-63 (S5 L7): events a destination could not take (a failed send or an open breaker), kept in
 * `log_stream_failed` and replayed when the breaker closes or the destination reloads; the Pruner drops old rows.
 * The event is stored as sent (already anonymized). A destination keeps at most 10000 rows and 50 MB of event
 * JSON (the oldest are dropped): the row cap is enforced on every add by an index walk, the byte cap from a running
 * tally per destination (a scan of the stored JSON only when the tally passes the cap, to 90% of it, and every
 * 500 adds to take in other processes). `replay` runs in one process at a time per destination (a Postgres advisory
 * lock held on its own connection, gone with the connection), sends in id order, 100 per batch, deletes each row on
 * success, stops at the first failure and stops when the caller says so (a destination turned off or deleted).
 * Error text on a row is scrubbed of the destination's secret values and of any scheme://... run, passes
 * `redactSecrets` and is cut to 1000 characters.
 */
import { redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import { LOG_STREAM_FAILED_RETENTION_DAYS } from '../../repositories/log-stream-failed';
import type { StreamEvent } from '../events/stream';

export const FAILED_MAX_ROWS = 10_000;
export const FAILED_MAX_BYTES = 50 * 1024 * 1024;
export const FAILED_REPLAY_BATCH = 100;
export const FAILED_RETENTION_MS = LOG_STREAM_FAILED_RETENTION_DAYS * 86_400_000;
/** a byte trim goes down to this share of the cap, so a store at its cap does not scan on every add */
const BYTES_LOW_WATER = 0.9;
/** the byte tally is read from the table again after this many adds (other processes add and replay too) */
const TALLY_RESYNC_ADDS = 500;

export interface FailedStoreLimits {
  maxRows: number;
  maxBytes: number;
}

export interface ReplayOptions {
  /** checked before each batch and each send: true ends the replay at once, nothing is recorded */
  shouldStop?: () => boolean;
  /** the destination's secret values, scrubbed out of the error text kept on a row */
  secretValues?: string[];
}

const SCHEME_RUN = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;

const errorText = (error: unknown, secretValues: string[] = []): string => {
  let text = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Send failed';
  for (const value of secretValues) if (value) text = text.split(value).join('[redacted]');
  return redactSecrets(text.replace(SCHEME_RUN, '[redacted]')).slice(0, 1000);
};

interface Tally {
  bytes: number;
  adds: number;
}

export class FailedEventStore {
  /** per destination: the event JSON bytes this process believes the table holds */
  private readonly tallies = new Map<string, Tally>();
  /** the destinations this process is replaying now */
  private readonly replaying = new Set<string>();

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
    await repo.trimRows(tenantId, destinationId, this.limits.maxRows);
    await this.trimBytes(tenantId, destinationId, Buffer.byteLength(JSON.stringify(event)));
  }

  private async trimBytes(tenantId: string, destinationId: string, size: number): Promise<void> {
    const repo = this.deps.repos.logStreamFailed;
    let tally = this.tallies.get(destinationId);
    if (tally) {
      tally.bytes += size;
      tally.adds += 1;
      if (tally.adds >= TALLY_RESYNC_ADDS) tally = undefined;
    }
    if (!tally) {
      // the first add of this process, or a resync: one scan of the stored JSON
      tally = { bytes: (await repo.usage(tenantId, destinationId)).bytes, adds: 0 };
      this.tallies.set(destinationId, tally);
    }
    if (tally.bytes <= this.limits.maxBytes) return;
    await repo.trim(
      tenantId,
      destinationId,
      this.limits.maxRows,
      Math.floor(this.limits.maxBytes * BYTES_LOW_WATER),
    );
    this.tallies.set(destinationId, {
      bytes: (await repo.usage(tenantId, destinationId)).bytes,
      adds: 0,
    });
  }

  /**
   * sends the kept events oldest first, returns how many went out. One process replays a destination at a time:
   * a replay that does not win the lock (another process, or this one, is replaying it) returns 0.
   */
  async replay(
    tenantId: string,
    destinationId: string,
    send: (event: StreamEvent) => Promise<void>,
    options: ReplayOptions = {},
  ): Promise<number> {
    if (this.replaying.has(destinationId)) return 0;
    this.replaying.add(destinationId);
    const key = `log-stream-replay:${destinationId}`;
    const client = await this.deps.database.pool.connect().catch((error: unknown) => {
      this.replaying.delete(destinationId);
      throw error;
    });
    let locked = false;
    try {
      const won = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS won', [key]);
      locked = won.rows[0]?.won === true;
      if (!locked) return 0;
      return await this.replayLocked(tenantId, destinationId, send, options);
    } finally {
      let released = !locked;
      if (locked) {
        released = await client
          .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .then(() => true)
          .catch(() => false);
      }
      // a connection that could not unlock is closed, which drops the lock
      client.release(!released);
      this.replaying.delete(destinationId);
      // rows went: the byte tally is read again on the next add
      this.tallies.delete(destinationId);
    }
  }

  private async replayLocked(
    tenantId: string,
    destinationId: string,
    send: (event: StreamEvent) => Promise<void>,
    options: ReplayOptions,
  ): Promise<number> {
    const repo = this.deps.repos.logStreamFailed;
    const stop = options.shouldStop ?? (() => false);
    let sent = 0;
    for (;;) {
      if (stop()) return sent;
      const rows = await repo.listOldest(tenantId, destinationId, FAILED_REPLAY_BATCH);
      if (!rows.length) return sent;
      for (const row of rows) {
        if (stop()) return sent;
        try {
          await send(row.event as unknown as StreamEvent);
        } catch (error) {
          if (stop()) return sent;
          await repo.recordAttempt(tenantId, row.id, errorText(error, options.secretValues));
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
