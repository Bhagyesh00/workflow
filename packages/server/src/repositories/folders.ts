/**
 * Folders (P3-07): nested per tenant, with folder tags (folder_tags).
 *
 * C0 STUB: lane L8 writes the bodies (and may add methods).
 */
import type { DbOrTx } from '../db/client';
import type { FolderRow } from '../db/schema';

export class FolderRepository {
  constructor(readonly db: DbOrTx) {}

  async get(_tenantId: string, _id: string): Promise<FolderRow | undefined> {
    throw new Error('not implemented (L8)');
  }
}
