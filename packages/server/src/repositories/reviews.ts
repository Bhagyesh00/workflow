/**
 * Workflow review requests, reviewers, authors, activity and comments (P3-19).
 *
 * C0 STUB: lane L14 writes the bodies (and may add methods).
 */
import type { DbOrTx } from '../db/client';
import type { WorkflowReviewRequestRow } from '../db/schema';

export class ReviewRepository {
  constructor(readonly db: DbOrTx) {}

  /** the open request of a workflow, if any */
  async openForWorkflow(
    _tenantId: string,
    _workflowId: string,
  ): Promise<WorkflowReviewRequestRow | undefined> {
    throw new Error('not implemented (L14)');
  }
}
