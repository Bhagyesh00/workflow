/**
 * External secret connections (P4-07). Every method takes the tenant first, except the one
 * system-level read the manager's startup load uses, which says so. `settingsEnc` is ciphertext; only
 * the manager decrypts it.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { credentials, type SecretConnectionRow, secretConnections } from '../db/schema';
import { isUuid, now } from './util';

export type SecretConnectionInsert = Pick<
  SecretConnectionRow,
  'id' | 'providerKey' | 'type' | 'settingsEnc' | 'isEnabled' | 'createdBy'
>;

export type SecretConnectionPatch = Partial<
  Pick<SecretConnectionRow, 'type' | 'settingsEnc' | 'isEnabled' | 'state' | 'lastError'>
>;

export class SecretConnectionRepository {
  constructor(readonly db: DbOrTx) {}

  async list(tenantId: string): Promise<SecretConnectionRow[]> {
    return this.db
      .select()
      .from(secretConnections)
      .where(eq(secretConnections.tenantId, tenantId))
      .orderBy(asc(secretConnections.providerKey));
  }

  async get(tenantId: string, providerKey: string): Promise<SecretConnectionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(secretConnections)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)));
    return row;
  }

  async create(tenantId: string, row: SecretConnectionInsert): Promise<SecretConnectionRow> {
    const [created] = await this.db
      .insert(secretConnections)
      .values({ ...row, tenantId, createdAt: now(), updatedAt: now() })
      .returning();
    return created;
  }

  /**
   * `updatedAt` moves only for what an admin changed: other processes compare it to see whether their
   * copy is old, and a state or lastError write of their own must not look like a change.
   */
  async update(
    tenantId: string,
    providerKey: string,
    patch: SecretConnectionPatch,
  ): Promise<SecretConnectionRow | undefined> {
    const changed =
      patch.type !== undefined || patch.settingsEnc !== undefined || patch.isEnabled !== undefined;
    const [row] = await this.db
      .update(secretConnections)
      .set(changed ? { ...patch, updatedAt: now() } : patch)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)))
      .returning();
    return row;
  }

  /** true when a row went */
  async delete(tenantId: string, providerKey: string): Promise<boolean> {
    const rows = await this.db
      .delete(secretConnections)
      .where(and(eq(secretConnections.tenantId, tenantId), eq(secretConnections.providerKey, providerKey)))
      .returning({ id: secretConnections.id });
    return rows.length > 0;
  }

  /** credentials whose secret_keys hold this connection, for the delete warning */
  async countCredentialsUsing(tenantId: string, providerKey: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), sql`${providerKey} = ANY(${credentials.secretKeys})`));
    return row?.count ?? 0;
  }

  /** what a credential refers to; its data and `updatedAt` stay as they are */
  async setCredentialSecretKeys(tenantId: string, credentialId: string, keys: string[]): Promise<void> {
    if (!isUuid(credentialId)) return;
    await this.db
      .update(credentials)
      .set({ secretKeys: keys })
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.id, credentialId)));
  }

  /** System-level: every tenant's enabled connections, for the load before jobs start. */
  async listAllEnabled(): Promise<SecretConnectionRow[]> {
    return this.db.select().from(secretConnections).where(eq(secretConnections.isEnabled, true));
  }
}
