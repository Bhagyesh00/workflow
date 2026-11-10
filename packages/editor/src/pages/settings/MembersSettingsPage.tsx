/** Settings > Members: the workspace's members and invitations. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Trash2, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { membersApi } from '../../api/endpoints';
import { queryKeys, useMe, useProjects, useRoles } from '../../api/queries';
import type { MemberRemovalChoice, Role } from '../../api/types';
import { ViewProjectsModal } from '../../components/projects/ViewProjectsModal';
import { Button, IconButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FormField, Select, TextInput } from '../../components/ui/Field';
import { Callout, PageLoader } from '../../components/ui/misc';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Panel } from './Panel';

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the workspace',
  admin: 'Members, projects and all resources',
  member: 'Only the projects they belong to, with the role they get in each',
};

function titleCase(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function inviteLink(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  for (const key of ['inviteUrl', 'invitationUrl', 'url']) {
    const v = result[key];
    if (typeof v === 'string' && /^https?:\/\//.test(v)) return v;
  }
  return null;
}

/** the server needs a choice for the removed member's personal work (P6-31): move it to a project, or delete it */
function RemoveMemberDialog({
  name,
  onClose,
  onRemove,
}: {
  name: string;
  onClose(): void;
  onRemove(choice: MemberRemovalChoice): Promise<void>;
}) {
  const projects = useProjects();
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onRemove(choice === 'delete' ? { deleteData: true } : { transferToProjectId: choice });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${name}?`}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!choice}>
            Remove member
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          They lose access to this workspace immediately. Choose what happens to the workflows, credentials
          and data in their personal space.
        </p>
        <FormField label="Their work">
          {(id) => (
            <Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Choose what to do</option>
              <option value="delete">Delete it</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {`Move it to ${p.type === 'personal' ? 'my personal space' : p.name}`}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
    </Dialog>
  );
}

export function MembersSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canInvite = can('user:create');
  const canChangeRole = can('user:changeRole');
  const canRemove = can('user:delete');
  const canViewProjects = can('project:list');
  const members = useQuery({ queryKey: queryKeys.members, queryFn: membersApi.list });
  const roles = useRoles();
  const [projectsOf, setProjectsOf] = useState<string | null>(null);
  // system roles first, then the custom workspace roles
  const roleOptions = useMemo(
    () =>
      (roles.data?.global ?? [])
        .filter((r) => r.slug !== 'owner')
        .map((r) => ({
          slug: r.slug,
          label: r.displayName,
          hint: r.description ?? ROLE_HINTS[r.slug] ?? '',
        })),
    [roles.data],
  );
  const roleLabel = (slug: string) =>
    roles.data?.global.find((r) => r.slug === slug)?.displayName ?? titleCase(slug);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.members });
  const invite = useMutation({
    mutationFn: () => membersApi.invite({ email: email.trim(), role }),
    onSuccess: async (result) => {
      await refresh();
      setLink(inviteLink(result));
      toast.success('Invitation sent', email.trim());
      setEmail('');
    },
    onError: (error) => toast.error('Could not send the invitation', errorMessage(error)),
  });
  const updateRole = useMutation({
    mutationFn: ({ userId, role: next }: { userId: string; role: Role }) =>
      membersApi.updateRole(userId, next),
    onSuccess: async () => {
      await refresh();
      toast.success('Role updated');
    },
    onError: (error) => toast.error('Could not change the role', errorMessage(error)),
  });
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const remove = async (userId: string, choice: MemberRemovalChoice) => {
    try {
      await membersApi.remove(userId, choice);
      await refresh();
      setRemoving(null);
      toast.success('Member removed');
    } catch (error) {
      toast.error('Could not remove the member', errorMessage(error));
    }
  };
  return (
    <Panel
      title="Members"
      description="People in this workspace and what they can do."
      action={
        canInvite && (
          <Button variant="primary" icon={<UserPlus size={15} />} onClick={() => setInviteOpen(true)}>
            Invite
          </Button>
        )
      }
    >
      {members.isLoading ? (
        <PageLoader />
      ) : members.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(members.error)}
        </Callout>
      ) : (
        <ul>
          {(members.data ?? []).map((m) => {
            const isMe = m.userId === me.data?.user.id;
            return (
              <li
                key={m.userId}
                className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0"
              >
                <span className="grid size-9 place-items-center rounded-full bg-brand-soft font-semibold text-brand">
                  {(m.name || m.email).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {m.name || m.email}{' '}
                    {isMe && <span className="text-xs font-normal text-ink-3">(you)</span>}
                  </span>
                  <span className="block truncate text-xs text-ink-3">{m.email}</span>
                </span>
                {canViewProjects && (
                  <Button size="sm" variant="ghost" onClick={() => setProjectsOf(m.userId)}>
                    View projects
                  </Button>
                )}
                {canChangeRole && !isMe && m.role !== 'owner' ? (
                  <Select
                    aria-label={`Role of ${m.name || m.email}`}
                    className="w-36"
                    value={m.role}
                    onChange={(e) => updateRole.mutate({ userId: m.userId, role: e.target.value as Role })}
                  >
                    {!roleOptions.some((o) => o.slug === m.role) && (
                      <option value={m.role}>{roleLabel(m.role)}</option>
                    )}
                    {roleOptions.map((o) => (
                      <option key={o.slug} value={o.slug} title={o.hint}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-sm text-ink-2">{roleLabel(m.role)}</span>
                )}
                {canRemove && !isMe && m.role !== 'owner' && (
                  <IconButton
                    label={`Remove ${m.name || m.email}`}
                    size="sm"
                    onClick={() => setRemoving({ userId: m.userId, name: m.name || m.email })}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          setLink(null);
        }}
        title="Invite a member"
        size="sm"
        footer={
          <>
            <Button onClick={() => setInviteOpen(false)}>Close</Button>
            <Button
              variant="primary"
              onClick={() => invite.mutate()}
              loading={invite.isPending}
              disabled={!/^\S+@\S+\.\S+$/.test(email.trim())}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Email">
            {(id) => (
              <TextInput
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-autofocus
              />
            )}
          </FormField>
          <FormField label="Role" hint={ROLE_HINTS[role]}>
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {roleOptions.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {link && (
            <Callout tone="ok" title="Invitation link">
              <span className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
                <IconButton
                  label="Copy invitation link"
                  size="sm"
                  onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}
                >
                  <Copy size={13} />
                </IconButton>
              </span>
            </Callout>
          )}
        </div>
      </Dialog>
      {removing && (
        <RemoveMemberDialog
          name={removing.name}
          onClose={() => setRemoving(null)}
          onRemove={(choice) => remove(removing.userId, choice)}
        />
      )}
      {projectsOf && <ViewProjectsModal userId={projectsOf} onClose={() => setProjectsOf(null)} />}
    </Panel>
  );
}
