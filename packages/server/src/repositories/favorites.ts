/**
 * Per-user favorites (P3-07): workflows and folders.
 *
 * C0 STUB: lane L8 writes the bodies (and may add methods).
 */
import type { DbOrTx } from '../db/client';

export type FavoriteResourceType = 'workflow' | 'folder';

export class FavoriteRepository {
  constructor(readonly db: DbOrTx) {}

  /** remove every user's favorite of one resource; returns the number removed */
  async removeForResource(
    _tenantId: string,
    _type: FavoriteResourceType,
    _resourceId: string,
  ): Promise<number> {
    throw new Error('not implemented (L8)');
  }
}
