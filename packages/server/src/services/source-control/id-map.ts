/**
 * P6-74 (L3): the id map of one sync, in memory. `load` reads the tenant's `sync_id_map` rows; the first pusher's
 * local id is the git id; `allocate` gives an incoming git id a local id (a new UUID: the local ids are global
 * primary keys, so an incoming id is never taken as is); `rewriteDefinition` calls `rewriteUuids` with the map as
 * lookup, so every known UUID in a definition (credential refs, sub-workflow ids, data table ids, the error
 * workflow, ids inside expressions) maps in one pass and an unknown one passes unchanged; `save` writes what
 * changed. The map holds only this tenant's rows, so a lookup never reaches another tenant's id.
 */
import { randomUUID } from 'node:crypto';
import type { SyncIdMapRow, SyncResourceType } from '../../db/schema';
import type { Repositories } from '../../repositories';
import { rewriteUuids } from '../rewrite-uuids';

/** one mapped resource and the versions last synced on each side */
export interface SyncIdEntry {
  type: SyncResourceType;
  gitId: string;
  localId: string;
  /** the file's version when last synced (a workflow's `versionId`, else a content hash); null when never recorded */
  gitVersionId: string | null;
  /** the workspace row's version when last synced */
  localVersionId: string | null;
}

const gitKey = (type: SyncResourceType, id: string) => `${type}:${id.toLowerCase()}`;

export class SyncIdMap {
  private readonly byGit = new Map<string, SyncIdEntry>();
  private readonly byLocal = new Map<string, SyncIdEntry>();
  private readonly dirty = new Set<SyncIdEntry>();
  private readonly dropped = new Map<string, { resourceType: SyncResourceType; gitId: string }>();
  private toGitLookup: Map<string, string> | undefined;
  private toLocalLookup: Map<string, string> | undefined;

  constructor(
    readonly tenantId: string,
    rows: SyncIdMapRow[] = [],
  ) {
    for (const row of rows) {
      this.put({
        type: row.resourceType,
        gitId: row.gitId,
        localId: row.localId,
        gitVersionId: row.gitVersionId,
        localVersionId: row.localVersionId,
      });
    }
  }

  static async load(repos: Repositories, tenantId: string): Promise<SyncIdMap> {
    return new SyncIdMap(tenantId, await repos.syncIdMap.list(tenantId));
  }

  private put(entry: SyncIdEntry): void {
    this.byGit.set(gitKey(entry.type, entry.gitId), entry);
    this.byLocal.set(gitKey(entry.type, entry.localId), entry);
    this.toGitLookup = undefined;
    this.toLocalLookup = undefined;
  }

  /** the entry of a git id, if mapped */
  entryForGit(type: SyncResourceType, gitId: string): SyncIdEntry | undefined {
    return this.byGit.get(gitKey(type, gitId));
  }

  /** the entry of a local id, if mapped */
  entryForLocal(type: SyncResourceType, localId: string): SyncIdEntry | undefined {
    return this.byLocal.get(gitKey(type, localId));
  }

  /** every entry of one type (a copy of the list) */
  entries(type: SyncResourceType): SyncIdEntry[] {
    return [...this.byGit.values()].filter((entry) => entry.type === type);
  }

  /** the git id of a local resource (its own id when it was never synced) */
  gitIdFor(type: SyncResourceType, localId: string): string {
    return this.entryForLocal(type, localId)?.gitId ?? localId.toLowerCase();
  }

  localIdFor(type: SyncResourceType, gitId: string): string | undefined {
    return this.entryForGit(type, gitId)?.localId;
  }

  /** the local id an incoming git id gets: its mapped id, else a new one, remembered for the rest of the sync */
  allocate(type: SyncResourceType, gitId: string): string {
    const known = this.localIdFor(type, gitId);
    if (known) return known;
    const entry: SyncIdEntry = {
      type,
      gitId: gitId.toLowerCase(),
      localId: randomUUID(),
      gitVersionId: null,
      localVersionId: null,
    };
    this.put(entry);
    this.dirty.add(entry);
    this.dropped.delete(gitKey(type, gitId));
    return entry.localId;
  }

  /**
   * Every mapped UUID in `value` replaced, in one pass through `rewriteUuids`: `toGit` maps local ids to git ids,
   * `toLocal` the other way. An id the map does not know passes unchanged. The input is never changed.
   */
  rewriteDefinition<T>(value: T, direction: 'toGit' | 'toLocal'): T {
    if (direction === 'toGit') {
      if (!this.toGitLookup) {
        const lookup = new Map<string, string>();
        for (const entry of this.byGit.values()) {
          if (entry.gitId !== entry.localId.toLowerCase())
            lookup.set(entry.localId.toLowerCase(), entry.gitId);
        }
        this.toGitLookup = lookup;
      }
      const lookup = this.toGitLookup;
      return rewriteUuids(value, (id) => lookup.get(id));
    }
    if (!this.toLocalLookup) {
      const lookup = new Map<string, string>();
      for (const entry of this.byGit.values()) {
        if (entry.gitId !== entry.localId.toLowerCase()) lookup.set(entry.gitId, entry.localId);
      }
      this.toLocalLookup = lookup;
    }
    const lookup = this.toLocalLookup;
    return rewriteUuids(value, (id) => lookup.get(id));
  }

  /**
   * The versions synced on each side. A side left out keeps its old version. A local id that was mapped to another
   * git id moves to this one (the local id is unique per type).
   */
  record(
    type: SyncResourceType,
    gitId: string,
    localId: string,
    versions: { git?: string; local?: string },
  ): void {
    const git = gitId.toLowerCase();
    const local = localId.toLowerCase();
    const previous = this.entryForGit(type, git);
    const sameLocal = this.entryForLocal(type, local);
    if (sameLocal && sameLocal !== previous) this.drop(type, sameLocal.gitId);
    if (previous && previous.localId.toLowerCase() !== local)
      this.byLocal.delete(gitKey(type, previous.localId));
    const entry: SyncIdEntry = {
      type,
      gitId: git,
      localId: local,
      gitVersionId: versions.git ?? previous?.gitVersionId ?? null,
      localVersionId: versions.local ?? previous?.localVersionId ?? null,
    };
    this.put(entry);
    if (previous) this.dirty.delete(previous);
    this.dirty.add(entry);
    this.dropped.delete(gitKey(type, git));
  }

  drop(type: SyncResourceType, gitId: string): void {
    const entry = this.byGit.get(gitKey(type, gitId));
    if (!entry) return;
    this.byGit.delete(gitKey(type, gitId));
    if (this.byLocal.get(gitKey(type, entry.localId)) === entry)
      this.byLocal.delete(gitKey(type, entry.localId));
    this.dirty.delete(entry);
    this.dropped.set(gitKey(type, gitId), { resourceType: type, gitId: entry.gitId });
    this.toGitLookup = undefined;
    this.toLocalLookup = undefined;
  }

  /** writes what changed: new and updated rows, then removed ones; the map is clean afterwards */
  async save(repos: Repositories): Promise<void> {
    const removed = [...this.dropped.values()];
    if (removed.length) await repos.syncIdMap.remove(this.tenantId, removed);
    const changed = [...this.dirty];
    if (changed.length) {
      await repos.syncIdMap.upsert(
        this.tenantId,
        changed.map((entry) => ({
          resourceType: entry.type,
          gitId: entry.gitId,
          localId: entry.localId,
          gitVersionId: entry.gitVersionId,
          localVersionId: entry.localVersionId,
        })),
      );
    }
    this.dirty.clear();
    this.dropped.clear();
  }
}
