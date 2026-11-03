/**
 * Publish and unpublish the open workflow (P3-10). Until lane L10 rewrites this file it keeps
 * today's behaviour: publish = activate, unpublish = deactivate (setWorkflowActive).
 * L10: Publish asks reviewGate() (features/reviews/review-publish.ts) before the dialog, then
 * POST /workflows/:id/activate with the PublishBody.
 */
import type { PublishBody } from '../../api/types';
import { type EditorDeps, setWorkflowActive } from './editor-actions';

/** Resolves true when the workflow is published afterwards. */
export function publishWorkflow(deps: EditorDeps, _body: PublishBody = {}): Promise<boolean> {
  return setWorkflowActive(deps, true);
}

/** Resolves true when the workflow is unpublished afterwards. */
export function unpublishWorkflow(deps: EditorDeps): Promise<boolean> {
  return setWorkflowActive(deps, false);
}
