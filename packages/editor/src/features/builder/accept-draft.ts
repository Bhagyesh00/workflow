/**
 * P5-62: Accept saves the draft with `saveWorkflow(deps, { builderAccept: true })` on the snapshot's
 * version (a newer save gives 409 and the conflict dialog, still in review), then ends the review and
 * calls `onDraftAccepted`. Resolves with the saved workflow, or null. Stub until L2.
 */
import type { WorkflowDTO } from '../../api/types';
import type { BuilderDeps } from '../../stores/builder-store';

export async function acceptBuilderDraft(_deps: BuilderDeps): Promise<WorkflowDTO | null> {
  throw new Error('not implemented (L2)');
}
