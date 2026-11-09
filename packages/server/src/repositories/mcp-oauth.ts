/**
 * MCP OAuth server storage (P5-14): clients (RFC 7591), authorization codes, access and refresh tokens,
 * user consents. Codes, tokens and client secrets are stored as SHA-256 only: every `hash` argument is
 * that digest, never the raw value. Every method but `sweepExpired` (system level, all tenants) takes
 * `tenantId` first and names it in its query with a bound value.
 */
import { and, count, desc, eq, gt, lt, notExists } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
  oauthUserConsents,
} from '../db/schema';
import { isUuid } from './util';

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type OAuthClientInsert = typeof oauthClients.$inferInsert;
export type OAuthAuthorizationCodeRow = typeof oauthAuthorizationCodes.$inferSelect;
export type OAuthAuthorizationCodeInsert = typeof oauthAuthorizationCodes.$inferInsert;
export type OAuthAccessTokenRow = typeof oauthAccessTokens.$inferSelect;
export type OAuthAccessTokenInsert = typeof oauthAccessTokens.$inferInsert;
export type OAuthRefreshTokenRow = typeof oauthRefreshTokens.$inferSelect;
export type OAuthRefreshTokenInsert = typeof oauthRefreshTokens.$inferInsert;
export type OAuthUserConsentRow = typeof oauthUserConsents.$inferSelect;
export type OAuthUserConsentInsert = typeof oauthUserConsents.$inferInsert;

/** rows `sweepExpired` removed, per table */
export interface OAuthSweepResult {
  codes: number;
  accessTokens: number;
  refreshTokens: number;
}

/** the longest client id or hash a lookup reads; anything longer is not ours */
const MAX_KEY_LENGTH = 256;

const usableKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH;

export class McpOAuthRepository {
  constructor(readonly db: DbOrTx) {}

  /** registers a client (the caller checked `MCP_MAX_REGISTERED_CLIENTS` with `countClients`) */
  async createClient(client: OAuthClientInsert): Promise<OAuthClientRow> {
    const [row] = await this.db.insert(oauthClients).values(client).returning();
    return row;
  }

  /** the client of this tenant, or undefined (another tenant's client reads as missing) */
  async getClient(tenantId: string, id: string): Promise<OAuthClientRow | undefined> {
    if (!isUuid(tenantId) || !usableKey(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(oauthClients)
      .where(and(eq(oauthClients.tenantId, tenantId), eq(oauthClients.id, id)));
    return row;
  }

  /** the tenant's clients, newest first */
  async listClients(tenantId: string): Promise<OAuthClientRow[]> {
    if (!isUuid(tenantId)) return [];
    return this.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.tenantId, tenantId))
      .orderBy(desc(oauthClients.createdAt), desc(oauthClients.id));
  }

  /**
   * The clients this user has a consent row for (P6-35: a client is the caller's own when the caller
   * consented to it), newest client first. Another user's consent does not count.
   */
  async listClientsByUser(tenantId: string, userId: string): Promise<OAuthClientRow[]> {
    if (!isUuid(tenantId) || !isUuid(userId)) return [];
    const rows = await this.db
      .select({ client: oauthClients })
      .from(oauthClients)
      .innerJoin(
        oauthUserConsents,
        and(
          eq(oauthUserConsents.tenantId, oauthClients.tenantId),
          eq(oauthUserConsents.clientId, oauthClients.id),
          eq(oauthUserConsents.userId, userId),
        ),
      )
      .where(eq(oauthClients.tenantId, tenantId))
      .orderBy(desc(oauthClients.createdAt), desc(oauthClients.id));
    return rows.map((row) => row.client);
  }

  async countClients(tenantId: string): Promise<number> {
    if (!isUuid(tenantId)) return 0;
    const [row] = await this.db
      .select({ n: count() })
      .from(oauthClients)
      .where(eq(oauthClients.tenantId, tenantId));
    return Number(row?.n ?? 0);
  }

