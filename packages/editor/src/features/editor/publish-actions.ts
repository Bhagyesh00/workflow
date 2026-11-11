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
import { dependenciesApi, workflowsApi } from '../../api/endpoints';
import type { PublishBody } from '../../api/types';
import { confirmUnpublish } from '../../stores/dependency-dialog-store';
import { toast, useUiStore } from '../../stores/ui-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { reviewGate } from '../reviews/review-publish';
import { type EditorDeps, reportActivationFailure, saveWorkflow } from './editor-actions';

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

/**
 * The saved id and version of the open workflow; unsaved changes are saved first (the draft is what
 * goes live). The version is the one this editor shows, so a draft someone else saves meanwhile is
 * not published under this user's name and description.
 */
async function savedDraft(deps: EditorDeps): Promise<{ id: string; versionId?: string } | null> {
  const s = useWorkflowStore.getState();
  if (s.meta.id && !s.dirty) return { id: s.meta.id, versionId: s.meta.versionId };
  const dto = await saveWorkflow(deps);
  return dto ? { id: dto.id, versionId: dto.versionId } : null;
}

function bumpRevision() {
  usePublishTarget.setState((s) => ({ revision: s.revision + 1 }));
}

/** Resolves true when the workflow is published afterwards. */
export async function publishWorkflow(deps: EditorDeps, body: PublishBody = {}): Promise<boolean> {
  // publishing a named earlier version leaves the draft alone
  const target = body.versionId
    ? { id: useWorkflowStore.getState().meta.id, versionId: body.versionId }
    : await savedDraft(deps);
  if (!target?.id) return false;
  try {
    const dto = await workflowsApi.activate(
      target.id,
      target.versionId ? { ...body, versionId: target.versionId } : body,
    );
    useWorkflowStore.getState().setPublished(dto.publishedVersionId, dto.versionId);
    useUiStore.getState().setActivationErrors(null);
    toast.success('Workflow published');
    return true;
  } catch (error) {
    await reportActivationFailure(target.id, "Couldn't publish the workflow", error);
    return false;
  } finally {
    bumpRevision();
  }
}

/** the published workflows that depend on `workflowId`; none when the lookup fails, so it never blocks an unpublish */
async function publishedDependents(workflowId: string) {
  try {
    const rows = (await dependenciesApi.details('workflow', [workflowId]))[workflowId] ?? [];
    return rows.filter(
      (row) => (row.key === 'workflowParent' || row.key === 'errorWorkflowParent') && row.active === true,
    );
  } catch {
    return [];
  }
}

/** Resolves true when the workflow is unpublished afterwards. */
export async function unpublishWorkflow(_deps: EditorDeps): Promise<boolean> {
  const { id, name } = useWorkflowStore.getState().meta;
  if (!id) return false;
  // P6-86: published workflows that call this one or name it as their error workflow are listed first
  const dependents = await publishedDependents(id);
  if (dependents.length > 0 && !(await confirmUnpublish(id, name, dependents))) return false;
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
