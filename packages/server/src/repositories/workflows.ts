/** Workflows, version snapshots and tags. */
import { and, asc, count, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  tags,
  users,
  type WorkflowRow,
  type WorkflowVersionRow,
  workflows,
  workflowTags,
  workflowVersions,
} from '../db/schema';
import type { Cursor } from '../http/pagination';
import { isUuid, now } from './util';

export interface TagRef {
  id: string;
  name: string;
}

export interface WorkflowSummaryRow {
  id: string;
  name: string;
  active: boolean;
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
}

export class WorkflowRepository {
  constructor(private readonly db: DbOrTx) {}

  async list(
    tenantId: string,
    filter: { search?: string; tagId?: string; active?: boolean; limit: number; cursor?: Cursor },
  ): Promise<WorkflowSummaryRow[]> {
    const conditions = [eq(workflows.tenantId, tenantId)];
    if (filter.search) conditions.push(ilike(workflows.name, `%${escapeLike(filter.search)}%`));
    if (filter.active !== undefined) conditions.push(eq(workflows.active, filter.active));
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
    input: WorkflowContent & { id?: string; versionId: string; createdBy?: string },
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
    patch: Partial<WorkflowContent> & { versionId: string },
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

  async setActive(tenantId: string, id: string, active: boolean): Promise<WorkflowRow | undefined> {
    const [row] = await this.db
      .update(workflows)
      .set({ active })
      .where(and(eq(workflows.tenantId, tenantId), eq(workflows.id, id)))
      .returning();
    return row;
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
