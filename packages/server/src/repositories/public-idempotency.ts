/**
 * P6-82 (L15): `public_api_idempotency` (migration 0034), primary key (tenant_id, user_id, key). Every query
 * filters tenant_id, except the system-level prune. `responseEnc` holds the `CredentialCipher` text only.
 */
import { and, eq, lt } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type PublicApiIdempotencyRow, publicApiIdempotency } from '../db/schema';

const rowOf = (tenantId: string, userId: string, key: string) =>
  and(
    eq(publicApiIdempotency.tenantId, tenantId),
    eq(publicApiIdempotency.userId, userId),
    eq(publicApiIdempotency.key, key),
  );

export class PublicIdempotencyRepository {
  constructor(protected readonly db: DbOrTx) {}

  async get(tenantId: string, userId: string, key: string): Promise<PublicApiIdempotencyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(publicApiIdempotency)
      .where(rowOf(tenantId, userId, key));
    return row;
  }

  /** inserts `in_progress`; false when a row of that key exists */
  async claim(tenantId: string, userId: string, key: string, fingerprint: string): Promise<boolean> {
    const rows = await this.db
      .insert(publicApiIdempotency)
      .values({ tenantId, userId, key, fingerprint, status: 'in_progress' })
      .onConflictDoNothing()
      .returning({ key: publicApiIdempotency.key });
    return rows.length > 0;
  }

  async finish(
    tenantId: string,
    userId: string,
    key: string,
    input: { statusCode: number; responseEnc: string },
  ): Promise<void> {
    await this.db
      .update(publicApiIdempotency)
      .set({ status: 'done', statusCode: input.statusCode, responseEnc: input.responseEnc })
      .where(rowOf(tenantId, userId, key));
  }

  async release(tenantId: string, userId: string, key: string): Promise<void> {
    await this.db.delete(publicApiIdempotency).where(rowOf(tenantId, userId, key));
  }

  /** the row of that user and key when it is older than `before` */
  async deleteExpired(tenantId: string, userId: string, key: string, before: Date): Promise<boolean> {
    const rows = await this.db
      .delete(publicApiIdempotency)
      .where(and(rowOf(tenantId, userId, key), lt(publicApiIdempotency.createdAt, before)))
      .returning({ key: publicApiIdempotency.key });
    return rows.length > 0;
  }

  /** system level: rows older than `before`, across tenants */
  async prune(before: Date): Promise<number> {
    const rows = await this.db
      .delete(publicApiIdempotency)
      .where(lt(publicApiIdempotency.createdAt, before))
      .returning({ key: publicApiIdempotency.key });
    return rows.length;
  }
}
