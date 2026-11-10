/**
 * P6-18 (L2): a user's MFA secret and recovery codes (`user_mfa`, global like `users`: no tenant, no RLS).
 * The secret is a CredentialCipher payload; recovery codes are SHA-256 hex. Every state change is one
 * conditional statement, so two requests at once cannot both win.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
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
  async get(userId: string): Promise<UserMfaRow | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await this.db.select().from(userMfa).where(eq(userMfa.userId, userId));
    return row;
  }

  /** a new pending secret and recovery code hashes (setup); replaces a pending row, never an enabled one */
  async savePending(userId: string, secretEnc: string, recoveryHashes: string[]): Promise<void> {
    const rows = await this.db
      .insert(userMfa)
      .values({ userId, secretEnc, recoveryHashes })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { secretEnc, recoveryHashes, lastStep: null, createdAt: new Date() },
        setWhere: isNull(userMfa.enabledAt),
      })
      .returning({ userId: userMfa.userId });
    if (!rows.length) throw new Error('Two-factor sign-in is already on');
  }

  /** marks the pending row enabled; false when there is none */
  async enable(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .update(userMfa)
      .set({ enabledAt: new Date() })
      .where(and(eq(userMfa.userId, userId), isNull(userMfa.enabledAt)))
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  /** deletes the row (disable, `mfa:disable`); false when there was none */
  async delete(userId: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .delete(userMfa)
      .where(eq(userMfa.userId, userId))
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  /** the `last_step` guard: stores `step` only when it is greater than the stored one, in one UPDATE */
  async advanceStep(userId: string, step: number): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .update(userMfa)
      .set({ lastStep: step })
      .where(and(eq(userMfa.userId, userId), or(isNull(userMfa.lastStep), lt(userMfa.lastStep, step))))
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }

  /** removes one recovery code hash in one atomic array update; false when it was not there */
  async useRecoveryCode(userId: string, hash: string): Promise<boolean> {
    if (!isUuid(userId)) return false;
    const rows = await this.db
      .update(userMfa)
      .set({ recoveryHashes: sql`array_remove(${userMfa.recoveryHashes}, ${hash})` })
      .where(
        and(
          eq(userMfa.userId, userId),
          isNotNull(userMfa.enabledAt),
          sql`${hash} = ANY(${userMfa.recoveryHashes})`,
        ),
      )
      .returning({ userId: userMfa.userId });
    return rows.length > 0;
  }
}
