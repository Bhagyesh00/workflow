/**
 * Folders (P3-07): nested per tenant, with folder tags (folder_tags).
 *
 * Every query filters tenant_id. Subtree and ancestor walks are recursive CTEs that also filter
 * tenant_id on every step.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type FolderRow, folders, folderTags, tags, workflows } from '../db/schema';
import type { Cursor } from '../http/pagination';
import { isUuid, now } from './util';
import type { TagRef } from './workflows';

export interface FolderListFilter {
  /** a folder id, or 'root' for the top level; undefined = every folder */
  parentFolderId?: string;
  search?: string;
  /** tag names; a folder must have all of them */
  tags?: string[];
  limit: number;
  /** keyset on (name, id) */
  cursor?: Cursor;
}

export interface FolderPathRow {
  id: string;
  name: string;
}

export interface FolderCounts {
  workflowCount: number;
  subFolderCount: number;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export class FolderRepository {
  constructor(readonly db: DbOrTx) {}

  async get(tenantId: string, id: string): Promise<FolderRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(folders)
      .where(and(eq(folders.tenantId, tenantId), eq(folders.id, id)));
    return row;
  }

  /** one extra row (limit + 1) tells the caller whether a next page exists */
  async list(tenantId: string, filter: FolderListFilter): Promise<FolderRow[]> {
    const conditions = [eq(folders.tenantId, tenantId)];
    if (filter.parentFolderId !== undefined) {
      if (filter.parentFolderId === 'root') conditions.push(isNull(folders.parentFolderId));
      else if (!isUuid(filter.parentFolderId)) return [];
      else conditions.push(eq(folders.parentFolderId, filter.parentFolderId));
    }
    if (filter.search) conditions.push(sql`${folders.name} ilike ${`%${escapeLike(filter.search)}%`}`);
    if (filter.tags?.length) {
      const names = [...new Set(filter.tags)];
      conditions.push(sql`${folders.id} in (
        select ft.folder_id from ${folderTags} ft
        join ${tags} t on t.id = ft.tag_id
        where ft.tenant_id = ${tenantId} and t.tenant_id = ${tenantId}
          and t.name in (${sql.join(
            names.map((n) => sql`${n}`),
            sql`, `,
          )})
        group by ft.folder_id
        having count(distinct t.name) = ${names.length}
      )`);
    }
    if (filter.cursor) {
      conditions.push(
        sql`(${folders.name}, ${folders.id}) > (${filter.cursor.value}, ${filter.cursor.id}::uuid)`,
      );
    }
    return this.db
      .select()
      .from(folders)
      .where(and(...conditions))
      .orderBy(asc(folders.name), asc(folders.id))
      .limit(filter.limit + 1);
  }

