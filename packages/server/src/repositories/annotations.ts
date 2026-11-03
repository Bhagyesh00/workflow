/**
 * Execution annotations (P3-09): vote and annotation tags per execution, and the annotation tag list.
 * Every query filters tenant_id.
 */
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type AnnotationTagRow,
  annotationTags,
  executionAnnotations,
  executionAnnotationTags,
  executions,
} from '../db/schema';
import { isUuid, now } from './util';

export type AnnotationVote = 'up' | 'down';

export interface ExecutionAnnotationDTO {
  vote: AnnotationVote | null;
  tags: Array<{ id: string; name: string }>;
}

export interface AnnotationFilter {
  /** annotation tag ids; an execution matches when it has all of them (AND, decisions D2) */
  tags?: string[];
  vote?: AnnotationVote;
}

/** extra WHERE conditions for the execution list (ExecutionRepository.list appends them) */
export function annotationConditions(tenantId: string, filter: AnnotationFilter): SQL[] {
  const conditions: SQL[] = [];
  for (const tagId of new Set(filter.tags ?? [])) {
    if (!isUuid(tagId)) {
      conditions.push(sql`false`);
      continue;
    }
    conditions.push(sql`exists (select 1 from ${executionAnnotationTags} eat
      where eat.execution_id = ${executions.id} and eat.tenant_id = ${tenantId}::uuid
        and eat.tag_id = ${tagId}::uuid)`);
  }
  if (filter.vote) {
    conditions.push(sql`exists (select 1 from ${executionAnnotations} ea
      where ea.execution_id = ${executions.id} and ea.tenant_id = ${tenantId}::uuid
        and ea.vote = ${filter.vote})`);
  }
  return conditions;
}

export class AnnotationRepository {
  constructor(readonly db: DbOrTx) {}

  /** annotations of the given executions, keyed by execution id (executions without one are absent) */
  async forExecutions(
    tenantId: string,
    executionIds: string[],
  ): Promise<Map<string, ExecutionAnnotationDTO>> {
    const result = new Map<string, ExecutionAnnotationDTO>();
    const valid = executionIds.filter(isUuid);
    if (!valid.length) return result;
    const votes = await this.db
      .select({ executionId: executionAnnotations.executionId, vote: executionAnnotations.vote })
      .from(executionAnnotations)
      .where(
        and(eq(executionAnnotations.tenantId, tenantId), inArray(executionAnnotations.executionId, valid)),
      );
    const tagRows = await this.db
      .select({
        executionId: executionAnnotationTags.executionId,
        id: annotationTags.id,
        name: annotationTags.name,
      })
      .from(executionAnnotationTags)
      .innerJoin(annotationTags, eq(annotationTags.id, executionAnnotationTags.tagId))
      .where(
        and(
          eq(executionAnnotationTags.tenantId, tenantId),
          eq(annotationTags.tenantId, tenantId),
          inArray(executionAnnotationTags.executionId, valid),
        ),
      )
      .orderBy(asc(annotationTags.name), asc(annotationTags.id));
    for (const v of votes) result.set(v.executionId, { vote: v.vote, tags: [] });
    for (const t of tagRows) {
      const entry = result.get(t.executionId) ?? { vote: null, tags: [] };
      entry.tags.push({ id: t.id, name: t.name });
      result.set(t.executionId, entry);
    }
    return result;
  }

  /** set the vote (undefined keeps it, null clears it) and / or replace the tag set (undefined keeps it) */
  async setAnnotation(
    tenantId: string,
    executionId: string,
    patch: { tagIds?: string[]; vote?: AnnotationVote | null },
  ): Promise<void> {
    if (patch.vote !== undefined) {
      await this.db
        .insert(executionAnnotations)
        .values({ executionId, tenantId, vote: patch.vote, updatedAt: now() })
        .onConflictDoUpdate({
          target: executionAnnotations.executionId,
          set: { vote: patch.vote, updatedAt: now() },
        });
    }
    if (patch.tagIds !== undefined) {
      await this.db
        .delete(executionAnnotationTags)
        .where(
          and(
            eq(executionAnnotationTags.tenantId, tenantId),
            eq(executionAnnotationTags.executionId, executionId),
          ),
        );
      if (patch.tagIds.length) {
        await this.db
          .insert(executionAnnotationTags)
          .values(patch.tagIds.map((tagId) => ({ executionId, tagId, tenantId })));
      }
    }
  }

  /** drop the vote row when nothing is left to say about the execution */
  async pruneEmpty(tenantId: string, executionId: string): Promise<void> {
    await this.db.delete(executionAnnotations).where(
      and(
        eq(executionAnnotations.tenantId, tenantId),
        eq(executionAnnotations.executionId, executionId),
        sql`${executionAnnotations.vote} is null`,
        sql`not exists (select 1 from ${executionAnnotationTags} eat
          where eat.execution_id = ${executionAnnotations.executionId} and eat.tenant_id = ${tenantId}::uuid)`,
      ),
    );
  }

  // annotation tags ---------------------------------------------------------------------------

  async listTags(tenantId: string, withUsageCount: boolean) {
    const rows = await this.db
      .select({
        id: annotationTags.id,
        name: annotationTags.name,
        createdAt: annotationTags.createdAt,
        updatedAt: annotationTags.updatedAt,
        usageCount: sql<number>`(select count(*)::int from ${executionAnnotationTags} eat
          where eat.tag_id = ${annotationTags.id} and eat.tenant_id = ${tenantId}::uuid)`,
      })
      .from(annotationTags)
      .where(eq(annotationTags.tenantId, tenantId))
      .orderBy(asc(sql`lower(${annotationTags.name})`), asc(annotationTags.id));
    return rows.map(({ usageCount, ...rest }) => (withUsageCount ? { ...rest, usageCount } : rest));
  }

  async getTagByName(tenantId: string, name: string): Promise<AnnotationTagRow | undefined> {
    const [row] = await this.db
      .select()
      .from(annotationTags)
      .where(and(eq(annotationTags.tenantId, tenantId), sql`lower(${annotationTags.name}) = lower(${name})`));
    return row;
  }

  /** ids that exist in this tenant */
  async existingTags(tenantId: string, ids: string[]): Promise<string[]> {
    const valid = ids.filter(isUuid);
    if (!valid.length) return [];
    const rows = await this.db
      .select({ id: annotationTags.id })
      .from(annotationTags)
      .where(and(eq(annotationTags.tenantId, tenantId), inArray(annotationTags.id, valid)));
    return rows.map((r) => r.id);
  }

  async createTag(tenantId: string, name: string): Promise<AnnotationTagRow> {
    const [row] = await this.db
      .insert(annotationTags)
      .values({ tenantId, name, createdAt: now(), updatedAt: now() })
      .returning();
    return row;
  }

  async renameTag(tenantId: string, id: string, name: string): Promise<AnnotationTagRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(annotationTags)
      .set({ name, updatedAt: now() })
      .where(and(eq(annotationTags.tenantId, tenantId), eq(annotationTags.id, id)))
      .returning();
    return row;
  }

  /** the link rows go with the tag (cascade) */
  async deleteTag(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(annotationTags)
      .where(and(eq(annotationTags.tenantId, tenantId), eq(annotationTags.id, id)))
      .returning({ id: annotationTags.id });
    return rows.length > 0;
  }
}
