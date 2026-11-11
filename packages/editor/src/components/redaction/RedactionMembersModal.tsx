/**
 * P6-53 (L8): who can reveal the project's runs (`GET /roles/:slug/assignments/:projectId/members`).
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { errorMessage } from '../../api/client';
import { rolesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

export interface RedactionMembersModalProps {
  open: boolean;
  onClose(): void;
  projectId: string;
}

/** the project role that holds `execution:reveal` */
const REVEAL_ROLE = 'project:admin';

export function RedactionMembersModal({ open, onClose, projectId }: RedactionMembersModalProps): ReactNode {
  const members = useQuery({
    queryKey: [...queryKeys.roleAssignments(REVEAL_ROLE), projectId, 'members'],
    queryFn: () => rolesApi.projectMembers(REVEAL_ROLE, projectId),
    enabled: open,
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Who can reveal data"
      description="Project admins can reveal the data of redacted executions in this project. Owners and admins of the workspace can too."
      size="sm"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {members.isPending ? (
        <PageLoader label="Loading members" />
      ) : members.isError ? (
        <Callout tone="err">{errorMessage(members.error)}</Callout>
      ) : members.data.members.length === 0 ? (
        <EmptyState
          title="No project admins"
          description="Only the owners and admins of the workspace can reveal."
        />
      ) : (
        <ul
          aria-label="Project admins"
          className="divide-y divide-line rounded-lg border border-line text-sm"
        >
          {members.data.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
              <span className="font-semibold text-ink">{m.name || m.email}</span>
              {m.name && <span className="text-ink-2">{m.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
