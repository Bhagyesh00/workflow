/**
 * P6-81 (L14): avatars of who has the workflow open (editor top bar). The holder of the write lock has a ring.
 */
import { useMe } from '../../api/queries';
import { useCollaborationStore } from '../../stores/collaboration-store';
import { cx } from '../ui/cx';

export interface CollaboratorsPaneProps {
  workflowId: string;
}

const SHOWN = 4;

function initialsOf(name: string, email: string): string {
  const parts = (name.trim() || email).split(/[\s@.]+/).filter(Boolean);
  const letters =
    parts.length > 1 ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}` : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

export function CollaboratorsPane({ workflowId }: CollaboratorsPaneProps) {
  const openId = useCollaborationStore((s) => s.workflowId);
  const collaborators = useCollaborationStore((s) => s.collaborators);
  const writeLock = useCollaborationStore((s) => s.writeLock);
  const selfId = useMe().data?.user.id;
  if (openId !== workflowId || collaborators.length === 0) return null;
  const shown = collaborators.slice(0, SHOWN);
  const rest = collaborators.length - shown.length;
  return (
    <ul
      className="flex shrink-0 items-center -space-x-1.5"
      aria-label={`People with this workflow open: ${collaborators.map((c) => c.name || c.email).join(', ')}`}
      data-testid="collaborators"
    >
      {shown.map((c) => {
        const editing = writeLock?.userId === c.userId;
        const label = `${c.name || c.email}${c.userId === selfId ? ' (you)' : ''}${editing ? ', editing' : ''}`;
        return (
          <li
            key={c.userId}
            title={label}
            aria-label={label}
            data-testid="collaborator"
            className={cx(
              'flex size-7 items-center justify-center rounded-full border border-surface bg-brand-soft text-[11px] font-semibold text-ink',
              editing && 'ring-2 ring-brand',
            )}
          >
            {initialsOf(c.name, c.email)}
          </li>
        );
      })}
      {rest > 0 && (
        <li
          title={`${rest} more`}
          className="flex size-7 items-center justify-center rounded-full border border-surface bg-surface-3 text-[11px] font-semibold text-ink-2"
        >
          +{rest}
        </li>
      )}
    </ul>
  );
}
