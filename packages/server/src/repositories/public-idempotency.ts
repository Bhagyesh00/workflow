/**
 * P6-82 (L15): `public_api_idempotency` (migration 0034), primary key (tenant_id, user_id, key). Every query
 * filters tenant_id, except the system-level prune. `responseEnc` holds the `CredentialCipher` text only.
 * Stub from C0; L15 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { PublicApiIdempotencyRow } from '../db/schema';

export class PublicIdempotencyRepository {
  constructor(protected readonly db: DbOrTx) {}

  async get(_tenantId: string, _userId: string, _key: string): Promise<PublicApiIdempotencyRow | undefined> {
    throw new Error('not implemented (L15)');
  }

  /** inserts `in_progress`; false when a row of that key exists */
  async claim(_tenantId: string, _userId: string, _key: string, _fingerprint: string): Promise<boolean> {
    throw new Error('not implemented (L15)');
  }

  async finish(
    _tenantId: string,
    _userId: string,
    _key: string,
    _input: { statusCode: number; responseEnc: string },
  ): Promise<void> {
    throw new Error('not implemented (L15)');
  }

  async release(_tenantId: string, _userId: string, _key: string): Promise<void> {
    throw new Error('not implemented (L15)');
  }

  /** the row of that user and key when it is older than `before` */
  async deleteExpired(_tenantId: string, _userId: string, _key: string, _before: Date): Promise<boolean> {
    throw new Error('not implemented (L15)');
  }

  /** system level: rows older than `before`, across tenants */
  async prune(_before: Date): Promise<number> {
    throw new Error('not implemented (L15)');
  }
}
