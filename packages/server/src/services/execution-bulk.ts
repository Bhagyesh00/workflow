/**
 * P6-85 (L17): stop and delete many runs, in the list filter form of GET /executions (S1), each row checked.
 * - `stopMany` (POST /executions/stopMany `{ filter }`, `ids` in the filter for a selection): only rows of
 *   projects from `accessibleProjectIds(auth, 'workflow:execute')`; answers `{ stopped }`.
 * - `deleteMany` (POST /executions/delete `{ ids, filters, deleteBefore }`): `execution:delete` per row; none
 *   accessible gives "Execution not found"; answers `{ deleted }`.
 * Rows with no workflow id: owner and admin only. Bounded batches.
 * Stub from C0; L17 fills it.
 */
import type { ExecutionMode, ExecutionStatus } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';

/** the GET /executions filter fields a bulk action takes, plus a selection */
export interface ExecutionBulkFilter {
  /** a selection: only these runs (still narrowed by the rest) */
  ids?: string[];
  workflowId?: string;
  projectId?: string;
  status?: ExecutionStatus[];
  mode?: ExecutionMode;
  startedAfter?: Date;
  startedBefore?: Date;
  annotationTags?: string[];
  vote?: 'up' | 'down';
  workflowVersionId?: string;
  customDataKey?: string;
  customDataValue?: string;
  customDataExact?: boolean;
}

export async function stopMany(
  _deps: ServiceDeps,
  _auth: AuthContext,
  _filter: ExecutionBulkFilter,
): Promise<{ stopped: number }> {
  // stub (L17)
  throw new Error('not implemented (L17)');
}

export async function deleteMany(
  _deps: ServiceDeps,
  _auth: AuthContext,
  _input: { ids?: string[]; filters?: ExecutionBulkFilter; deleteBefore?: Date },
): Promise<{ deleted: number }> {
  // stub (L17)
  throw new Error('not implemented (L17)');
}
