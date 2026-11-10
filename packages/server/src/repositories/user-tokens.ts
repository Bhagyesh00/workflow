/**
 * P6-19 (L3): one-use tokens of a user (`user_tokens`: password reset, email change), stored as SHA-256
 * only; global like `users` (no tenant, no RLS). Stub from C0; L3 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { UserTokenRow } from '../db/schema';

export type UserTokenKind = UserTokenRow['kind'];

export class UserTokenRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** a new token row; `tokenHash` is sha256 of the token, never the token */
  async create(_input: {
    userId: string;
    kind: UserTokenKind;
    tokenHash: string;
    expiresAt: Date;
    data?: Record<string, unknown> | null;
  }): Promise<UserTokenRow> {
    throw new Error('not implemented (L3)');
  }

  /** a pending (unused, not expired) token of the kind by its hash, without using it */
  async getPending(_kind: UserTokenKind, _tokenHash: string): Promise<UserTokenRow | undefined> {
    throw new Error('not implemented (L3)');
  }

  /** uses the token once: sets `used_at` in one conditional UPDATE; the row, or undefined when used or expired */
  async consume(_kind: UserTokenKind, _tokenHash: string): Promise<UserTokenRow | undefined> {
    throw new Error('not implemented (L3)');
  }

  /** deletes the user's tokens of one kind (a new request replaces the old ones) */
  async deleteForUser(_userId: string, _kind: UserTokenKind): Promise<number> {
    throw new Error('not implemented (L3)');
  }
}
