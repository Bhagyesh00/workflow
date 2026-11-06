/**
 * External secret connections (P4-07). Every method takes the tenant first, except the one
 * system-level read the manager's startup load uses, which says so. `settingsEnc` is ciphertext; only
 * the manager decrypts it. Stub until L9.
 */
import type { DbOrTx } from '../db/client';
import type { SecretConnectionRow } from '../db/schema';
import { ApiError } from '../http/errors';

const notBuilt = () => new ApiError(501, 'not_built', 'not built');

export type SecretConnectionInsert = Pick<
  SecretConnectionRow,
  'id' | 'providerKey' | 'type' | 'settingsEnc' | 'isEnabled' | 'createdBy'
>;

export type SecretConnectionPatch = Partial<
  Pick<SecretConnectionRow, 'type' | 'settingsEnc' | 'isEnabled' | 'state' | 'lastError'>
>;

export class SecretConnectionRepository {
  constructor(readonly db: DbOrTx) {}

  async list(_tenantId: string): Promise<SecretConnectionRow[]> {
    throw notBuilt();
  }

  async get(_tenantId: string, _providerKey: string): Promise<SecretConnectionRow | undefined> {
    throw notBuilt();
  }

  async create(_tenantId: string, _row: SecretConnectionInsert): Promise<SecretConnectionRow> {
    throw notBuilt();
  }

  async update(
    _tenantId: string,
    _providerKey: string,
    _patch: SecretConnectionPatch,
  ): Promise<SecretConnectionRow | undefined> {
    throw notBuilt();
  }

  /** true when a row went */
  async delete(_tenantId: string, _providerKey: string): Promise<boolean> {
    throw notBuilt();
  }

  /** credentials whose secret_keys hold this connection, for the delete warning */
  async countCredentialsUsing(_tenantId: string, _providerKey: string): Promise<number> {
    throw notBuilt();
  }

  /** System-level: every tenant's enabled connections, for the load before jobs start. */
  async listAllEnabled(): Promise<SecretConnectionRow[]> {
    throw notBuilt();
  }
}
