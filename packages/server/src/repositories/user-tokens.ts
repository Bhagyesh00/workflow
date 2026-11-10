/**
 * P6-19 (L3): one-use tokens of a user (`user_tokens`: password reset, email change), stored as SHA-256
 * only; global like `users` (no tenant, no RLS). A token is used once: `consume` sets `used_at` in one
 * conditional UPDATE, so of two requests with the same token exactly one gets the row.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type UserTokenRow, userTokens } from '../db/schema';
import { isUuid, now } from './util';

export type UserTokenKind = UserTokenRow['kind'];

export class UserTokenRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** a new token row; `tokenHash` is sha256 of the token, never the token */
  async create(input: {
    userId: string;
    kind: UserTokenKind;
    tokenHash: string;
    expiresAt: Date;
    data?: Record<string, unknown> | null;
  }): Promise<UserTokenRow> {
    const [row] = await this.db
      .insert(userTokens)
      .values({
        userId: input.userId,
        kind: input.kind,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        data: input.data ?? null,
      })
      .returning();
    return row;
  }

  /** a pending (unused, not expired) token of the kind by its hash, without using it */
  async getPending(kind: UserTokenKind, tokenHash: string): Promise<UserTokenRow | undefined> {
    const [row] = await this.db
      .select()
      .from(userTokens)
      .where(
        and(
          eq(userTokens.kind, kind),
          eq(userTokens.tokenHash, tokenHash),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, now()),
        ),
      );
    return row;
  }

  /** uses the token once: sets `used_at` in one conditional UPDATE; the row, or undefined when used or expired */
  async consume(kind: UserTokenKind, tokenHash: string): Promise<UserTokenRow | undefined> {
    const [row] = await this.db
      .update(userTokens)
      .set({ usedAt: now() })
      .where(
        and(
          eq(userTokens.kind, kind),
          eq(userTokens.tokenHash, tokenHash),
          isNull(userTokens.usedAt),
          gt(userTokens.expiresAt, now()),
        ),
      )
      .returning();
    return row;
  }

  /** deletes the user's tokens of one kind (a new request replaces the old ones) */
  async deleteForUser(userId: string, kind: UserTokenKind): Promise<number> {
    if (!isUuid(userId)) return 0;
    const rows = await this.db
      .delete(userTokens)
      .where(and(eq(userTokens.userId, userId), eq(userTokens.kind, kind)))
      .returning({ id: userTokens.id });
    return rows.length;
  }
}
