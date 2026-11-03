/** /inbox (P3-19): review requests to review and my requests, with counts. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/client';
import { inboxApi } from '../api/endpoints';
import { useInboxSummary, useSettings } from '../api/queries';
import type { InboxTab } from '../api/types';
import { Button } from '../components/ui/Button';
import { Badge, Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Tabs } from '../components/ui/Tabs';
import { decisionLabel, decisionTone } from '../features/reviews/review-publish';
import { formatRelative } from '../lib/format';

export function InboxPage() {
  const enabled = useSettings().workflowReviews?.enabled === true;
  const [tab, setTab] = useState<InboxTab>('to_review');
  const summary = useInboxSummary(enabled);
  const list = useInfiniteQuery({
    queryKey: ['inbox', { tab }],
    queryFn: ({ pageParam }) => inboxApi.list({ tab, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
  const rows = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-8">
      <h1 className="text-xl font-semibold">Inbox</h1>
      {!enabled ? (
        <EmptyState
          icon={<Inbox size={20} />}
          title="Workflow reviews are off"
          description="An admin can turn them on in Settings, Security."
        />
      ) : (
        <>
          <Tabs
            label="Inbox"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'to_review', label: 'To review', badge: summary.data?.toReview },
              { value: 'mine', label: 'My requests', badge: summary.data?.mine },
            ]}
          />
          {list.isLoading && <PageLoader label="Loading requests" />}
          {list.error && <Callout tone="err">{errorMessage(list.error)}</Callout>}
          {!list.isLoading && !list.error && rows.length === 0 && (
            <EmptyState
              icon={<Inbox size={20} />}
              title={tab === 'to_review' ? 'Nothing to review' : 'No requests yet'}
              description={
                tab === 'to_review'
                  ? 'Review requests assigned to you show up here.'
                  : 'Use Publish, then Submit for review, on a workflow.'
              }
            />
          )}
          <ul className="flex flex-col gap-2">
            {rows.map((review) => (
              <li key={review.id}>
                <Link
                  to={`/inbox/${review.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-3 hover:border-line-strong"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-ink">{review.title}</span>
                    <span className="block truncate text-xs text-ink-2">
                      {review.workflowName ?? 'Deleted workflow'}
                      {review.versionName ? ` · ${review.versionName}` : ''}
                      {' · '}
                      {review.authors.map((a) => a.name).join(', ') || 'Unknown author'}
                      {' · '}
                      {formatRelative(review.updatedAt)}
                    </span>
                  </span>
                  <Badge tone={decisionTone(review)}>{decisionLabel(review)}</Badge>
                </Link>
              </li>
            ))}
          </ul>
          {list.hasNextPage && (
            <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
              Load more
            </Button>
          )}
        </>
      )}
    </div>
  );
}
