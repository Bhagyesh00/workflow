/**
 * Archive and folder rules shared by the workflow, execution and activation paths (P3-07, as n8n):
 * an archived workflow cannot be updated, activated or called as a sub-workflow; the editor deletes
 * only archived workflows (the public API forces); a folder id must belong to the tenant.
 *
 * C0 STUB: lane L8 writes the bodies (today: no-ops, so every caller keeps working).
 */
import type { WorkflowRow } from '../db/schema';
import type { Repositories } from '../repositories';

export type ArchivedAction = 'update' | 'activate' | 'call';

/** throws (400) when the workflow is archived */
export function assertNotArchived(
  _row: Pick<WorkflowRow, 'id' | 'name' | 'isArchived'>,
  _action: ArchivedAction,
): void {}

/** throws (400) when the workflow may not be deleted yet (not archived and not forced) */
export function assertDeletable(
  _row: Pick<WorkflowRow, 'id' | 'isArchived'>,
  _options: { force?: boolean } = {},
): void {}

/** throws (404) when `folderId` is not a folder of the tenant; null / undefined = root, always allowed */
export async function assertFolderInTenant(
  _repos: Repositories,
  _tenantId: string,
  _folderId: string | null | undefined,
): Promise<void> {}
