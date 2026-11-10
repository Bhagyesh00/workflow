/** P6-19: Members row action (`user:resetPassword`): copies a password reset link; never for an owner. */
import { useMutation } from '@tanstack/react-query';
import { Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { passwordApi } from '../../api/endpoints';
import { useMe } from '../../api/queries';
import type { Member } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export interface CopyResetLinkActionProps {
  member: Member;
}

export function CopyResetLinkAction({ member }: CopyResetLinkActionProps) {
  const { can } = usePermissions();
  const me = useMe().data;
  const [shown, setShown] = useState<string | null>(null);
  const label = member.name || member.email;
  const copy = useMutation({
    mutationFn: () => passwordApi.resetLink(member.userId),
    onSuccess: async ({ link }) => {
      try {
        await navigator.clipboard.writeText(link);
        toast.success('Reset link copied', member.email);
      } catch {
        // no clipboard here: show the link to copy by hand
        setShown(link);
      }
    },
    onError: (error) => toast.error('Could not make the reset link', errorMessage(error)),
  });
  if (
    !can('user:resetPassword') ||
    member.role === 'owner' ||
    member.status === 'disabled' ||
    member.status === 'pending' ||
    member.userId === me?.user.id
  ) {
    return null;
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={<KeyRound size={13} />}
        loading={copy.isPending}
        aria-label={`Copy password reset link for ${label}`}
        onClick={() => copy.mutate()}
      >
        Copy reset link
      </Button>
      <Dialog
        open={shown !== null}
        onClose={() => setShown(null)}
        title="Password reset link"
        size="sm"
        footer={<Button onClick={() => setShown(null)}>Close</Button>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-2">
            Send this link to {member.email}. It works once, for 20 minutes, and any earlier link for them
            stops working.
          </p>
          <span className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all text-xs">{shown}</code>
            <IconButton
              label={`Copy reset link for ${member.email}`}
              size="sm"
              onClick={() => void navigator.clipboard?.writeText(shown ?? '').catch(() => undefined)}
            >
              <Copy size={13} />
            </IconButton>
          </span>
        </div>
      </Dialog>
    </>
  );
}
