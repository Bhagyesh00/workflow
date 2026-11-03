/**
 * "Publish timeline" tab of the versions panel (P3-16): event, version name or short id, user,
 * date; a row whose version was pruned shows "Published a version" with the tooltip "The
 * published version has since been pruned." Newest first, 20 rows a page, "Load more" for the rest.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { PowerOff, Rocket } from 'lucide-react';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { PublishTimelineEntry } from '../../api/types';
import { formatDateTime, formatRelative } from '../../lib/format';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

const PAGE_SIZE = 20;
const PRUNED_TOOLTIP = 'The published version has since been pruned.';

function TimelineRow({ entry, last }: { entry: PublishTimelineEntry; last: boolean }) {
  const published = entry.event === 'activated';
  const Icon = published ? Rocket : PowerOff;
  return (
    <li className="relative pb-4 pl-6">
      <span
        aria-hidden
        className={cx(
          'absolute top-0.5 left-0 grid size-4 place-items-center rounded-full',
          published ? 'bg-ok-soft text-ok' : 'bg-surface-3 text-ink-2',
        )}
      >
        <Icon size={10} />
      </span>
      {!last && <span aria-hidden className="absolute top-5 bottom-0 left-[7.5px] w-px bg-line" />}
      <p className="text-sm text-ink">
        {entry.versionId === null ? (
          <span className="font-semibold" title={PRUNED_TOOLTIP}>
            {published ? 'Published a version' : 'Unpublished a version'}
          </span>
        ) : (
          <>
            <span className="font-semibold">{published ? 'Published' : 'Unpublished'}</span>{' '}
            <span className="font-medium break-all">{entry.versionName ?? entry.versionId.slice(0, 8)}</span>
          </>
        )}
      </p>
      <p className="text-xs text-ink-2">{entry.userName ?? 'Unknown user'}</p>
      <time
        dateTime={entry.createdAt}
        title={formatRelative(entry.createdAt)}
        className="block text-2xs text-ink-3"
      >
        {formatDateTime(entry.createdAt)}
      </time>
    </li>
  );
}

export function PublishTimeline({ workflowId }: { workflowId?: string }) {
  const timeline = useInfiniteQuery({
    queryKey: [...queryKeys.publishTimeline(workflowId ?? 'new'), 'list'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => workflowsApi.publishTimeline(workflowId!, { skip: pageParam, take: PAGE_SIZE }),
    getNextPageParam: (last, pages) =>
      last.length < PAGE_SIZE ? undefined : pages.reduce((sum, page) => sum + page.length, 0),
    enabled: Boolean(workflowId),
  });

  if (!workflowId) {
    return (
      <EmptyState title="Not saved yet" description="The publish timeline appears once the workflow has been saved." />
    );
  }
  if (timeline.isLoading) return <PageLoader />;
  if (timeline.error) {
    return (
      <Callout tone="err" className="m-4">
        Couldn't load the publish timeline. {errorMessage(timeline.error)}
      </Callout>
    );
  }
  const entries = timeline.data?.pages.flat() ?? [];
  if (!entries.length) {
    return (
      <EmptyState
        title="Not published yet"
        description="Each publish and unpublish shows here, with who did it and when."
      />
    );
  }
  return (
    <div className="px-4 py-3">
      <ol aria-label="Publish timeline" className="relative">
        {entries.map((entry, i) => (
          <TimelineRow key={entry.id} entry={entry} last={i === entries.length - 1 && !timeline.hasNextPage} />
        ))}
      </ol>
      {timeline.hasNextPage && (
        <Button
          size="sm"
          className="mt-1 w-full"
          loading={timeline.isFetchingNextPage}
          onClick={() => void timeline.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}
