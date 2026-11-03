/**
 * Publish and unpublish the open workflow (P3-10, as n8n's Publish vs Save).
 *
 * Saving writes the draft only; publishing makes a version live (triggers and production webhooks
 * run it). The Publish button asks the review gate first (features/reviews/review-publish.ts), then
 * opens the publish dialog (ui.publishDialogOpen) for the version name and description; the dialog
 * calls publishWorkflow with them. A publish target other than the draft (the versions panel's
 * "Publish this version") is kept in usePublishTarget.
 */
import { create } from 'zustand';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import type { PublishBody } from '../../api/types';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { reviewGate } from '../reviews/review-publish';
import { activationDetails, type EditorDeps, saveWorkflow } from './editor-actions';

interface PublishTargetState {
  /** the version the dialog publishes; null = the draft (saved first) */
  versionId: string | null;
  /** grows after every publish or unpublish, so version lists refetch names and badges */
  revision: number;
}

export const usePublishTarget = create<PublishTargetState>()(() => ({ versionId: null, revision: 0 }));

/** "Published" / "Published, draft has changes" / "Not published" of the open workflow */
export type PublishState = 'published' | 'changed' | 'unpublished';

export function publishStateOf(
  meta: { publishedVersionId: string | null; versionId?: string },
  dirty: boolean,
): PublishState {
  if (!meta.publishedVersionId) return 'unpublished';
  return dirty || meta.versionId !== meta.publishedVersionId ? 'changed' : 'published';
}

export const PUBLISH_STATE_LABEL: Record<PublishState, string> = {
  published: 'Published',
  changed: 'Published, draft has changes',
  unpublished: 'Not published',
};

/**
 * The Publish button: an open review or "Submit for review" stops here (the review gate shows why
 * or opens its own dialog); otherwise the publish dialog opens for `versionId` (default the draft).
 */
export async function requestPublish(versionId: string | null = null): Promise<void> {
  if ((await reviewGate()) !== 'publish') return;
  usePublishTarget.setState({ versionId });
  useUiStore.getState().setPublishDialogOpen(true);
}

/** the saved id of the open workflow; unsaved changes are saved first (the draft is what goes live) */
async function savedId(deps: EditorDeps): Promise<string | null> {
  const s = useWorkflowStore.getState();
  if (s.meta.id && !s.dirty) return s.meta.id;
  const dto = await saveWorkflow(deps);
  return dto?.id ?? null;
}

function bumpRevision() {
  usePublishTarget.setState((s) => ({ revision: s.revision + 1 }));
}

/** Resolves true when the workflow is published afterwards. */
export async function publishWorkflow(deps: EditorDeps, body: PublishBody = {}): Promise<boolean> {
  // publishing a named earlier version leaves the draft alone
  const id = body.versionId ? useWorkflowStore.getState().meta.id : await savedId(deps);
  if (!id) return false;
  try {
    const dto = await workflowsApi.activate(id, body);
    useWorkflowStore.getState().setPublished(dto.publishedVersionId, dto.versionId);
    useUiStore.getState().setActivationErrors(null);
    toast.success('Workflow published');
    return true;
  } catch (error) {
    const details = activationDetails(error);
    if (details) useUiStore.getState().setActivationErrors(details);
    else toast.error("Couldn't publish the workflow", errorMessage(error));
    return false;
  } finally {
    bumpRevision();
  }
}

/** Resolves true when the workflow is unpublished afterwards. */
export async function unpublishWorkflow(_deps: EditorDeps): Promise<boolean> {
  const id = useWorkflowStore.getState().meta.id;
  if (!id) return false;
  try {
    const dto = await workflowsApi.deactivate(id);
    useWorkflowStore.getState().setPublished(dto.publishedVersionId, dto.versionId);
    toast.success('Workflow unpublished');
    return true;
  } catch (error) {
    toast.error("Couldn't unpublish the workflow", errorMessage(error));
    return false;
  } finally {
    bumpRevision();
  }
}
