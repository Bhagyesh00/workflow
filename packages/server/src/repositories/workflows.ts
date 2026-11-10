/** Workflows, version snapshots and tags. */
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  tags,
  users,
  type WorkflowRow,
  type WorkflowVersionRow,
  workflowShares,
  workflows,
  workflowTags,
  workflowVersions,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { type AccessListOptions, sharedRowConditions } from './shares';
import { isUuid, now } from './util';

export interface TagRef {
  id: string;
  name: string;
}

export interface WorkflowSummaryRow {
  id: string;
  name: string;
  active: boolean;
  isArchived: boolean;
  folderId: string | null;
  /** P6-22: the owning project */
  projectId: string;
  publishedVersionId: string | null;
  updatedAt: Date;
  createdAt: Date;
  nodeTypes: string[];
}

export interface WorkflowContent {
  name: string;
  nodes: unknown[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  stickyNotes: unknown[];
  /** canvas groups (P3-04); the column defaults to [] */
  nodeGroups?: unknown[];
}

/** with `AccessListOptions` (P6-22): `filter`, `projectId`, `onlySharedWithMe` */
export interface WorkflowListFilter extends AccessListOptions {
  /** name ILIKE; with `nodeTypes` / `matchTags` also a node type or a tag name (command bar, P3-01) */
  search?: string;
  /** node type ids whose display name matches `search` (at most 20 are used) */
  nodeTypes?: string[];
  /** with `search`: also match workflows having a tag whose name ILIKEs the search */
  matchTags?: boolean;
  tagId?: string;
  active?: boolean;
  /** a folder id, 'root' (no folder) or omitted (every folder) */
  folderId?: string;
  /**
   * P6-49 (S3): only workflows with a node of one of these types (`executionBlockedBy=restrictedNode`);
   * an empty list matches none. Type only from C0: L4 writes the query (ignored until then).
   */
  usesNodeTypes?: string[];
  /** 'false' (default) hides archived workflows, 'true' shows only them, 'all' both */
  archived?: 'false' | 'true' | 'all';
  limit: number;
  cursor?: Cursor;
}

export class WorkflowRepository {
  constructor(private readonly db: DbOrTx) {}