  /** deletes the client; its codes, tokens and consents go by cascade. True when it existed */
  async deleteClient(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(tenantId) || !usableKey(id)) return false;
    const rows = await this.db
      .delete(oauthClients)
      .where(and(eq(oauthClients.tenantId, tenantId), eq(oauthClients.id, id)))
      .returning({ id: oauthClients.id });
    return rows.length > 0;
  }

  /**
   * Deletes the client when no user consent for it is left (P6-35, n8n parity: the client goes with its
   * last grant). One statement, so a consent saved at the same moment keeps the client. True when deleted.
   */
  async deleteClientWithoutConsents(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(tenantId) || !usableKey(id)) return false;
    const rows = await this.db
      .delete(oauthClients)
      .where(
        and(
          eq(oauthClients.tenantId, tenantId),
          eq(oauthClients.id, id),
          notExists(
            this.db
              .select({ one: oauthUserConsents.clientId })
              .from(oauthUserConsents)
              .where(
                and(
                  eq(oauthUserConsents.tenantId, oauthClients.tenantId),
                  eq(oauthUserConsents.clientId, oauthClients.id),
                ),
              ),
          ),
        ),
      )
      .returning({ id: oauthClients.id });
    return rows.length > 0;
  }

  /** stores a new code (`codeHash` = SHA-256 of the code, `used` false, 10-minute `expiresAt`) */
  async saveCode(code: OAuthAuthorizationCodeInsert): Promise<void> {
    await this.db.insert(oauthAuthorizationCodes).values({ ...code, used: false });
  }

  /**
   * Single use and atomic: marks the code used and returns it in one statement, only when it was unused
   * and not expired; a second call, a used or an expired code gives undefined.
   */
  async takeCode(tenantId: string, hash: string): Promise<OAuthAuthorizationCodeRow | undefined> {
    if (!isUuid(tenantId) || !usableKey(hash)) return undefined;
    const [row] = await this.db
      .update(oauthAuthorizationCodes)
      .set({ used: true })
      .where(
        and(
          eq(oauthAuthorizationCodes.tenantId, tenantId),
          eq(oauthAuthorizationCodes.codeHash, hash),
          eq(oauthAuthorizationCodes.used, false),
          gt(oauthAuthorizationCodes.expiresAt, new Date()),
        ),
      )
      .returning();
    return row;
  }

  /** stores a new access token and its refresh token (both hashed) in one transaction */
  async saveTokens(access: OAuthAccessTokenInsert, refresh: OAuthRefreshTokenInsert): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(oauthAccessTokens).values(access);
      await tx.insert(oauthRefreshTokens).values(refresh);
    });
  }

  /** the access token row by hash; the caller checks `expiresAt` and `resource` */
  async getAccessToken(tenantId: string, hash: string): Promise<OAuthAccessTokenRow | undefined> {
    if (!isUuid(tenantId) || !usableKey(hash)) return undefined;
    const [row] = await this.db
      .select()
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.tenantId, tenantId), eq(oauthAccessTokens.tokenHash, hash)));
    return row;
  }

  /** the refresh token row by hash; the caller checks `expiresAt`, client and `resource` */
  async getRefreshToken(tenantId: string, hash: string): Promise<OAuthRefreshTokenRow | undefined> {
    if (!isUuid(tenantId) || !usableKey(hash)) return undefined;
    const [row] = await this.db
      .select()
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.tenantId, tenantId), eq(oauthRefreshTokens.tokenHash, hash)));
    return row;
  }

  /**
   * Rotation, atomic: deletes the old refresh token and stores the new pair in one transaction. False
   * (nothing stored) when the old token is gone, so a replayed refresh token gets `invalid_grant`.
   */
  async rotateRefreshToken(
    tenantId: string,
    oldHash: string,
    access: OAuthAccessTokenInsert,
    refresh: OAuthRefreshTokenInsert,
  ): Promise<boolean> {
    if (!isUuid(tenantId) || !usableKey(oldHash)) return false;
    return this.db.transaction(async (tx) => {
      const gone = await tx
        .delete(oauthRefreshTokens)
        .where(and(eq(oauthRefreshTokens.tenantId, tenantId), eq(oauthRefreshTokens.tokenHash, oldHash)))
        .returning({ hash: oauthRefreshTokens.tokenHash });
      // a parallel rotation took it first: nothing is stored
      if (gone.length === 0) return false;
      await tx.insert(oauthAccessTokens).values(access);
      await tx.insert(oauthRefreshTokens).values(refresh);
      return true;
    });
  }

  /**
   * RFC 7009: removes the access or refresh token with this hash at once; true when one was found. A
   * refresh token also takes the access tokens of the same grant (client, user and resource) with it.
   */
  async revokeToken(tenantId: string, hash: string): Promise<boolean> {
    if (!isUuid(tenantId) || !usableKey(hash)) return false;
    return this.db.transaction(async (tx) => {
      const access = await tx
        .delete(oauthAccessTokens)
        .where(and(eq(oauthAccessTokens.tenantId, tenantId), eq(oauthAccessTokens.tokenHash, hash)))
        .returning({ hash: oauthAccessTokens.tokenHash });
      if (access.length > 0) return true;
      const [refresh] = await tx
        .delete(oauthRefreshTokens)
        .where(and(eq(oauthRefreshTokens.tenantId, tenantId), eq(oauthRefreshTokens.tokenHash, hash)))
        .returning();
      if (!refresh) return false;
      await tx
        .delete(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.tenantId, tenantId),
            eq(oauthAccessTokens.clientId, refresh.clientId),
            eq(oauthAccessTokens.userId, refresh.userId),
            eq(oauthAccessTokens.resource, refresh.resource),
          ),
        );
      return true;
    });
  }

  /** removes every code, access and refresh token of the client (the client row stays) */
  async revokeForClient(tenantId: string, clientId: string): Promise<void> {
    if (!isUuid(tenantId) || !usableKey(clientId)) return;
    await this.db.transaction(async (tx) => {
      await tx
        .delete(oauthAuthorizationCodes)
        .where(
          and(eq(oauthAuthorizationCodes.tenantId, tenantId), eq(oauthAuthorizationCodes.clientId, clientId)),
        );
      await tx
        .delete(oauthAccessTokens)
        .where(and(eq(oauthAccessTokens.tenantId, tenantId), eq(oauthAccessTokens.clientId, clientId)));
      await tx
        .delete(oauthRefreshTokens)
        .where(and(eq(oauthRefreshTokens.tenantId, tenantId), eq(oauthRefreshTokens.clientId, clientId)));
    });
  }

  /**
   * Removes one user's grant for the client (P6-35): their consent, codes, access and refresh tokens. The
   * client and every other user's grant stay. Returns false when the user had no consent for it.
   */
  async revokeForUser(tenantId: string, userId: string, clientId: string): Promise<boolean> {
    if (!isUuid(tenantId) || !isUuid(userId) || !usableKey(clientId)) return false;
    return this.db.transaction(async (tx) => {
      const removed = await tx
        .delete(oauthUserConsents)
        .where(
          and(
            eq(oauthUserConsents.tenantId, tenantId),
            eq(oauthUserConsents.userId, userId),
            eq(oauthUserConsents.clientId, clientId),
          ),
        )
        .returning({ clientId: oauthUserConsents.clientId });
      await tx
        .delete(oauthAuthorizationCodes)
        .where(
          and(
            eq(oauthAuthorizationCodes.tenantId, tenantId),
            eq(oauthAuthorizationCodes.userId, userId),
            eq(oauthAuthorizationCodes.clientId, clientId),
          ),
        );
      await tx
        .delete(oauthAccessTokens)
        .where(
          and(
            eq(oauthAccessTokens.tenantId, tenantId),
            eq(oauthAccessTokens.userId, userId),
            eq(oauthAccessTokens.clientId, clientId),
          ),
        );
      await tx
        .delete(oauthRefreshTokens)
        .where(
          and(
            eq(oauthRefreshTokens.tenantId, tenantId),
            eq(oauthRefreshTokens.userId, userId),
            eq(oauthRefreshTokens.clientId, clientId),
          ),
        );
      return removed.length > 0;
    });
  }

  async getConsent(
    tenantId: string,
    userId: string,
    clientId: string,
  ): Promise<OAuthUserConsentRow | undefined> {
    if (!isUuid(tenantId) || !isUuid(userId) || !usableKey(clientId)) return undefined;
    const [row] = await this.db
      .select()
      .from(oauthUserConsents)
      .where(
        and(
          eq(oauthUserConsents.tenantId, tenantId),
          eq(oauthUserConsents.userId, userId),
          eq(oauthUserConsents.clientId, clientId),
        ),
      );
    return row;
  }

  /** stores or replaces the user's consent for the client (unique per tenant, user and client) */
  async saveConsent(consent: OAuthUserConsentInsert): Promise<void> {
    const grantedAt = consent.grantedAt ?? new Date();
    await this.db
      .insert(oauthUserConsents)
      .values({ ...consent, grantedAt })
      .onConflictDoUpdate({
        target: [oauthUserConsents.tenantId, oauthUserConsents.userId, oauthUserConsents.clientId],
        set: { scope: consent.scope ?? [], grantedAt },
      });
  }

  /**
   * System level (all tenants): deletes codes, access and refresh tokens whose `expiresAt` is before
   * `now`. Runs from `mcpOAuthPlugin`'s timer.
   */
  async sweepExpired(now: Date): Promise<OAuthSweepResult> {
    const codes = await this.db
      .delete(oauthAuthorizationCodes)
      .where(lt(oauthAuthorizationCodes.expiresAt, now))
      .returning({ hash: oauthAuthorizationCodes.codeHash });
    const accessTokens = await this.db
      .delete(oauthAccessTokens)
      .where(lt(oauthAccessTokens.expiresAt, now))
      .returning({ hash: oauthAccessTokens.tokenHash });
    const refreshTokens = await this.db
      .delete(oauthRefreshTokens)
      .where(lt(oauthRefreshTokens.expiresAt, now))
      .returning({ hash: oauthRefreshTokens.tokenHash });
    return { codes: codes.length, accessTokens: accessTokens.length, refreshTokens: refreshTokens.length };
  }
}
