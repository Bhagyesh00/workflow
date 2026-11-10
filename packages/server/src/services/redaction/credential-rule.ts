/**
 * P6-53 (L8): the credential rule of a redacted read, independent of the policy: the credentials the run
 * touched (the workflow snapshot's node credentials plus `usedCredentialIds` from task metadata, sub-workflows
 * included) against `credentialUsableBy` (from S1); any miss gives redacted data with `canReveal` false, and
 * neither `execution:reveal` nor owner rights bypass it. A run that used a private credential
 * (`executions.used_private_credentials`, S2) is revealed only to the run's `userId`.
 * Stub from C0; L8 fills it.
 */
import type { RunData, WorkflowNode } from '@workflow/workflow';
import type { ServiceDeps } from '../../context';
import type { ExecutionViewer } from './read';

/** the ids the viewer may not use, of `credentialIds` (empty: all usable) */
export async function inaccessibleCredentialIds(
  _deps: ServiceDeps,
  _viewer: ExecutionViewer,
  _credentialIds: readonly string[],
): Promise<string[]> {
  // stub (L8)
  throw new Error('not implemented (L8)');
}

/** the workflow snapshot's node credential ids plus the tasks' `usedCredentialIds`, sorted, unique */
export function runReferencedCredentialIds(
  _nodes: ReadonlyArray<Pick<WorkflowNode, 'credentials'>> | undefined,
  _runData: RunData | undefined,
): string[] {
  // stub (L8)
  throw new Error('not implemented (L8)');
}
