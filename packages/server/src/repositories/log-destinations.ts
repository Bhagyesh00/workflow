/**
 * P6-62..66 (L3): the log streaming destinations of a workspace (`log_destinations`). `settings` holds the
 * type's fields without any secret; the secret fields are one `ctx.cipher.encrypt` payload in `secrets_enc`
 * (binding `logDestination:`), written by the service: this file never sees a plain secret and never returns
 * one to a caller that answers a request.
 * `listEnabledAcrossTenants` is frozen (L1 calls it). Every other query filters tenant_id with bound values.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type LogDestinationRow, logDestinations } from '../db/schema';
import { isUuid, now } from './util';

/** the columns a write may set (id, tenant id and the timestamps are the repository's) */
export type LogDestinationValues = Partial<
  Omit<LogDestinationRow, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>
>;

export class LogDestinationRepository {
  constructor(protected readonly db: DbOrTx) {}

  /**
   * system tooling (the event stream's tenant gate, L1): the enabled destinations of every tenant with their
   * subscriptions, as `WorkflowRepository.listActiveAcrossTenants`. Disabled rows are skipped. FULL (C0b).
   */
  async listEnabledAcrossTenants(): Promise<Array<{ tenantId: string; subscribedEvents: string[] }>> {
    return this.db
      .select({ tenantId: logDestinations.tenantId, subscribedEvents: logDestinations.subscribedEvents })
      .from(logDestinations)
      .where(eq(logDestinations.enabled, true));
  }

  /** the tenant's destinations, oldest first */
  async list(tenantId: string): Promise<LogDestinationRow[]> {
    if (!isUuid(tenantId)) return [];
    return this.db
      .select()
      .from(logDestinations)
      .where(eq(logDestinations.tenantId, tenantId))
      .orderBy(asc(logDestinations.createdAt), asc(logDestinations.id));
  }

  /** one destination of the tenant; undefined for another tenant's id, a non-uuid id or no row */
  async get(tenantId: string, id: string): Promise<LogDestinationRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(logDestinations)
      .where(and(eq(logDestinations.tenantId, tenantId), eq(logDestinations.id, id)))
      .limit(1);
    return row;
  }

  /** inserts a destination with the given id (the service needs the id for the secrets binding first) */
  async create(tenantId: string, id: string, values: LogDestinationValues): Promise<LogDestinationRow> {
    const [row] = await this.db
      .insert(logDestinations)
      .values({ ...values, id, tenantId } as typeof logDestinations.$inferInsert)
      .returning();
    return row as LogDestinationRow;
  }

  /** insert (no `id`) or update the tenant's destination `id` with `values`; an absent row throws */
  async save(
    tenantId: string,
    id: string | undefined,
    values: LogDestinationValues,
  ): Promise<LogDestinationRow> {
    if (id === undefined) {
      const [row] = await this.db
        .insert(logDestinations)
        .values({ ...values, tenantId } as typeof logDestinations.$inferInsert)
        .returning();
      return row as LogDestinationRow;
    }
    const [row] = await this.db
      .update(logDestinations)
      .set({ ...values, updatedAt: now() })
      .where(and(eq(logDestinations.tenantId, tenantId), eq(logDestinations.id, id)))
      .returning();
    if (!row) throw new Error('Log destination not found');
    return row;
  }

  /** removes the tenant's destination (its failed events go with it, fk cascade); false when absent */
  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(id)) return false;
    const removed = await this.db
      .delete(logDestinations)
      .where(and(eq(logDestinations.tenantId, tenantId), eq(logDestinations.id, id)))
      .returning({ id: logDestinations.id });
    return removed.length > 0;
  }

  /** records the last send error (already redacted and cut), or clears it with null */
  async setLastError(tenantId: string, id: string, error: string | null): Promise<void> {
    if (!isUuid(tenantId) || !isUuid(id)) return;
    await this.db
      .update(logDestinations)
      .set({ lastError: error })
      .where(and(eq(logDestinations.tenantId, tenantId), eq(logDestinations.id, id)));
  }
}
