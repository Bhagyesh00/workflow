/**
 * P6-73 (L2): the workspace's Git connection (`source_control_settings`, one row per tenant) and its lease. The
 * lease is `locked_until`: `tryLock` sets it only when null or past (one conditional update, no transaction held
 * over the network), `extendLock` and `unlock` match the `until` the holder set, so a caller whose lease expired
 * never moves or clears another caller's lease. The private key and the HTTPS token are stored only as
 * `ctx.cipher.encrypt` output (the service encrypts; this file never sees a plain secret).
 * stub (L2): the constructor passes, every method throws.
 */
import type { DbOrTx } from '../db/client';
import type { SourceControlSettingsRow } from '../db/schema';

/** the columns a write may set (tenant id and `updatedAt` are the repository's) */
export type SourceControlSettingsValues = Partial<
  Omit<SourceControlSettingsRow, 'tenantId' | 'updatedAt' | 'lockedUntil'>
>;

export class SourceControlRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** stub (L2) */
  get(_tenantId: string): Promise<SourceControlSettingsRow | undefined> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): insert or update the tenant's row with `values` */
  upsert(_tenantId: string, _values: SourceControlSettingsValues): Promise<SourceControlSettingsRow> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): drop the connection; `keepKeyPair` keeps the key type and both keys (n8n's disconnect body) */
  clear(_tenantId: string, _options?: { keepKeyPair?: boolean }): Promise<void> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): sets `locked_until = until` when null or past; returns the `until` it set, or null when held */
  tryLock(_tenantId: string, _until: Date): Promise<Date | null> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): moves the lease to `until` only while `locked_until = held`; false when the lease was lost */
  extendLock(_tenantId: string, _held: Date, _until: Date): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** stub (L2): clears the lease where `locked_until = held` (only the caller's own lease) */
  unlock(_tenantId: string, _held: Date): Promise<void> {
    throw new Error('not implemented (L2)');
  }
}
