/**
 * P6-07 (L4): the pull steps (internal to `SourceControlSyncService.pull`): fetch and parse, conflicts and local
 * changes without `force` give 409, every incoming git id gets a local id first (`allocate`), then the writes in
 * n8n's order (projects, folders, credentials, workflows, deletes, tags, variables, data tables) through the
 * services inside `withPullWrites`, the `contentImport` policy per workflow, then `autoPublish`.
 * stub (L4): throws.
 */
import type { PullResult, PullWorkFolderBody } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';

/** stub (L4) */
export function pullWorkFolder(
  _deps: ServiceDeps,
  _auth: AuthContext,
  _body: PullWorkFolderBody,
): Promise<PullResult> {
  throw new Error('not implemented (L4)');
}
