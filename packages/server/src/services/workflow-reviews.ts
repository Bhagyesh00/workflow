/**
 * Workflow reviews (P3-19): review requests before publish. The hooks below are called by the
 * publish, archive and delete paths.
 *
 * C0 STUB: lane L14 writes the bodies (the hooks are no-ops).
 */
import type { ServiceDeps } from '../context';

export class WorkflowReviewService {
  constructor(readonly deps: ServiceDeps) {}

  /** throws 409 (review_pending / changes_requested) while reviews are on and a request is open */
  async assertCanPublish(_tenantId: string, _workflowId: string, _userId?: string): Promise<void> {}

  async afterWorkflowPublished(_tenantId: string, _workflowId: string, _versionId: string): Promise<void> {}

  /** closes the open request */
  async afterWorkflowArchived(_tenantId: string, _workflowId: string): Promise<void> {}

  /** closes the open request; called BEFORE the workflow row is deleted */
  async afterWorkflowDeleted(_tenantId: string, _workflowId: string): Promise<void> {}
}
