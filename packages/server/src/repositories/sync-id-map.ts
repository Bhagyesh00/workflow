/**
 * P6-74 (L3): the id map between a Git work folder and this workspace (`sync_id_map`): per resource type, the git id
 * (the first pusher's local id) and the local id, with the versions last synced on each side. One map for seven
 * resource types, so no foreign key to the resources: L3 and L4 remove stale rows. Every query filters tenant_id.
 */
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type SyncIdMapRow, type SyncResourceType, syncIdMap } from '../db/schema';
import { now } from './util';

/** one row to write (`updatedAt` is the repository's) */
export interface SyncIdMapEntry {
  resourceType: SyncResourceType;
  gitId: string;
  localId: string;
  gitVersionId: string | null;
  localVersionId: string | null;
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`);

/** rows per statement: keeps a large pull inside the driver's parameter limit */
const CHUNK = 500;

export class SyncIdMapRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** every row of the tenant */
  async list(tenantId: string): Promise<SyncIdMapRow[]> {
    return this.db.select().from(syncIdMap).where(eq(syncIdMap.tenantId, tenantId));
  }

  /**
   * Insert or update by (tenant, type, git id). A row that holds the same local id under another git id is
   * replaced (the local id is unique per type), so a re-mapped resource never trips the unique key.
   */
  async upsert(tenantId: string, entries: SyncIdMapEntry[]): Promise<void> {
    for (let start = 0; start < entries.length; start += CHUNK) {
      const chunk = entries.slice(start, start + CHUNK);
      for (const entry of chunk) {
        await this.db
          .delete(syncIdMap)
          .where(
            and(
              eq(syncIdMap.tenantId, tenantId),
              eq(syncIdMap.resourceType, entry.resourceType),
              eq(syncIdMap.localId, entry.localId),
              ne(syncIdMap.gitId, entry.gitId),
            ),
          );
      }
      await this.db
        .insert(syncIdMap)
        .values(chunk.map((entry) => ({ ...entry, tenantId, updatedAt: now() })))
        .onConflictDoUpdate({
          target: [syncIdMap.tenantId, syncIdMap.resourceType, syncIdMap.gitId],
          set: {
            localId: sqlExcluded('local_id'),
            gitVersionId: sqlExcluded('git_version_id'),
            localVersionId: sqlExcluded('local_version_id'),
            updatedAt: now(),
          },
        });
    }
  }

  /** drop rows by git id */
  async remove(
    tenantId: string,
    keys: Array<{ resourceType: SyncResourceType; gitId: string }>,
  ): Promise<void> {
    const byType = new Map<SyncResourceType, string[]>();
    for (const key of keys) {
      const list = byType.get(key.resourceType) ?? [];
      list.push(key.gitId);
      byType.set(key.resourceType, list);
    }
    const clauses = [];
    for (const [resourceType, gitIds] of byType) {
      for (let start = 0; start < gitIds.length; start += CHUNK) {
        clauses.push(
          and(
            eq(syncIdMap.resourceType, resourceType),
            inArray(syncIdMap.gitId, gitIds.slice(start, start + CHUNK)),
          ),
        );
      }
    }
    if (!clauses.length) return;
    await this.db.delete(syncIdMap).where(and(eq(syncIdMap.tenantId, tenantId), or(...clauses)));
  }
}
