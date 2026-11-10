/**
 * P6-18 (L2): a user's MFA secret and recovery codes (`user_mfa`, global like `users`: no tenant, no RLS).
 * Stub from C0 except `isEnabled`, which GET /auth/me reads; L2 fills the rest.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type UserMfaRow, userMfa } from '../db/schema';
import { isUuid } from './util';

export class UserMfaRepository {
  constructor(private readonly db: DbOrTx) {}

  /** FULL: true when the user has finished setting MFA up (`enabled_at` set) */
  async isEnabled(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const [row] = await this.db
      .select({ enabledAt: userMfa.enabledAt })
      .from(userMfa)
      .where(eq(userMfa.userId, userId));
    return Boolean(row?.enabledAt);
  }

  /** the row, or undefined when MFA was never set up */
  async get(_userId: string): Promise<UserMfaRow | undefined> {
    throw new Error('not implemented (L2)');
  }

  /** a new pending secret and recovery code hashes (setup); replaces a pending row, never an enabled one */
  async savePending(_userId: string, _secretEnc: string, _recoveryHashes: string[]): Promise<void> {
    throw new Error('not implemented (L2)');
  }

  /** marks the pending row enabled; false when there is none */
  async enable(_userId: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** deletes the row (disable, `mfa:disable`); false when there was none */
  async delete(_userId: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** the `last_step` guard: stores `step` only when it is greater than the stored one, in one UPDATE */
  async advanceStep(_userId: string, _step: number): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }

  /** removes one recovery code hash in one atomic array update; false when it was not there */
  async useRecoveryCode(_userId: string, _hash: string): Promise<boolean> {
    throw new Error('not implemented (L2)');
  }
}
