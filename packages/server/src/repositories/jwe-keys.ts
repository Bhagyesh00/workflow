/**
 * P6-16 (L15): a workspace's JWE key pairs for OAuth2 token responses (`oauth_jwe_keys`): the private key
 * encrypted, the public JWK served at /.well-known/jwks/:slug.json. Every query filters tenant_id.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type OAuthJweKeyRow, oauthJweKeys } from '../db/schema';

export class JweKeyRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** newest first */
  async list(tenantId: string): Promise<OAuthJweKeyRow[]> {
    return this.db
      .select()
      .from(oauthJweKeys)
      .where(eq(oauthJweKeys.tenantId, tenantId))
      .orderBy(desc(oauthJweKeys.createdAt), desc(oauthJweKeys.kid));
  }

  async get(tenantId: string, kid: string): Promise<OAuthJweKeyRow | undefined> {
    const [row] = await this.db
      .select()
      .from(oauthJweKeys)
      .where(and(eq(oauthJweKeys.tenantId, tenantId), eq(oauthJweKeys.kid, kid)));
    return row;
  }

  async create(
    tenantId: string,
    input: { kid: string; privateEnc: string; publicJwk: Record<string, unknown> },
  ): Promise<OAuthJweKeyRow> {
    const [row] = await this.db
      .insert(oauthJweKeys)
      .values({ tenantId, kid: input.kid, privateEnc: input.privateEnc, publicJwk: input.publicJwk })
      .returning();
    return row;
  }

  /**
   * Stores the key only when the workspace has none, and returns the workspace's keys. A transaction-scoped
   * advisory lock on the workspace makes first fetches that arrive together make one key, not several.
   */
  async createIfNone(
    tenantId: string,
    input: { kid: string; privateEnc: string; publicJwk: Record<string, unknown> },
  ): Promise<OAuthJweKeyRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`oauth_jwe_keys:${tenantId}`}))`);
      const existing = await new JweKeyRepository(tx).list(tenantId);
      if (existing.length > 0) return existing;
      return [await new JweKeyRepository(tx).create(tenantId, input)];
    });
  }

  async delete(tenantId: string, kid: string): Promise<boolean> {
    const rows = await this.db
      .delete(oauthJweKeys)
      .where(and(eq(oauthJweKeys.tenantId, tenantId), eq(oauthJweKeys.kid, kid)))
      .returning({ kid: oauthJweKeys.kid });
    return rows.length > 0;
  }
}
