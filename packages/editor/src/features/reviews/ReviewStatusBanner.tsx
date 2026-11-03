/**
 * Canvas banner for the open workflow's open review request (P3-19): pending or changes requested,
 * with a link to the request. It also hosts the three review dialogs the editor opens (publish
 * choice, submit, update), because it is the review piece mounted in the editor page.
 */
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { Link } from 'react-router';
import { reviewsApi } from '../../api/endpoints';
import { useMe, useSettings } from '../../api/queries';
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/misc';
import { useWorkflowStore } from '../../stores/workflow-store';
import { PublishChoiceDialog } from './PublishChoiceDialog';
import { decisionLabel, decisionTone, useReviewUi } from './review-publish';
import { SubmitForReviewDialog } from './SubmitForReviewDialog';
import { UpdateReviewDialog } from './UpdateReviewDialog';

export function ReviewStatusBanner() {
  const enabled = useSettings().workflowReviews?.enabled === true;
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const me = useMe().data;
  const submitOpen = useReviewUi((s) => s.submitOpen);
  const updateFor = useReviewUi((s) => s.updateFor);
  const open = useQuery({
    queryKey: ['workflow-reviews', { workflowId, state: 'open' }],
    queryFn: async () => (await reviewsApi.list({ workflowId, state: 'open', limit: 1 })).data[0] ?? null,
    enabled: enabled && Boolean(workflowId),
    retry: false,
  });
  const review = open.data ?? null;
  const isAuthor = Boolean(review && me && review.authors.some((a) => a.id === me.user.id));

  return (
    <>
      {enabled && review && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-sm"
        >
          <ClipboardCheck size={15} className="text-brand" aria-hidden="true" />
          <Badge tone={decisionTone(review)}>{decisionLabel(review)}</Badge>
          <span className="min-w-0 flex-1 truncate text-ink-2">
            {review.decision === 'changes_requested'
              ? `Changes were requested on "${review.title}". Update the review to send a new version.`
              : `"${review.title}" is waiting for a review. Publishing is paused until it is approved.`}
          </span>
          {isAuthor && review.decision === 'changes_requested' && (
            <Button size="sm" onClick={() => useReviewUi.getState().setUpdateFor(review)}>
              Update review
            </Button>
          )}
          <Link to={`/inbox/${review.id}`} className="font-semibold text-brand hover:underline">
            Open request
          </Link>
        </div>
      )}
      <PublishChoiceDialog />
      <SubmitForReviewDialog open={submitOpen} onClose={() => useReviewUi.getState().setSubmitOpen(false)} />
      <UpdateReviewDialog review={updateFor} onClose={() => useReviewUi.getState().setUpdateFor(null)} />
    </>
  );
}
