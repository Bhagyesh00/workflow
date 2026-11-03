/**
 * Archive and folder rules shared by the workflow, execution and activation paths (P3-07, as n8n):
 * an archived workflow cannot be updated, activated or called as a sub-workflow; the editor deletes
 * only archived workflows (the public API forces); a folder id must belong to the tenant.
 */
import type { WorkflowRow } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Repositories } from '../repositories';

export type ArchivedAction = 'update' | 'activate' | 'call';

const ARCHIVED_MESSAGE: Record<ArchivedAction, (name: string) => string> = {
  update: () => 'The workflow is archived and cannot be changed. Restore it first.',
  activate: () => 'The workflow is archived and cannot be published. Restore it first.',
  call: (name) => `Workflow "${name}" is archived and cannot be called. Restore it first.`,
};

/** throws (400) when the workflow is archived */
export function assertNotArchived(
  row: Pick<WorkflowRow, 'id' | 'name' | 'isArchived'>,
  action: ArchivedAction,
): void {
  if (row.isArchived) throw ApiError.badRequest(ARCHIVED_MESSAGE[action](row.name));
}

/** throws (400) when the workflow may not be deleted yet (not archived and not forced) */
export function assertDeletable(
  row: Pick<WorkflowRow, 'id' | 'isArchived'>,
  options: { force?: boolean } = {},
): void {
  if (!row.isArchived && !options.force) {
    throw ApiError.badRequest('The workflow must be archived before it can be deleted.');
  }
}

/** throws (404) when `folderId` is not a folder of the tenant; null / undefined = root, always allowed */
export async function assertFolderInTenant(
  repos: Repositories,
  tenantId: string,
  folderId: string | null | undefined,
): Promise<void> {
  if (folderId === null || folderId === undefined) return;
  if (!(await repos.folders.get(tenantId, folderId))) throw ApiError.notFound('Folder');
}
