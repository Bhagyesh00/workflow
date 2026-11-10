/**
 * P6-12 (L10): the LDAP sync history (`auth_provider_sync_history`), one row per sync run, and the two
 * reads the sync needs beside it: the workspace's LDAP identities with their membership state, and (for the
 * leader sweep) the workspaces whose sync is on. Every tenant query filters `tenant_id` with a bound value;
 * `dueTenants` and `failStale` are system-level (they say so below) and return no user data.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type AuthProviderSyncHistoryRow,
  authIdentities,
  authProviderSyncHistory,
  memberships,
  tenantAuthSettings,
} from '../db/schema';
import { isUuid } from './util';

export interface SyncRunCounts {
  scanned: number;
  created: number;
  updated: number;
  disabled: number;
}

/** one LDAP identity of a workspace with the state of its membership */
export interface LdapIdentityState {
  providerId: string;
  userId: string;
  /** the membership is disabled */
  disabled: boolean;
}

export class LdapHistoryRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** a run that has started (status `running`); the row */
  async start(
    tenantId: string,
    input: { providerType: string; runMode: string },
  ): Promise<AuthProviderSyncHistoryRow> {
    const [row] = await this.db
      .insert(authProviderSyncHistory)
      .values({ tenantId, providerType: input.providerType, runMode: input.runMode, status: 'running' })
      .returning();
    return row;
  }

  /** ends a run with its status, counts and error text (never a secret) */
  async finish(
    tenantId: string,
    id: string,
    result: SyncRunCounts & { status: string; error?: string | null },
  ): Promise<void> {
    if (!isUuid(id)) return;
    await this.db
      .update(authProviderSyncHistory)
      .set({
        status: result.status,
        endedAt: sql`now()`,
        scanned: result.scanned,
        created: result.created,
        updated: result.updated,
        disabled: result.disabled,
        error: result.error ?? null,
      })
      .where(and(eq(authProviderSyncHistory.tenantId, tenantId), eq(authProviderSyncHistory.id, id)));
  }

  async get(tenantId: string, id: string): Promise<AuthProviderSyncHistoryRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(authProviderSyncHistory)
      .where(and(eq(authProviderSyncHistory.tenantId, tenantId), eq(authProviderSyncHistory.id, id)));
    return row;
  }

  /** newest first */
  async list(
    tenantId: string,
    options: { providerType?: string; take: number; skip: number },
  ): Promise<AuthProviderSyncHistoryRow[]> {
    if (!isUuid(tenantId)) return [];
    return this.db
      .select()
      .from(authProviderSyncHistory)
      .where(
        and(
          eq(authProviderSyncHistory.tenantId, tenantId),
          options.providerType ? eq(authProviderSyncHistory.providerType, options.providerType) : undefined,
        ),
      )
      .orderBy(desc(authProviderSyncHistory.startedAt), desc(authProviderSyncHistory.id))
      .limit(options.take)
      .offset(options.skip);
  }

  /** the newest run of the provider type (the sweep reads when a workspace is due) */
  async latest(tenantId: string, providerType: string): Promise<AuthProviderSyncHistoryRow | undefined> {
    const [row] = await this.list(tenantId, { providerType, take: 1, skip: 0 });
    return row;
  }

  async deleteForTenant(tenantId: string, providerType: string): Promise<number> {
    if (!isUuid(tenantId)) return 0;
    const rows = await this.db
      .delete(authProviderSyncHistory)
      .where(
        and(
          eq(authProviderSyncHistory.tenantId, tenantId),
          eq(authProviderSyncHistory.providerType, providerType),
        ),
      )
      .returning({ id: authProviderSyncHistory.id });
    return rows.length;
  }

  /** the workspace's LDAP identities, each with whether its membership is disabled */
  async identities(tenantId: string): Promise<LdapIdentityState[]> {
    if (!isUuid(tenantId)) return [];
    const rows = await this.db
      .select({
        providerId: authIdentities.providerId,
        userId: authIdentities.userId,
        disabledAt: memberships.disabledAt,
      })
      .from(authIdentities)
      .innerJoin(
        memberships,
        and(eq(memberships.tenantId, authIdentities.tenantId), eq(memberships.userId, authIdentities.userId)),
      )
      .where(and(eq(authIdentities.tenantId, tenantId), eq(authIdentities.providerType, 'ldap')));
    return rows.map((row) => ({
      providerId: row.providerId,
      userId: row.userId,
      disabled: row.disabledAt !== null,
    }));
  }

  /**
   * System-level (the leader sweep): the workspaces whose LDAP login is on and whose sync is turned on, with
   * the interval in minutes the config holds (the service clamps it).
   */
  async dueTenants(): Promise<Array<{ tenantId: string; intervalMinutes: number }>> {
    const rows = await this.db
      .select({
        tenantId: tenantAuthSettings.tenantId,
        interval: sql<string | null>`${tenantAuthSettings.ldap} ->> 'synchronizationInterval'`,
      })
      .from(tenantAuthSettings)
      .where(
        and(
          eq(tenantAuthSettings.method, 'ldap'),
          sql`${tenantAuthSettings.ldap} ->> 'synchronizationEnabled' = 'true'`,
        ),
      );
    return rows.map((row) => ({ tenantId: row.tenantId, intervalMinutes: Number(row.interval) || 60 }));
  }

  /**
   * System-level: a run that never finished (the process stopped) becomes an error row once it is older
   * than `olderThan`, so the next run is not refused for ever. Returns how many rows changed.
   */
  async failStale(olderThan: Date): Promise<number> {
    const rows = await this.db
      .update(authProviderSyncHistory)
      .set({ status: 'error', endedAt: sql`now()`, error: 'The sync stopped before it finished' })
      .where(
        and(eq(authProviderSyncHistory.status, 'running'), lt(authProviderSyncHistory.startedAt, olderThan)),
      )
      .returning({ id: authProviderSyncHistory.id });
    return rows.length;
  }
}
