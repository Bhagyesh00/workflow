/**
 * Execution annotations (P3-09): PATCH /executions/:id {tags?, vote?} and the annotation tags
 * (/rest/annotation-tags). Tag ids are checked against the tenant before anything is written.
 */
import type { ServiceDeps } from '../context';
import type { AnnotationTagRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { AnnotationVote, ExecutionAnnotationDTO } from '../repositories';
import { createRepositories, isUniqueViolation } from '../repositories';
import type { Actor } from './workflows';

export const annotationTagDTO = (
  t: Pick<AnnotationTagRow, 'id' | 'name' | 'createdAt' | 'updatedAt'> & { usageCount?: number },
) => ({
  id: t.id,
  name: t.name,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
  ...(t.usageCount !== undefined ? { usageCount: t.usageCount } : {}),
});

export class AnnotationService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  /**
   * Replace the execution tags and / or set its vote (null clears it). Returns the annotation, or
   * null when it is now empty. The caller has checked the execution belongs to the tenant.
   */
  async annotate(
    tenantId: string,
    executionId: string,
    patch: { tags?: string[]; vote?: AnnotationVote | null },
    actor: Actor,
  ): Promise<ExecutionAnnotationDTO | null> {
    let tagIds: string[] | undefined;
    if (patch.tags !== undefined) {
      tagIds = [...new Set(patch.tags)];
      const existing = await this.repos.annotations.existingTags(tenantId, tagIds);
      if (existing.length !== tagIds.length) throw ApiError.notFound('Annotation tag');
    }
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      await repos.annotations.setAnnotation(tenantId, executionId, { tagIds, vote: patch.vote });
      await repos.annotations.pruneEmpty(tenantId, executionId);
    });
    await this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'execution.annotated',
      resourceType: 'execution',
      resourceId: executionId,
      metadata: { tagsChanged: tagIds !== undefined, voteChanged: patch.vote !== undefined },
      ip: actor.ip,
    });
    return (await this.repos.annotations.forExecutions(tenantId, [executionId])).get(executionId) ?? null;
  }

  async listTags(tenantId: string, withUsageCount: boolean) {
    return (await this.repos.annotations.listTags(tenantId, withUsageCount)).map(annotationTagDTO);
  }

  async createTag(tenantId: string, name: string, actor: Actor) {
    if (await this.repos.annotations.getTagByName(tenantId, name)) throw this.duplicate(name);
    try {
      const row = await this.repos.annotations.createTag(tenantId, name);
      await this.audit(tenantId, 'annotation_tag.created', row.id, actor);
      return annotationTagDTO(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicate(name);
      throw error;
    }
  }

  async renameTag(tenantId: string, id: string, name: string, actor: Actor) {
    const clash = await this.repos.annotations.getTagByName(tenantId, name);
    if (clash && clash.id !== id) throw this.duplicate(name);
    let row: AnnotationTagRow | undefined;
    try {
      row = await this.repos.annotations.renameTag(tenantId, id, name);
    } catch (error) {
      if (isUniqueViolation(error)) throw this.duplicate(name);
      throw error;
    }
    if (!row) throw ApiError.notFound('Annotation tag');
    await this.audit(tenantId, 'annotation_tag.updated', row.id, actor);
    return annotationTagDTO(row);
  }

  async deleteTag(tenantId: string, id: string, actor: Actor): Promise<void> {
    if (!(await this.repos.annotations.deleteTag(tenantId, id))) throw ApiError.notFound('Annotation tag');
    await this.audit(tenantId, 'annotation_tag.deleted', id, actor);
  }

  private duplicate(name: string) {
    return ApiError.conflict(`An annotation tag named "${name}" already exists`);
  }

  private audit(tenantId: string, action: string, id: string, actor: Actor) {
    return this.repos.audit.add(tenantId, {
      userId: actor.userId,
      action,
      resourceType: 'annotation_tag',
      resourceId: id,
      ip: actor.ip,
    });
  }
}
