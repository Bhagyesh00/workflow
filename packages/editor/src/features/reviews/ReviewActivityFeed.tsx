/** Activity of one review request, newest first, 25 per page, with a comment box (P3-19). */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../api/client';
import { reviewsApi } from '../../api/endpoints';
import type { ReviewActivity } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { TextArea } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { formatRelative } from '../../lib/format';
import { toast } from '../../stores/ui-store';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function describeActivity(entry: ReviewActivity): string {
  const who = entry.createdBy?.name ?? 'The system';
  switch (entry.type) {
    case 'created':
      return `${who} asked for a review`;
    case 'version_updated': {
      const name = text(entry.data.versionName);
      return `${who} moved the request to ${name ? `version "${name}"` : 'a newer version'}`;
    }
    case 'decision':
      return entry.data.decision === 'approved' ? `${who} approved the request` : `${who} requested changes`;
    case 'comment':
      return `${who} commented`;
    case 'closed':
      return entry.createdBy ? `${who} closed the request` : 'The request was closed';
    default:
      return `${who} changed the request`;
  }
}

export function ReviewActivityFeed({
  reviewId,
  canComment,
  closed,
}: {
  reviewId: string;
  canComment: boolean;
  closed: boolean;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const feed = useInfiniteQuery({
    queryKey: ['workflow-reviews', 'activity', reviewId],
    queryFn: ({ pageParam }) => reviewsApi.activity(reviewId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const post = useMutation({
    mutationFn: () => reviewsApi.comment(reviewId, body.trim()),
    onSuccess: () => {
      setBody('');
      void queryClient.invalidateQueries({ queryKey: ['workflow-reviews', 'activity', reviewId] });
    },
    onError: (error) => toast.error('Could not post the comment', errorMessage(error)),
  });
  const entries = feed.data?.pages.flatMap((p) => p.data) ?? [];
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim()) post.mutate();
  };

  return (
    <section aria-label="Activity" className="flex flex-col gap-4">
      {canComment && !closed && (
        <form onSubmit={onSubmit} className="flex flex-col gap-2">
          <TextArea
            aria-label="Comment"
            rows={3}
            maxLength={10000}
            placeholder="Write a comment"
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={post.isPending} disabled={!body.trim()}>
              Comment
            </Button>
          </div>
        </form>
      )}
      {feed.isLoading && <PageLoader label="Loading activity" />}
      {feed.error && <Callout tone="err">{errorMessage(feed.error)}</Callout>}
      <ol className="flex flex-col gap-3">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
            <p className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-ink">{describeActivity(entry)}</span>
              <span className="text-xs text-ink-2">{formatRelative(entry.createdAt)}</span>
            </p>
            {entry.type === 'comment' && entry.comment && (
              <p className="mt-1 whitespace-pre-wrap text-ink-2">{entry.comment.body}</p>
            )}
            {entry.type === 'decision' && text(entry.data.note) && (
              <p className="mt-1 whitespace-pre-wrap text-ink-2">{text(entry.data.note)}</p>
            )}
          </li>
        ))}
      </ol>
      {feed.hasNextPage && (
        <Button onClick={() => void feed.fetchNextPage()} loading={feed.isFetchingNextPage}>
          Load older activity
        </Button>
      )}
    </section>
  );
}