  async list(tenantId: string, filter: WorkflowListFilter): Promise<WorkflowSummaryRow[]> {
    const access = sharedRowConditions({
      tenantId,
      kind: 'workflow',
      id: workflows.id,
      project: workflows.projectId,
      options: filter,
    });
    if (!access) return [];
    const conditions = [eq(workflows.tenantId, tenantId), ...access];
    if (filter.search) {
      const pattern = `%${escapeLike(filter.search)}%`;
      const alternatives = [sql`${workflows.name} ilike ${pattern}`];
      const types = (filter.nodeTypes ?? []).slice(0, 20);
      if (types.length) {
        alternatives.push(
          sql`exists (select 1 from jsonb_array_elements(${workflows.nodes}) n where n->>'type' in (${sql.join(
            types.map((t) => sql`${t}`),
            sql`, `,
          )}))`,
        );
      }
      if (filter.matchTags) {
        alternatives.push(
          sql`exists (select 1 from ${workflowTags} wt join ${tags} t on t.id = wt.tag_id where wt.workflow_id = ${workflows.id} and wt.tenant_id = ${tenantId}::uuid and t.name ilike ${pattern})`,
        );
      }
      conditions.push(
        alternatives.length === 1 ? alternatives[0] : sql`(${sql.join(alternatives, sql` or `)})`,
      );
    }
    if (filter.active !== undefined) conditions.push(eq(workflows.active, filter.active));
    const archived = filter.archived ?? 'false';
    if (archived !== 'all') conditions.push(eq(workflows.isArchived, archived === 'true'));
    if (filter.folderId !== undefined) {
      if (filter.folderId === 'root') conditions.push(isNull(workflows.folderId));
      else if (!isUuid(filter.folderId)) return [];
      else conditions.push(eq(workflows.folderId, filter.folderId));
    }
    if (filter.tagId) {
      if (!isUuid(filter.tagId)) return [];
      conditions.push(
        sql`exists (select 1 from ${workflowTags} wt where wt.workflow_id = ${workflows.id} and wt.tag_id = ${filter.tagId}::uuid and wt.tenant_id = ${tenantId}::uuid)`,
      );
    }
    if (filter.cursor) {
      if (!isUuid(filter.cursor.id)) return [];
      conditions.push(
        sql`(${workflows.updatedAt}, ${workflows.id}) < (${filter.cursor.value}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    return this.db
      .select({
        id: workflows.id,
        name: workflows.name,
        active: workflows.active,
        isArchived: workflows.isArchived,
        folderId: workflows.folderId,
        projectId: workflows.projectId,
        publishedVersionId: workflows.publishedVersionId,
        updatedAt: workflows.updatedAt,
        createdAt: workflows.createdAt,
        nodeTypes: sql<
          string[]
        >`(select coalesce(array_agg(distinct n->>'type'), '{}') from jsonb_array_elements(${workflows.nodes}) n)`,
      })
      .from(workflows)
      .where(and(...conditions))
      .orderBy(desc(workflows.updatedAt), desc(workflows.id))
      .limit(filter.limit + 1);
  }

  /** P6-22: the projects each workflow is shared with (`sharedWithProjects` of list rows and GET one) */
  async sharedProjectIds(tenantId: string, workflowIds: string[]): Promise<Map<string, string[]>> {
    const ids = workflowIds.filter(isUuid);
    const result = new Map<string, string[]>();
    if (!ids.length) return result;
    const rows = await this.db
      .select({ workflowId: workflowShares.workflowId, projectId: workflowShares.projectId })
      .from(workflowShares)
      .where(and(eq(workflowShares.tenantId, tenantId), inArray(workflowShares.workflowId, ids)));
    for (const row of rows)
      result.set(row.workflowId, [...(result.get(row.workflowId) ?? []), row.projectId]);
    return result;
  }

  async get(tenantId: string, id: string): Promise<WorkflowRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)));
    return row;
  }

  async create(
    tenantId: string,
    input: WorkflowContent & {
      id?: string;
      versionId: string;
      createdBy?: string;
      folderId?: string | null;
      /** the owning project (P6-22) */
      projectId: string;
    },
  ): Promise<WorkflowRow> {
    const [row] = await this.db
      .insert(workflows)
      .values({ ...input, tenantId, createdAt: now(), updatedAt: now() })
      .returning();
    return row;
  }

  /**
   * Update with optimistic concurrency: when `expectedVersionId` is given the row is only
   * updated if it still has that version. Returns 'conflict' on a version mismatch.
   */
  async update(
    tenantId: string,
    id: string,
    expectedVersionId: string | undefined,
    patch: Partial<WorkflowContent> & { versionId: string; folderId?: string | null },
  ): Promise<WorkflowRow | 'conflict' | undefined> {
    if (!isUuid(id)) return undefined;
    const conditions = [eq(workflows.tenantId, tenantId), eq(workflows.id, id)];
    if (expectedVersionId) {
      if (!isUuid(expectedVersionId)) return 'conflict';
      conditions.push(eq(workflows.versionId, expectedVersionId));
    }
    const [row] = await this.db
      .update(workflows)
      .set({ ...patch, updatedAt: now() })
      .where(and(...conditions))
      .returning();
    if (row) return row;
    return (await this.get(tenantId, id)) ? 'conflict' : undefined;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(workflows)
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
      .returning({ id: workflows.id });
    return rows.length > 0;
  }

  /**
   * Keeps the published pointer in step until L10 retires these callers: true publishes the
   * current version (pointer = version_id), false clears the pointer.
   */
  async setActive(tenantId: string, id: string, active: boolean): Promise<WorkflowRow | undefined> {
    const [row] = await this.db
      .update(workflows)
      .set({ active, publishedVersionId: active ? sql`${workflows.versionId}` : null })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
      .returning();
    return row;
  }

  /** publish a version (pointer and active together); null unpublishes */
  async setPublished(
    tenantId: string,
    id: string,
    versionId: string | null,
  ): Promise<WorkflowRow | undefined> {
    if (!isUuid(id) || (versionId !== null && !isUuid(versionId))) return undefined;
    const [row] = await this.db
      .update(workflows)
      .set({ publishedVersionId: versionId, active: versionId !== null })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
      .returning();
    return row;
  }

  async setArchived(tenantId: string, id: string, archived: boolean): Promise<WorkflowRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(workflows)
      .set({ isArchived: archived, updatedAt: now() })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
      .returning();
    return row;
  }

  /** move workflows to a folder (null = root); returns the ids that moved */
  async setFolder(tenantId: string, ids: string[], folderId: string | null): Promise<string[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length || (folderId !== null && !isUuid(folderId))) return [];
    const rows = await this.db
      .update(workflows)
      .set({ folderId, updatedAt: now() })
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, valid)))
      .returning({ id: workflows.id });
    return rows.map((r) => r.id);
  }

  async setStaticData(tenantId: string, id: string, staticData: Record<string, unknown>): Promise<void> {
    await this.db
      .update(workflows)
      .set({ staticData })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)));
  }

  async countActive(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.active, true)));
    return Number(row?.n ?? 0);
  }

  /** system tooling (startup reactivation, metrics): active workflows of every tenant */
  async listActiveAcrossTenants(): Promise<Array<{ id: string; tenantId: string }>> {
    return this.db
      .select({ id: workflows.id, tenantId: workflows.tenantId })
      .from(workflows)
      .where(eq(workflows.active, true));
  }

  async tagsFor(tenantId: string, workflowIds: string[]): Promise<Map<string, TagRef[]>> {
    const map = new Map<string, TagRef[]>();
    if (!workflowIds.length) return map;
    const rows = await this.db
      .select({ workflowId: workflowTags.workflowId, id: tags.id, name: tags.name })
      .from(workflowTags)
      .innerJoin(tags, eq(tags.id, workflowTags.tagId))
      .where(and(eq(workflowTags.tenantId, tenantId), inArray(workflowTags.workflowId, workflowIds)))
      .orderBy(asc(tags.name));
    for (const r of rows) {
      const list = map.get(r.workflowId) ?? [];
      list.push({ id: r.id, name: r.name });
      map.set(r.workflowId, list);
    }
    return map;
  }

  async setTags(tenantId: string, workflowId: string, tagIds: string[]): Promise<void> {
    await this.db
      .delete(workflowTags)
      .where(and(eq(workflowTags.tenantId, tenantId), eq(workflowTags.workflowId, workflowId)));
    if (tagIds.length) {
      await this.db
        .insert(workflowTags)
        .values(tagIds.map((tagId) => ({ tenantId, workflowId, tagId })))
        .onConflictDoNothing();
    }
  }
}

export class WorkflowVersionRepository {
  constructor(private readonly db: DbOrTx) {}

  async create(
    tenantId: string,
    input: Omit<typeof workflowVersions.$inferInsert, 'tenantId'>,
  ): Promise<void> {
    await this.db.insert(workflowVersions).values({ ...input, tenantId, createdAt: now() });
  }

  async list(tenantId: string, workflowId: string, limit: number, cursor?: Cursor) {
    const conditions = [eq(workflowVersions.tenantId, tenantId), eq(workflowVersions.workflowId, workflowId)];
    if (cursor) {
      if (!isUuid(cursor.id)) return [];
      conditions.push(
        sql`(${workflowVersions.createdAt}, ${workflowVersions.id}) < (${cursor.value}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    return this.db
      .select({
        versionId: workflowVersions.id,
        authorName: users.name,
        message: workflowVersions.message,
        versionName: workflowVersions.versionName,
        description: workflowVersions.description,
        autosaved: workflowVersions.autosaved,
        createdAt: workflowVersions.createdAt,
      })
      .from(workflowVersions)
      .leftJoin(users, eq(users.id, workflowVersions.authorId))
      .where(and(...conditions))
      .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
      .limit(limit + 1);
  }

  async get(
    tenantId: string,
    workflowId: string,
    versionId: string,
  ): Promise<(WorkflowVersionRow & { authorName: string | null }) | undefined> {
    if (!isUuid(versionId)) return undefined;
    const [row] = await this.db
      .select({ version: workflowVersions, authorName: users.name })
      .from(workflowVersions)
      .leftJoin(users, eq(users.id, workflowVersions.authorId))
      .where(
        and(
          eq(workflowVersions.tenantId, tenantId),
          eq(workflowVersions.workflowId, workflowId),
          eq(workflowVersions.id, versionId),
        ),
      );
    return row ? { ...row.version, authorName: row.authorName } : undefined;
  }

  /** name or describe a version (P3-10); undefined fields stay, null clears */
  async update(
    tenantId: string,
    workflowId: string,
    versionId: string,
    patch: { versionName?: string | null; description?: string | null },
  ): Promise<WorkflowVersionRow | undefined> {
    if (!isUuid(versionId)) return undefined;
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return (await this.get(tenantId, workflowId, versionId)) ?? undefined;
    const [row] = await this.db
      .update(workflowVersions)
      .set(set)
      .where(
        and(
          eq(workflowVersions.tenantId, tenantId),
          eq(workflowVersions.workflowId, workflowId),
          eq(workflowVersions.id, versionId),
        ),
      )
      .returning();
    return row;
  }
}

export class TagRepository {
  constructor(private readonly db: DbOrTx) {}

  async list(tenantId: string) {
    return this.db
      .select({
        id: tags.id,
        name: tags.name,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
        usageCount: sql<number>`(select count(*)::int from ${workflowTags} wt where wt.tag_id = ${tags.id})`,
      })
      .from(tags)
      .where(eq(tags.tenantId, tenantId))
      .orderBy(asc(tags.name));
  }

  async get(tenantId: string, id: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)));
    return row;
  }

  async getByName(tenantId: string, name: string) {
    const [row] = await this.db
      .select()
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.name, name)));
    return row;
  }

  /** ids that exist in this tenant */
  async existing(tenantId: string, ids: string[]): Promise<string[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length) return [];
    const rows = await this.db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, valid)));
    return rows.map((r) => r.id);
  }

  async create(tenantId: string, name: string) {
    const [row] = await this.db
      .insert(tags)
      .values({ tenantId, name, createdAt: now(), updatedAt: now() })
      .returning();
    return row;
  }

  async rename(tenantId: string, id: string, name: string) {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(tags)
      .set({ name, updatedAt: now() })
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)))
      .returning();
    return row;
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)))
      .returning({ id: tags.id });
    return rows.length > 0;
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
