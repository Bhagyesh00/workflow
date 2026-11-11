/**
 * P6-74 (L3): the id map of one sync, in memory. `load` reads the tenant's `sync_id_map` rows; the first pusher's
 * local id is the git id; `allocate` gives an incoming git id a local id (the git id when it is free in the database,
 * else a new one); `rewriteDefinition` calls `rewriteUuids` with the map as lookup, so every known UUID in a
 * definition (credential refs, sub-workflow ids, data table ids, the error workflow, ids inside expressions) maps in
 * one pass and an unknown one passes unchanged; `save` writes what changed.
 * stub (L3): every member throws.
 */
import type { SyncResourceType } from '../../db/schema';
import type { Repositories } from '../../repositories';

export class SyncIdMap {
  /** stub (L3) */
  static load(_repos: Repositories, _tenantId: string): Promise<SyncIdMap> {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): the git id of a local resource (its own id when it was never synced) */
  gitIdFor(_type: SyncResourceType, _localId: string): string {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3) */
  localIdFor(_type: SyncResourceType, _gitId: string): string | undefined {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): the local id an incoming git id gets */
  allocate(_type: SyncResourceType, _gitId: string): string {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): every mapped UUID in `value` replaced, through `rewriteUuids` */
  rewriteDefinition<T>(_value: T, _direction: 'toGit' | 'toLocal'): T {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3): the versions synced on each side */
  record(
    _type: SyncResourceType,
    _gitId: string,
    _localId: string,
    _versions: { git?: string; local?: string },
  ): void {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3) */
  drop(_type: SyncResourceType, _gitId: string): void {
    throw new Error('not implemented (L3)');
  }

  /** stub (L3) */
  save(_repos: Repositories): Promise<void> {
    throw new Error('not implemented (L3)');
  }
}
