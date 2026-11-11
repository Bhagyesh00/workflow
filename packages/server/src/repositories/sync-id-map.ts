/**
 * P6-74 (L3): the id map between a Git work folder and this workspace (`sync_id_map`): per resource type, the git id
 * (the first pusher's local id) and the local id, with the versions last synced on each side. One map for seven
 * resource types, so no foreign key to the resources: L3 and L4 remove stale rows. Every query filters tenant_id.
 * stub (L3): the constructor passes, every method throws.
 */
import type { DbOrTx } from '../db/client';
import type { SyncIdMapRow, SyncResourceType } from '../db/schema';

/** one row to write (`updatedAt` is the repository's) */
export interface SyncIdMapEntry {
  resourceType: SyncResourceType;
  gitId: string;
  localId: string;
  gitVersionId: string | null;
  localVersionId: string | null;
}

export class SyncIdMapRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** stub (L3): every row of the tenant */
  list(_tenantId: string): Promise<SyncIdMapRow[]> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): insert or update by (tenant, type, git id) */
  upsert(_tenantId: string, _entries: SyncIdMapEntry[]): Promise<void> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): drop rows by git id */
  remove(_tenantId: string, _keys: Array<{ resourceType: SyncResourceType; gitId: string }>): Promise<void> {
    throw new Error('not implemented (L3)');
  }
}
