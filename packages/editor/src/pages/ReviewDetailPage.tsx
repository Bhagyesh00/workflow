/**
 * /inbox/:reviewId (P3-19): metadata, changes (published vs pinned while open; approved baseline
 * vs pinned once closed, none for a null baseline), activity, comments, decision.
 *
 * The request keeps its version ids when compaction prunes a version (no FK), so a pruned version
 * shows its short id. The buttons follow the server rules: decide = an admin, or an assigned
 * reviewer who can publish and is not an author; update = any member who can publish (n8n).
 */
import { useQuery } from '@tanstack/react-query';
import type { WorkflowDiff } from '@workflow/workflow';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { reviewsApi, workflowsApi } from '../api/endpoints';
import { useMe } from '../api/queries';
import type { WorkflowReviewDTO } from '../api/types';
import { Button } from '../components/ui/Button';
import { Badge, Callout, PageLoader } from '../components/ui/misc';
import { WorkflowDiffSummary } from '../components/workflow/WorkflowDiffSummary';
import { ReviewActivityFeed } from '../features/reviews/ReviewActivityFeed';
import { ReviewDecisionPopover } from '../features/reviews/ReviewDecisionPopover';
import { decisionLabel, decisionTone } from '../features/reviews/review-publish';
import { UpdateReviewDialog } from '../features/reviews/UpdateReviewDialog';
import { formatDateTime } from '../lib/format';
import { canWith } from '../lib/permissions';

/** the server diffs the pinned version against another one; the page shows what the request changes */
function invertDiff(diff: WorkflowDiff): WorkflowDiff {
  return {
    ...diff,
    nodes: {
      added: diff.nodes.removed,
      removed: diff.nodes.added,
      renamed: diff.nodes.renamed.map((n) => ({ id: n.id, from: n.to, to: n.from })),
      changed: diff.nodes.changed,
    },
    connections: { added: diff.connections.removed, removed: diff.connections.added },
  };
}

const shortId = (id: string) => id.slice(0, 8);

function Changes({ review }: { review: WorkflowReviewDTO }) {
  const open = review.state === 'open';
  // open: what the live version lacks; closed: what the approval changed (a null baseline: no diff)
  const against = open ? 'published' : review.approvedBaselineVersionId;
  const target = review.workflowId && review.workflowVersionId ? review.workflowId : null;
  const diff = useQuery({
    queryKey: ['workflow-review', review.id, 'diff', against, review.workflowVersionId],
    queryFn: () =>
      workflowsApi.diffVersions(target as string, review.workflowVersionId as string, against as string),
    enabled: Boolean(target && against),
    retry: false,
  });
  if (!target)
    return <p className="text-sm text-ink-2">The workflow or the reviewed version no longer exists.</p>;
  if (!against) {
    return (
      <p className="text-sm text-ink-2">
        Nothing was published before this version, so there is no comparison.
      </p>
    );
  }
  if (diff.isLoading) return <PageLoader label="Loading changes" />;
  if (diff.error) {
    if (!(diff.error instanceof ApiError && diff.error.status === 404))
      return <Callout tone="err">{errorMessage(diff.error)}</Callout>;
    // a 404 names a version that is gone: the pinned one (it has no name left) or the baseline
    const pruned =
      review.versionName === null ? review.workflowVersionId : open ? null : review.approvedBaselineVersionId;
    return (
      <p className="text-sm text-ink-2">
        {pruned
          ? `Version ${shortId(pruned)} was pruned, so there is no comparison.`
          : 'Nothing is published yet, so there is no comparison.'}
      </p>
    );
  }
  return diff.data ? <WorkflowDiffSummary diff={invertDiff(diff.data)} /> : null;
}

function People({ label, users }: { label: string; users: Array<{ id: string; name: string }> }) {
  return (
    <div>
      <dt className="text-xs text-ink-2">{label}</dt>
      <dd className="text-sm text-ink">{users.map((u) => u.name).join(', ') || '–'}</dd>
    </div>
  );
}

