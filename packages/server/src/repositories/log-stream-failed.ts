/**
 * P6-63 (L7): events a destination could not take (`log_stream_failed`), kept per destination for a replay in
 * id order and pruned by age (7 days). The event is stored as sent (already anonymized), never with a secret.
 * Every query filters tenant_id with bound values, except the system-level `pruneBefore`.
 */
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type LogStreamFailedRow, logStreamFailed } from '../db/schema';

/** the Pruner drops failed events older than this many days */
export const LOG_STREAM_FAILED_RETENTION_DAYS = 7;

const ERROR_LIMIT = 1000;

/** Postgres refuses U+0000 in jsonb and text values (22P05, 22021); the live send path carries it, so it is replaced here */
const NUL = '\u0000';
const REPLACEMENT = '\ufffd';

function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes(NUL) ? value.split(NUL).join(REPLACEMENT) : value;
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[withoutNul(key) as string] = withoutNul(entry);
    return out;
  }
  return value;
}

/** the event as a jsonb value Postgres takes: a NUL character becomes U+FFFD, everything else is kept */
function storable(event: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(event).includes('\\u0000') ? (withoutNul(event) as Record<string, unknown>) : event;
}

const storableText = (text: string): string =>
  text.includes(NUL) ? text.split(NUL).join(REPLACEMENT) : text;

export class LogStreamFailedRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** stores one failed event of the tenant's destination */
  async add(
    tenantId: string,
    destinationId: string,
    eventId: string,
    event: Record<string, unknown>,
    lastError?: string | null,
  ): Promise<void> {
    await this.db.insert(logStreamFailed).values({
      tenantId,
      destinationId,
      eventId,
      event: storable(event),
      lastError: lastError == null ? null : storableText(lastError.slice(0, ERROR_LIMIT)),
    });
  }

  /** the oldest `limit` failed events of a destination, in id order */
  async listOldest(tenantId: string, destinationId: string, limit: number): Promise<LogStreamFailedRow[]> {
    return this.db
      .select()
      .from(logStreamFailed)
      .where(and(eq(logStreamFailed.tenantId, tenantId), eq(logStreamFailed.destinationId, destinationId)))
      .orderBy(asc(logStreamFailed.id))
      .limit(Math.max(0, Math.floor(limit)));
  }

  /** removes the given rows of the tenant (after a successful resend); returns how many */
  async remove(tenantId: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const rows = await this.db
      .delete(logStreamFailed)
      .where(and(eq(logStreamFailed.tenantId, tenantId), inArray(logStreamFailed.id, ids)))
      .returning({ id: logStreamFailed.id });
    return rows.length;
  }

  /** a resend failed: counts the attempt and keeps the (redacted) error on the row */
  async recordAttempt(tenantId: string, id: number, lastError: string): Promise<void> {
    await this.db
      .update(logStreamFailed)
      .set({
        attempts: sql`${logStreamFailed.attempts} + 1`,
        lastError: storableText(lastError.slice(0, ERROR_LIMIT)),
      })
      .where(and(eq(logStreamFailed.tenantId, tenantId), eq(logStreamFailed.id, id)));
  }

  /**
   * keeps a destination within `maxRows` rows and `maxBytes` bytes of event JSON by dropping the oldest rows:
   * the rows kept are the newest ones whose running row count and byte sum (newest first) stay within the caps,
   * so they are a suffix of the id order and one cut-off id (the lowest kept id) decides the delete;
   * returns how many rows went
   */
  async trim(tenantId: string, destinationId: string, maxRows: number, maxBytes: number): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM log_stream_failed
      WHERE tenant_id = ${tenantId} AND destination_id = ${destinationId}
        AND id < COALESCE((
          SELECT min(id) FROM (
            SELECT id,
              row_number() OVER (ORDER BY id DESC) AS position,
              sum(octet_length(event::text)) OVER (ORDER BY id DESC) AS running
            FROM log_stream_failed
            WHERE tenant_id = ${tenantId} AND destination_id = ${destinationId}
          ) ranked
          WHERE position <= ${maxRows} AND running <= ${maxBytes}
        ), 9223372036854775807)
    `);
    return result.rowCount ?? 0;
  }

  /**
   * keeps the newest `maxRows` rows of a destination by dropping the older ones; an index walk over ids, no event
   * is read, so it is cheap enough to run on every add; returns how many rows went
   */
  async trimRows(tenantId: string, destinationId: string, maxRows: number): Promise<number> {
    const keep = Math.max(1, Math.floor(maxRows));
    const result = await this.db.execute(sql`
      DELETE FROM log_stream_failed
      WHERE tenant_id = ${tenantId} AND destination_id = ${destinationId}
        AND id < COALESCE((
          SELECT id FROM log_stream_failed
          WHERE tenant_id = ${tenantId} AND destination_id = ${destinationId}
          ORDER BY id DESC OFFSET ${keep - 1} LIMIT 1
        ), 0)
    `);
    return result.rowCount ?? 0;
  }

  /** the row count and the event JSON bytes a destination holds (one scan: call it rarely) */
  async usage(tenantId: string, destinationId: string): Promise<{ rows: number; bytes: number }> {
    const result = await this.db.execute(sql`
      SELECT count(*)::int AS rows, coalesce(sum(octet_length(event::text)), 0)::float8 AS bytes
      FROM log_stream_failed
      WHERE tenant_id = ${tenantId} AND destination_id = ${destinationId}
    `);
    const row = result.rows[0] as { rows: number; bytes: number } | undefined;
    return { rows: Number(row?.rows ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /** removes every row created before `before` (the Pruner's 7 day rule); returns how many */
  async pruneBefore(before: Date): Promise<number> {
    const rows = await this.db
      .delete(logStreamFailed)
      .where(lt(logStreamFailed.createdAt, before))
      .returning({ id: logStreamFailed.id });
    return rows.length;
  }
}
