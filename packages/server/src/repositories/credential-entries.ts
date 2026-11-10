/**
 * P6-15 (L14): private credential entries (`credential_user_entries`): one encrypted connection per
 * credential and member, under RLS. Stub from C0; L14 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { CredentialUserEntryRow } from '../db/schema';

export class CredentialEntryRepository {
  constructor(protected readonly db: DbOrTx) {}

  async get(
    _tenantId: string,
    _credentialId: string,
    _userId: string,
  ): Promise<CredentialUserEntryRow | undefined> {
    throw new Error('not implemented (L14)');
  }

  /** creates or replaces the member's entry */
  async save(_tenantId: string, _credentialId: string, _userId: string, _dataEnc: string): Promise<void> {
    throw new Error('not implemented (L14)');
  }

  async delete(_tenantId: string, _credentialId: string, _userId: string): Promise<boolean> {
    throw new Error('not implemented (L14)');
  }

  /** every connection of a credential (switch to fixed, a shared field changed) */
  async deleteForCredential(_tenantId: string, _credentialId: string): Promise<number> {
    throw new Error('not implemented (L14)');
  }

  /** the entries of the given members on the given credentials (access was lost) */
  async deleteWhere(
    _tenantId: string,
    _scope: { userIds?: string[]; credentialIds?: string[] },
  ): Promise<number> {
    throw new Error('not implemented (L14)');
  }

  /** which of the credentials the member has connected */
  async connectedIds(_tenantId: string, _userId: string, _credentialIds: string[]): Promise<Set<string>> {
    throw new Error('not implemented (L14)');
  }
}
