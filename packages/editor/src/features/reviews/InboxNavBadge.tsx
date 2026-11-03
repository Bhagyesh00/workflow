/**
 * Count of open reviews waiting for the signed-in user, next to "Inbox" in the left nav (P3-19);
 * reads useInboxSummary.
 */
import { useInboxSummary } from '../../api/queries';

export function InboxNavBadge({ collapsed }: { collapsed: boolean }) {
  const count = useInboxSummary(true).data?.toReview ?? 0;
  if (count <= 0) return null;
  if (collapsed) {
    return <span role="status" aria-label={`${count} to review`} className="size-2 rounded-full bg-brand" />;
  }
  return (
    <span
      role="status"
      aria-label={`${count} to review`}
      className="ml-auto rounded-full bg-brand px-1.5 py-0.5 text-2xs font-semibold text-on-brand"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
