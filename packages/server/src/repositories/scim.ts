/**
 * P6-02 (L13): a workspace's SCIM token (`scim_tokens`, one per workspace), stored as SHA-256 with its last
 * four characters. Stub from C0; L13 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { ScimTokenRow } from '../db/schema';

export class ScimRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the workspace's token row (no secret in it: hash and hint only) */
  async get(_tenantId: string): Promise<ScimTokenRow | undefined> {
    throw new Error('not implemented (L13)');
  }

  /** replaces the workspace's token (mint, rotate) */
  async save(
    _tenantId: string,
    _input: { tokenHash: string; tokenHint: string; createdBy: string | null },
  ): Promise<ScimTokenRow> {
    throw new Error('not implemented (L13)');
  }

  async delete(_tenantId: string): Promise<boolean> {
    throw new Error('not implemented (L13)');
  }

  /** system level: the token by its hash, before the workspace is known (the bearer names it) */
  async getByHash(_tokenHash: string): Promise<ScimTokenRow | undefined> {
    throw new Error('not implemented (L13)');
  }
}
