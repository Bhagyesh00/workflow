/**
 * MCP OAuth server storage (P5-14): clients (RFC 7591), authorization codes, access and refresh tokens,
 * user consents. Codes, tokens and client secrets are stored as SHA-256 only: every `hash` argument is
 * that digest, never the raw value. Every method but `sweepExpired` (system level, all tenants) takes
 * `tenantId` first. C0 stub: the bodies are L10's.
 */
import type { DbOrTx } from '../db/client';
import type {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
  oauthUserConsents,
} from '../db/schema';

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

export class McpOAuthRepository {
  constructor(readonly db: DbOrTx) {}

  /** registers a client (the caller checked `MCP_MAX_REGISTERED_CLIENTS` with `countClients`) */
  async createClient(_client: OAuthClientInsert): Promise<OAuthClientRow> {
    throw new Error('not implemented (L10)');
  }

  /** the client of this tenant, or undefined (another tenant's client reads as missing) */
  async getClient(_tenantId: string, _id: string): Promise<OAuthClientRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  /** the tenant's clients, newest first */
  async listClients(_tenantId: string): Promise<OAuthClientRow[]> {
    throw new Error('not implemented (L10)');
  }

  async countClients(_tenantId: string): Promise<number> {
    throw new Error('not implemented (L10)');
  }

  /** deletes the client; its codes, tokens and consents go by cascade. True when it existed */
  async deleteClient(_tenantId: string, _id: string): Promise<boolean> {
    throw new Error('not implemented (L10)');
  }

  /** stores a new code (`codeHash` = SHA-256 of the code, `used` false, 10-minute `expiresAt`) */
  async saveCode(_code: OAuthAuthorizationCodeInsert): Promise<void> {
    throw new Error('not implemented (L10)');
  }

  /**
   * Single use and atomic: marks the code used and returns it in one statement, only when it was unused
   * and not expired; a second call, a used or an expired code gives undefined.
   */
  async takeCode(_tenantId: string, _hash: string): Promise<OAuthAuthorizationCodeRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  /** stores a new access token and its refresh token (both hashed) in one transaction */
  async saveTokens(_access: OAuthAccessTokenInsert, _refresh: OAuthRefreshTokenInsert): Promise<void> {
    throw new Error('not implemented (L10)');
  }

  /** the access token row by hash; the caller checks `expiresAt` and `resource` */
  async getAccessToken(_tenantId: string, _hash: string): Promise<OAuthAccessTokenRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  /** the refresh token row by hash; the caller checks `expiresAt`, client and `resource` */
  async getRefreshToken(_tenantId: string, _hash: string): Promise<OAuthRefreshTokenRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  /**
   * Rotation, atomic: deletes the old refresh token and stores the new pair in one transaction. False
   * (nothing stored) when the old token is gone, so a replayed refresh token gets `invalid_grant`.
   */
  async rotateRefreshToken(
    _tenantId: string,
    _oldHash: string,
    _access: OAuthAccessTokenInsert,
    _refresh: OAuthRefreshTokenInsert,
  ): Promise<boolean> {
    throw new Error('not implemented (L10)');
  }

  /** RFC 7009: removes the access or refresh token with this hash at once; true when one was found */
  async revokeToken(_tenantId: string, _hash: string): Promise<boolean> {
    throw new Error('not implemented (L10)');
  }

  /** removes every code, access and refresh token of the client (the client row stays) */
  async revokeForClient(_tenantId: string, _clientId: string): Promise<void> {
    throw new Error('not implemented (L10)');
  }

  async getConsent(
    _tenantId: string,
    _userId: string,
    _clientId: string,
  ): Promise<OAuthUserConsentRow | undefined> {
    throw new Error('not implemented (L10)');
  }

  /** stores or replaces the user's consent for the client (unique per tenant, user and client) */
  async saveConsent(_consent: OAuthUserConsentInsert): Promise<void> {
    throw new Error('not implemented (L10)');
  }

  /**
   * System level (all tenants): deletes codes, access and refresh tokens whose `expiresAt` is before
   * `now`. Runs from `mcpOAuthPlugin`'s timer; the C0 stub removes nothing and does not throw.
   */
  async sweepExpired(_now: Date): Promise<OAuthSweepResult> {
    return { codes: 0, accessTokens: 0, refreshTokens: 0 };
  }
}
