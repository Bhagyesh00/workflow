/**
 * P5-62: Accept saves the draft with `saveWorkflow(deps, { builderAccept: true })` on the snapshot's
 * version (a newer save gives 409 and the conflict dialog, still in review), then ends the review and
 * calls `onDraftAccepted`. Resolves with the saved workflow, or null.
 */
import type { WorkflowDTO } from '../../api/types';
import { type BuilderDeps, useBuilderStore } from '../../stores/builder-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { saveWorkflow } from '../editor/editor-actions';
import { onDraftAccepted } from './session-actions';

export async function acceptBuilderDraft(deps: BuilderDeps): Promise<WorkflowDTO | null> {
  const builder = useBuilderStore.getState();
  if (!builder.reviewing || builder.streaming) return null;
  if (!useWorkflowStore.getState().meta.id) return null;
  // the canvas still carries the version the draft started from (nothing saves during a review), so a
  // save by anyone since then is a 409: doSave opens the conflict dialog and the review stays
  const saved = await saveWorkflow(deps, { builderAccept: true });
  if (!saved) return null;
  useBuilderStore.getState().clearReview();
  await onDraftAccepted(saved.id, saved.versionId).catch(() => undefined);
  return saved;
}
