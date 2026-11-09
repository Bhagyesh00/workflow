/**
 * Archive, unarchive and move workflows (P3-07, as n8n): archive unpublishes first; unarchive does
 * not republish; the editor archives an archived workflow with 400, the public API answers 200.
 */
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';
import type { WorkflowDTO } from './workflow-model';
import { assertFolderInTenant, assertNotArchived } from './workflow-rules';
import type { Actor } from './workflows';

export class WorkflowArchiveService {
  constructor(readonly deps: ServiceDeps) {}

  async archive(
    tenantId: string,
    id: string,
    actor: Actor,
    options: { publicApi?: boolean } = {},
  ): Promise<WorkflowDTO> {
    const { workflows, activeWorkflows, publishHistory, reviews, repos } = this.deps.context();
    const row = await workflows.get(tenantId, id);
    if (row.isArchived) {
      if (options.publicApi) return workflows.dto(tenantId, row);
      throw ApiError.badRequest('The workflow is already archived.');
    }
    // unpublish first, then archive
    const unpublished = row.active;
    if (unpublished) {
      await activeWorkflows.deactivate(tenantId, id);
      await publishHistory.record('deactivated', {
        tenantId,
        workflowId: id,
        versionId: row.publishedVersionId ?? row.versionId,
        userId: actor.userId,
      });
    }
    await repos.workflows.setArchived(tenantId, id, true);
    await reviews.afterWorkflowArchived(tenantId, id);
    await repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.archived',
      resourceType: 'workflow',
      resourceId: id,
      metadata: { unpublished },
      ip: actor.ip,
    });
    return workflows.dto(tenantId, await workflows.get(tenantId, id));
  }

  /** the workflow stays unpublished */
  async unarchive(tenantId: string, id: string, actor: Actor): Promise<WorkflowDTO> {
    const { workflows, repos } = this.deps.context();
    const row = await workflows.get(tenantId, id);
    if (!row.isArchived) throw ApiError.badRequest('The workflow is not archived.');
    await repos.workflows.setArchived(tenantId, id, false);
    await repos.audit.add(tenantId, {
      userId: actor.userId,
      action: 'workflow.unarchived',
      resourceType: 'workflow',
      resourceId: id,
      ip: actor.ip,
    });
    return workflows.dto(tenantId, await workflows.get(tenantId, id));
  }

  /** move workflows to a folder (null = root); every id must belong to the tenant (404) and be unarchived (400) */
  async move(
    tenantId: string,
    workflowIds: string[],
    folderId: string | null,
    actor: Actor,
  ): Promise<{ moved: string[] }> {
    const { repos } = this.deps;
    await assertFolderInTenant(repos, tenantId, folderId);
    // P6-22: every workflow and the folder are in one project
    const folder = folderId ? await repos.folders.get(tenantId, folderId) : undefined;
    const unique = [...new Set(workflowIds)];
    for (const id of unique) {
      const row = await repos.workflows.get(tenantId, id);
      if (!row) throw ApiError.notFound('Workflow');
      assertNotArchived(row, 'update');
      if (folder && row.projectId !== folder.projectId) {
        throw ApiError.badRequest('The workflows and the folder must be in the same project.');
      }
    }
    const moved = await repos.workflows.setFolder(tenantId, unique, folderId);
    for (const id of moved) {
      await repos.audit.add(tenantId, {
        userId: actor.userId,
        action: 'workflow.moved',
        resourceType: 'workflow',
        resourceId: id,
        metadata: { folderId },
        ip: actor.ip,
      });
    }
    return { moved };
  }
}
