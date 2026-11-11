/**
 * P6-07 (L4): the push steps (internal to `SourceControlSyncService.push`): fetch, the caller's own status within
 * `pushableProjects`, the picked files only, a commit on the fetched head (message trimmed, 1 to 1000, default
 * "Updated Workfolder"), conflicts without `force` give 409, then the push; `assertTenantWritable(..., 'push')`
 * first.
 * stub (L4): throws.
 */
import type { PushResult, PushWorkFolderBody } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';

/** stub (L4) */
export function pushWorkFolder(
  _deps: ServiceDeps,
  _auth: AuthContext,
  _body: PushWorkFolderBody,
): Promise<PushResult> {
  throw new Error('not implemented (L4)');
}
