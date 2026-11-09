/**
 * Per-user favorites (P3-07, P4-03, P6-26): workflows, folders, data tables and projects. A user only ever sees and changes their own.
 */
import type { Scope } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { FavoriteResourceType } from '../repositories';
import { type AccessFilter, type AccessTarget, MISSING_SCOPE_MESSAGE } from './access';

export interface FavoriteDTO {
  resourceType: FavoriteResourceType;
  resourceId: string;
  /** workflow, folder, data table or project name */
  name: string;
  createdAt: string;
}

/** the read scope a favorite needs on its target, and the access target that scope is checked on */
const READ_SCOPE: Record<FavoriteResourceType, Scope> = {
  workflow: 'workflow:read',
  folder: 'folder:read',
  dataTable: 'dataTable:read',
  project: 'project:read',
};

const targetOf = (type: FavoriteResourceType, id: string): AccessTarget => {
  if (type === 'workflow') return { workflowId: id };
  if (type === 'folder') return { folderId: id };
  if (type === 'dataTable') return { dataTableId: id };
  return { projectId: id };
};

/** whether the access filter of the read scope reaches a row (its owning project, or the row itself for a shared workflow) */
const reaches = (filter: AccessFilter, projectId: string, workflowId?: string): boolean =>
  filter.all ||
  filter.projectIds.includes(projectId) ||
  (workflowId !== undefined && filter.workflowIds.includes(workflowId));

export class FavoriteService {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * The caller's favorites. A favorite the caller can no longer read (a lost project, a removed member, a
   * narrowed role) is left out; the row stays, so it returns when the access does.
   */
  async list(auth: AuthContext): Promise<FavoriteDTO[]> {
    const { access } = this.deps.context();
    const rows = await this.deps.repos.favorites.list(auth.tenant.id, auth.user.id);
    const types = [...new Set(rows.map((r) => r.resourceType))];
    const filters = new Map<FavoriteResourceType, AccessFilter>();
    for (const type of types) filters.set(type, await access.listFilter(auth, READ_SCOPE[type]));
    return rows
      .filter((r) =>
        reaches(filters.get(r.resourceType)!, r.projectId, r.resourceType === 'workflow' ? r.resourceId : undefined),
      )
      .map((r) => ({
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
      }));
  }

  /** idempotent; the resource must belong to the tenant (404 otherwise) and the caller must hold its read scope (403) */
  async add(
    auth: AuthContext,
    type: FavoriteResourceType,
    resourceId: string,
  ): Promise<FavoriteDTO> {
    const { access, repos } = this.deps.context();
    const tenantId = auth.tenant.id;
    // the target is looked up first (another workspace's id and a non-uuid id are the 404 of `scopesFor`)
    const held = await access.scopesForAuth(auth, targetOf(type, resourceId));
    if (!held.has(READ_SCOPE[type])) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    let name: string;
    if (type === 'workflow') {
      const row = await repos.workflows.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Workflow');
      name = row.name;
    } else if (type === 'folder') {
      const row = await repos.folders.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Folder');
      name = row.name;
    } else if (type === 'dataTable') {
      const row = await repos.dataTables.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Data table');
      name = row.name;
    } else {
      const row = await repos.projects.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Project');
      name = row.name;
    }
    const createdAt = await repos.favorites.add(tenantId, auth.user.id, type, resourceId);
    return { resourceType: type, resourceId, name, createdAt: createdAt.toISOString() };
  }

  /** idempotent */
  async remove(
    tenantId: string,
    userId: string,
    type: FavoriteResourceType,
    resourceId: string,
  ): Promise<void> {
    await this.deps.repos.favorites.remove(tenantId, userId, type, resourceId);
  }

  /** called when a workflow, folder or data table is deleted, BEFORE its row goes */
  async removeForResource(tenantId: string, type: FavoriteResourceType, resourceId: string): Promise<void> {
    await this.deps.repos.favorites.removeForResource(tenantId, type, resourceId);
  }
}
