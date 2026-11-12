/**
 * P6-62..66 (L3): the log streaming destinations of a workspace (`log_destinations`). `settings` holds the
 * type's fields without any secret; the secret fields are one `ctx.cipher.encrypt` payload in `secrets_enc`
 * (binding `logDestination:`), written by the service: this file never sees a plain secret and never returns
 * one to a caller that answers a request.
 * stub (L3): the constructor and `listEnabledAcrossTenants` (FULL, frozen: L1 calls it) pass, every other
 * method throws.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type LogDestinationRow, logDestinations } from '../db/schema';

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

  /** stub (L3): the tenant's destinations, oldest first */
  list(_tenantId: string): Promise<LogDestinationRow[]> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): one destination of the tenant; undefined for another tenant's id or no row */
  get(_tenantId: string, _id: string): Promise<LogDestinationRow | undefined> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): insert (no `id`) or update the tenant's destination `id` with `values` */
  save(
    _tenantId: string,
    _id: string | undefined,
    _values: LogDestinationValues,
  ): Promise<LogDestinationRow> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): removes the tenant's destination (its failed events go with it, fk cascade); false when absent */
  delete(_tenantId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): records the last send error (already redacted and cut), or clears it with null */
  setLastError(_tenantId: string, _id: string, _error: string | null): Promise<void> {
    throw new Error('not implemented (L3)');
  }
}
