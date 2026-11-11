/**
 * P6-53 (L8): the credential rule of a redacted read, independent of the policy: the credentials the run
 * touched (the workflow snapshot's node credentials plus `usedCredentialIds` from task metadata, sub-workflows
 * included) against `credentialUsableBy` (from S1); any miss gives redacted data with `canReveal` false, and
 * neither `execution:reveal` nor owner rights bypass it. A run that used a private credential
 * (`executions.used_private_credentials`, S2) is revealed only to the run's `userId` (read.ts).
 */
import {
  nodeCredentialIds,
  type RunData,
  reportedCredentialIds,
  type WorkflowNode,
} from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExecutionViewer } from './read';

/**
 * The ids the viewer may not use, of `credentialIds` (empty: all usable). A credential that no longer
 * exists is skipped: no one can use it, and a deleted credential would otherwise hide its runs for good.
 */
export async function inaccessibleCredentialIds(
  deps: ServiceDeps,
  viewer: ExecutionViewer,
  credentialIds: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(credentialIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (!wanted.length) return [];
  const existing = await deps.repos.credentials.listByIds(viewer.tenantId, wanted);
  if (!existing.length) return [];
  const usable = await deps.context().access.credentialUsableBy(
    viewer.tenantId,
    viewer.userId,
    existing.map((row) => row.id),
  );
  return existing.map((row) => row.id).filter((id) => !usable.has(id));
}

/** the workflow snapshot's node credential ids plus the tasks' `usedCredentialIds`, sorted, unique */
export function runReferencedCredentialIds(
  nodes: ReadonlyArray<Pick<WorkflowNode, 'credentials'>> | undefined,
  runData: RunData | undefined,
): string[] {
  return [...new Set([...nodeCredentialIds(nodes), ...reportedCredentialIds(runData)])].sort();
}