  async create(tenantId: string, input: { name: string; parentFolderId: string | null }): Promise<FolderRow> {
    const [row] = await this.db
      .insert(folders)
      .values({ tenantId, name: input.name, parentFolderId: input.parentFolderId })
      .returning();
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; parentFolderId?: string | null },
  ): Promise<FolderRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(folders)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(folders.tenantId, tenantId), eq(folders.id, id)))
      .returning();
    return row;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(folders)
      .where(and(eq(folders.tenantId, tenantId), eq(folders.id, id)))
      .returning({ id: folders.id });
    return rows.length > 0;
  }

  /** the folder and every folder below it */
  async subtreeIds(tenantId: string, id: string): Promise<string[]> {
    if (!isUuid(id)) return [];
    const result = await this.db.execute<{ id: string }>(sql`
      with recursive down as (
        select id from ${folders} where tenant_id = ${tenantId} and id = ${id}::uuid
        union all
        select f.id from ${folders} f join down d on f.parent_folder_id = d.id where f.tenant_id = ${tenantId}
      )
      select id from down`);
    return result.rows.map((r) => r.id);
  }

  /** the ancestors of a folder, from the top level down (the folder itself is not included) */
  async ancestors(tenantId: string, id: string): Promise<FolderPathRow[]> {
    if (!isUuid(id)) return [];
    const result = await this.db.execute<{ id: string; name: string; depth: number }>(sql`
      with recursive up as (
        select id, name, parent_folder_id, 0 as depth from ${folders}
          where tenant_id = ${tenantId} and id = ${id}::uuid
        union all
        select f.id, f.name, f.parent_folder_id, up.depth + 1 from ${folders} f
          join up on f.id = up.parent_folder_id where f.tenant_id = ${tenantId}
      )
      select id, name, depth from up where depth > 0 order by depth desc`);
    return result.rows.map((r) => ({ id: r.id, name: r.name }));
  }

  /** recursive counts below a folder; archived workflows are not counted */
  async counts(tenantId: string, id: string): Promise<FolderCounts> {
    const ids = await this.subtreeIds(tenantId, id);
    if (!ids.length) return { workflowCount: 0, subFolderCount: 0 };
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          inArray(workflows.folderId, ids),
          eq(workflows.isArchived, false),
        ),
      );
    return { workflowCount: row?.n ?? 0, subFolderCount: ids.length - 1 };
  }

  /** workflows (archived or not) whose folder is one of `folderIds` */
  async workflowsIn(
    tenantId: string,
    folderIds: string[],
  ): Promise<Array<{ id: string; isArchived: boolean }>> {
    const valid = folderIds.filter(isUuid);
    if (!valid.length) return [];
    return this.db
      .select({ id: workflows.id, isArchived: workflows.isArchived })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.folderId, valid)));
  }

  /** every workflow that sits in one of `folderIds` goes to `target` (null = root); returns their ids */
  async moveWorkflows(tenantId: string, folderIds: string[], target: string | null): Promise<string[]> {
    const valid = folderIds.filter(isUuid);
    if (!valid.length) return [];
    const rows = await this.db
      .update(workflows)
      .set({ folderId: target, updatedAt: now() })
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.folderId, valid)))
      .returning({ id: workflows.id });
    return rows.map((r) => r.id);
  }

  /** the direct children of `from` get `to` (null = top level) as their parent */
  async reparentChildren(tenantId: string, from: string, to: string | null): Promise<number> {
    if (!isUuid(from)) return 0;
    const rows = await this.db
      .update(folders)
      .set({ parentFolderId: to, updatedAt: now() })
      .where(and(eq(folders.tenantId, tenantId), eq(folders.parentFolderId, from)))
      .returning({ id: folders.id });
    return rows.length;
  }

  async tagsFor(tenantId: string, folderIds: string[]): Promise<Map<string, TagRef[]>> {
    const valid = folderIds.filter(isUuid);
    const map = new Map<string, TagRef[]>();
    if (!valid.length) return map;
    const rows = await this.db
      .select({ folderId: folderTags.folderId, id: tags.id, name: tags.name })
      .from(folderTags)
      .innerJoin(tags, eq(tags.id, folderTags.tagId))
      .where(
        and(
          eq(folderTags.tenantId, tenantId),
          eq(tags.tenantId, tenantId),
          inArray(folderTags.folderId, valid),
        ),
      )
      .orderBy(asc(tags.name));
    for (const row of rows) {
      const list = map.get(row.folderId) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.folderId, list);
    }
    return map;
  }

  /** replaces the tag set of a folder; the caller has checked that the tags belong to the tenant */
  async setTags(tenantId: string, folderId: string, tagIds: string[]): Promise<void> {
    await this.db
      .delete(folderTags)
      .where(and(eq(folderTags.tenantId, tenantId), eq(folderTags.folderId, folderId)));
    const unique = [...new Set(tagIds)];
    if (unique.length) {
      await this.db.insert(folderTags).values(unique.map((tagId) => ({ tenantId, folderId, tagId })));
    }
  }
}
