/**
 * Per-user favorites (P3-07): workflows and folders. A user only ever sees and changes their own.
 */
import type { ServiceDeps } from '../context';
import { ApiError } from '../http/errors';
import type { FavoriteResourceType } from '../repositories';

export interface FavoriteDTO {
  resourceType: FavoriteResourceType;
  resourceId: string;
  /** workflow or folder name */
  name: string;
  createdAt: string;
}

export class FavoriteService {
  constructor(readonly deps: ServiceDeps) {}

  async list(tenantId: string, userId: string): Promise<FavoriteDTO[]> {
    const rows = await this.deps.repos.favorites.list(tenantId, userId);
    return rows.map((r) => ({
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** idempotent; the resource must belong to the tenant (404 otherwise) */
  async add(
    tenantId: string,
    userId: string,
    type: FavoriteResourceType,
    resourceId: string,
  ): Promise<FavoriteDTO> {
    const { repos } = this.deps;
    let name: string;
    if (type === 'workflow') {
      const row = await repos.workflows.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Workflow');
      name = row.name;
    } else {
      const row = await repos.folders.get(tenantId, resourceId);
      if (!row) throw ApiError.notFound('Folder');
      name = row.name;
    }
    const createdAt = await repos.favorites.add(tenantId, userId, type, resourceId);
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

  /** called when a workflow or folder is deleted, BEFORE its row goes */
  async removeForResource(tenantId: string, type: FavoriteResourceType, resourceId: string): Promise<void> {
    await this.deps.repos.favorites.removeForResource(tenantId, type, resourceId);
  }
}