export function ReviewDetailPage() {
  const { reviewId = '' } = useParams();
  const me = useMe().data;
  const [updating, setUpdating] = useState<WorkflowReviewDTO | null>(null);
  const query = useQuery({
    // under 'workflow-reviews' so a push event (it names no request) refreshes it
    queryKey: ['workflow-reviews', 'detail', reviewId],
    queryFn: () => reviewsApi.get(reviewId),
    retry: false,
  });

  if (query.isLoading) return <PageLoader />;
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Callout tone="err" title="Could not open the request">
          {query.error ? errorMessage(query.error) : 'The request was not found.'}
        </Callout>
        <Link to="/inbox" className="mt-3 inline-block font-semibold text-brand hover:underline">
          Back to the inbox
        </Link>
      </div>
    );
  }
  const review = query.data;
  const open = review.state === 'open';
  const userId = me?.user.id;
  // whoever manages the reviews switch decides any request (`securitySettings:manage`: owner and admin);
  // a reviewer needs `workflow:publish`. The server checks the reviewer's scopes on the workflow again.
  const isAdmin = canWith(me, 'securitySettings:manage');
  const canPublish = isAdmin || canWith(me, 'workflow:publish');
  const isAuthor = Boolean(userId && review.authors.some((a) => a.id === userId));
  const isReviewer = Boolean(userId && review.reviewers.some((r) => r.id === userId));
  const canDecide = open && (isAdmin || (isReviewer && !isAuthor && canPublish));
  const canUpdate = open && canPublish;
  const canComment = isAuthor || canDecide;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <div>
        <Link to="/inbox" className="text-sm font-semibold text-brand hover:underline">
          Inbox
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              {review.title}
              <Badge tone={decisionTone(review)}>{decisionLabel(review)}</Badge>
            </h1>
            {review.description && <p className="mt-1 text-sm text-ink-2">{review.description}</p>}
          </div>
          <div className="flex items-center gap-2">
            {canUpdate && <Button onClick={() => setUpdating(review)}>Update version</Button>}
            {canDecide && <ReviewDecisionPopover review={review} />}
          </div>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-xl border border-line bg-surface p-4 md:grid-cols-4">
        <div>
          <dt className="text-xs text-ink-2">Workflow</dt>
          <dd className="text-sm text-ink">
            {review.workflowId ? (
              <Link
                to={`/workflow/${review.workflowId}`}
                className="font-semibold text-brand hover:underline"
              >
                {review.workflowName ?? 'Open workflow'}
              </Link>
            ) : (
              'Deleted workflow'
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-2">Version</dt>
          <dd className="text-sm text-ink">
            {review.versionName ??
              (review.workflowVersionId
                ? `Version ${shortId(review.workflowVersionId)} was pruned`
                : 'Removed version')}
          </dd>
        </div>
        <People label="Authors" users={review.authors} />
        <People label="Reviewers" users={review.reviewers} />
        <div>
          <dt className="text-xs text-ink-2">Requested</dt>
          <dd className="text-sm text-ink">{formatDateTime(review.createdAt)}</dd>
        </div>
        {review.approvedAt && (
          <div>
            <dt className="text-xs text-ink-2">Approved</dt>
            <dd className="text-sm text-ink">{formatDateTime(review.approvedAt)}</dd>
          </div>
        )}
      </dl>

      <section aria-label="Changes" className="flex flex-col gap-2">
        <h2 className="text-md font-semibold">Changes</h2>
        <Changes review={review} />
      </section>

      <div className="flex flex-col gap-2">
        <h2 className="text-md font-semibold">Activity</h2>
        <ReviewActivityFeed reviewId={review.id} canComment={canComment} closed={!open} />
      </div>
      <UpdateReviewDialog review={updating} onClose={() => setUpdating(null)} />
    </div>
  );
}
