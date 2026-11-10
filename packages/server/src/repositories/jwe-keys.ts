/**
 * P6-16 (L15): a workspace's JWE key pairs for OAuth2 token responses (`oauth_jwe_keys`): the private key
 * encrypted, the public JWK served at /.well-known/jwks/:slug.json. Stub from C0; L15 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { OAuthJweKeyRow } from '../db/schema';

export class JweKeyRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** newest first */
  async list(_tenantId: string): Promise<OAuthJweKeyRow[]> {
    throw new Error('not implemented (L15)');
  }

  async get(_tenantId: string, _kid: string): Promise<OAuthJweKeyRow | undefined> {
    throw new Error('not implemented (L15)');
  }

  async create(
    _tenantId: string,
    _input: { kid: string; privateEnc: string; publicJwk: Record<string, unknown> },
  ): Promise<OAuthJweKeyRow> {
    throw new Error('not implemented (L15)');
  }

  async delete(_tenantId: string, _kid: string): Promise<boolean> {
    throw new Error('not implemented (L15)');
  }
}
