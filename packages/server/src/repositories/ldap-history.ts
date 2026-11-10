/**
 * P6-12 (L10): the LDAP sync history (`auth_provider_sync_history`), one row per sync run. Stub from C0;
 * L10 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { AuthProviderSyncHistoryRow } from '../db/schema';

export interface SyncRunCounts {
  scanned: number;
  created: number;
  updated: number;
  disabled: number;
}

export class LdapHistoryRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** a run that has started; the row */
  async start(
    _tenantId: string,
    _input: { providerType: string; runMode: string },
  ): Promise<AuthProviderSyncHistoryRow> {
    throw new Error('not implemented (L10)');
  }

  /** ends a run with its status, counts and error text (never a secret) */
  async finish(
    _tenantId: string,
    _id: string,
    _result: SyncRunCounts & { status: string; error?: string | null },
  ): Promise<void> {
    throw new Error('not implemented (L10)');
  }

  /** newest first */
  async list(
    _tenantId: string,
    _options: { providerType?: string; take: number; skip: number },
  ): Promise<AuthProviderSyncHistoryRow[]> {
    throw new Error('not implemented (L10)');
  }

  /** the newest run of the provider type (the sweep reads when a workspace is due) */
  async latest(_tenantId: string, _providerType: string): Promise<AuthProviderSyncHistoryRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  async deleteForTenant(_tenantId: string, _providerType: string): Promise<number> {
    throw new Error('not implemented (L10)');
  }
}
