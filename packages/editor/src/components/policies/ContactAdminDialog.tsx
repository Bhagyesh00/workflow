/**
 * P6-50 (L5): "Contact admin": lists the workspace admins (from `/members`) to ask about a blocked type.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { membersApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import { adminsOf } from '../../lib/policy-violations';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Spinner } from '../ui/misc';

export interface ContactAdminDialogProps {
  open: boolean;
  onClose(): void;
  /** the blocked node or credential type */
  type: string;
  displayName?: string;
}

export function ContactAdminDialog({ open, onClose, type, displayName }: ContactAdminDialogProps): ReactNode {
  const name = displayName ?? type;
  const members = useQuery({
    queryKey: queryKeys.members,
    queryFn: membersApi.list,
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const admins = adminsOf(members.data);
  const subject = encodeURIComponent(`Please allow ${name}`);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Contact admin"
      description={`${name} is blocked by a policy. An admin can allow it.`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {members.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-ink-2">
          <Spinner size={14} /> Loading admins
        </p>
      ) : members.isError ? (
        <p className="text-sm text-err">Couldn't load the admins. Ask the owner of the workspace.</p>
      ) : admins.length === 0 ? (
        <p className="text-sm text-ink-2">No admin is listed. Ask the owner of the workspace.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Workspace admins">
          {admins.map((admin) => (
            <li key={admin.userId} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-ink">
                  {admin.name || admin.email}
                </span>
                <span className="block truncate text-xs text-ink-3">{admin.email}</span>
              </span>
              <a
                className="text-sm font-semibold text-brand hover:underline"
                href={`mailto:${admin.email}?subject=${subject}`}
                aria-label={`Email ${admin.name || admin.email}`}
              >
                Email
              </a>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
