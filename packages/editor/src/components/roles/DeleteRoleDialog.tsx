/** P6-46: delete a custom role; a role in use is refused, a global one may be reassigned first. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { rolesApi } from '../../api/endpoints';
import { queryKeys, useRoles } from '../../api/queries';
import type { CustomRole } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Select } from '../ui/Field';
import { Callout, Spinner } from '../ui/misc';

export interface DeleteRoleDialogProps {
  role: CustomRole;
  onClose(): void;
  onDeleted?(): void;
}

export function DeleteRoleDialog({ role, onClose, onDeleted }: DeleteRoleDialogProps) {
  const queryClient = useQueryClient();
  const usage = useQuery({ queryKey: queryKeys.role(role.slug), queryFn: () => rolesApi.get(role.slug) });
  const roles = useRoles();
  const [target, setTarget] = useState('');

  const users = usage.data?.usedByUsers ?? 0;
  const projects = usage.data?.usedByProjects ?? 0;
  const inUse = users > 0;
  const isGlobal = role.roleType === 'global';
  const targets = (roles.data?.global ?? []).filter((r) => r.slug !== role.slug && r.slug !== 'owner');
  const refused = inUse && !isGlobal;
  const ready = usage.isSuccess && !refused && (!inUse || Boolean(target));

  const remove = useMutation({
    mutationFn: () => rolesApi.remove(role.slug, inUse && isGlobal ? target : undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      toast.success(`Deleted ${role.displayName}`);
      onDeleted?.();
      onClose();
    },
    onError: (error) => toast.error("Couldn't delete the role", errorMessage(error)),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!remove.isPending}
      size="sm"
      title={`Delete ${role.displayName}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            {refused ? 'Close' : 'Cancel'}
          </Button>
          {!refused && (
            <Button
              variant="danger"
              disabled={!ready}
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete role
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        {usage.isPending && (
          <p className="flex items-center gap-2 text-ink-2" role="status">
            <Spinner /> Checking where this role is used
          </p>
        )}
        {usage.isError && <Callout tone="err">{errorMessage(usage.error)}</Callout>}
        {usage.isSuccess && refused && (
          <Callout tone="warn" title="This role is in use">
            {`${users} ${users === 1 ? 'user has' : 'users have'} this role in ${projects} ${projects === 1 ? 'project' : 'projects'}. Give them another role in each project, then delete it.`}
          </Callout>
        )}
        {usage.isSuccess && inUse && isGlobal && (
          <>
            <Callout tone="warn" title="This role is in use">
              {`${users} ${users === 1 ? 'member has' : 'members have'} this role. Choose the role they get instead.`}
            </Callout>
            <Select
              aria-label="Give members this role"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Choose a role</option>
              {targets.map((r) => (
                <option key={r.slug} value={r.slug}>
                  {r.displayName}
                </option>
              ))}
            </Select>
          </>
        )}
        {usage.isSuccess && !inUse && (
          <p>{`Delete the role "${role.displayName}"? This cannot be undone.`}</p>
        )}
      </div>
    </Dialog>
  );
}
