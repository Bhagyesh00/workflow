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
      event,
      lastError: lastError == null ? null : lastError.slice(0, ERROR_LIMIT),
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
      .set({ attempts: sql`${logStreamFailed.attempts} + 1`, lastError: lastError.slice(0, ERROR_LIMIT) })
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

  /** removes every row created before `before` (the Pruner's 7 day rule); returns how many */
  async pruneBefore(before: Date): Promise<number> {
    const rows = await this.db
      .delete(logStreamFailed)
      .where(lt(logStreamFailed.createdAt, before))
      .returning({ id: logStreamFailed.id });
    return rows.length;
  }
}
