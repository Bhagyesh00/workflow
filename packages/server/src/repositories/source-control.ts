/**
 * P6-73 (L2): the workspace's Git connection (`source_control_settings`, one row per tenant) and its lease. The
 * lease is `locked_until`: `tryLock` sets it only when null or past (one conditional update, no transaction held
 * over the network), `extendLock` and `unlock` match the `until` the holder set, so a caller whose lease expired
 * never moves or clears another caller's lease. The private key and the HTTPS token are stored only as
 * `ctx.cipher.encrypt` output (the service encrypts; this file never sees a plain secret). Every query filters
 * `tenant_id` with a bound value (the table is under RLS as well).
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type SourceControlSettingsRow, sourceControlSettings } from '../db/schema';
import { isUuid } from './util';

/** the columns a write may set (tenant id and `updatedAt` are the repository's) */
export type SourceControlSettingsValues = Partial<
  Omit<SourceControlSettingsRow, 'tenantId' | 'updatedAt' | 'lockedUntil'>
>;

export class SourceControlRepository {
  constructor(protected readonly db: DbOrTx) {}

  async get(tenantId: string): Promise<SourceControlSettingsRow | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select()
      .from(sourceControlSettings)
      .where(eq(sourceControlSettings.tenantId, tenantId));
    return row;
  }

  /** insert or update the tenant's row with `values` (the lease column is never written here) */
  async upsert(tenantId: string, values: SourceControlSettingsValues): Promise<SourceControlSettingsRow> {
    const [row] = await this.db
      .insert(sourceControlSettings)
      .values({ ...values, tenantId })
      .onConflictDoUpdate({
        target: sourceControlSettings.tenantId,
        set: { ...values, updatedAt: sql`now()` },
      })
      .returning();
    return row as SourceControlSettingsRow;
  }

  /**
   * drops the connection and the lease; `keepKeyPair` keeps the key type and both keys (n8n's disconnect body), else
   * the row goes (the next read starts from the defaults and makes a new key pair)
   */
  async clear(tenantId: string, options: { keepKeyPair?: boolean } = {}): Promise<void> {
    if (!isUuid(tenantId)) return;
    if (!options.keepKeyPair) {
      await this.db.delete(sourceControlSettings).where(eq(sourceControlSettings.tenantId, tenantId));
      return;
    }
    await this.db
      .update(sourceControlSettings)
      .set({
        repositoryUrl: null,
        connected: false,
        connectionType: 'ssh',
        branchName: 'main',
        branchColor: '#5296D6',
        httpsUsername: null,
        httpsPasswordEnc: null,
        hostKeyFingerprint: null,
        lockedUntil: null,
        updatedAt: sql`now()`,
      })
      .where(eq(sourceControlSettings.tenantId, tenantId));
  }

  /** sets `locked_until = until` when null or past (the database's clock); returns the `until` it set, or null when held */
  async tryLock(tenantId: string, until: Date): Promise<Date | null> {
    if (!isUuid(tenantId)) return null;
    const rows = await this.db
      .update(sourceControlSettings)
      .set({ lockedUntil: until })
      .where(
        and(
          eq(sourceControlSettings.tenantId, tenantId),
          or(isNull(sourceControlSettings.lockedUntil), lt(sourceControlSettings.lockedUntil, sql`now()`)),
        ),
      )
      .returning({ lockedUntil: sourceControlSettings.lockedUntil });
    return rows[0]?.lockedUntil ?? null;
  }

  /** moves the lease to `until` only while `locked_until = held`; false when the lease was lost */
  async extendLock(tenantId: string, held: Date, until: Date): Promise<boolean> {
    if (!isUuid(tenantId)) return false;
    const rows = await this.db
      .update(sourceControlSettings)
      .set({ lockedUntil: until })
      .where(and(eq(sourceControlSettings.tenantId, tenantId), eq(sourceControlSettings.lockedUntil, held)))
      .returning({ tenantId: sourceControlSettings.tenantId });
    return rows.length > 0;
  }

  /** clears the lease where `locked_until = held` (only the caller's own lease) */
  async unlock(tenantId: string, held: Date): Promise<void> {
    if (!isUuid(tenantId)) return;
    await this.db
      .update(sourceControlSettings)
      .set({ lockedUntil: null })
      .where(and(eq(sourceControlSettings.tenantId, tenantId), eq(sourceControlSettings.lockedUntil, held)));
  }
}
