/**
 * Settings > Members: the workspace's members and open invitations with search, a role filter, sort, paging,
 * last active, a 2FA column, Pending, Disabled and Managed by SCIM badges, invite many, resend and a copyable
 * invite link (P6-20).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client';
import { membersApi } from '../../api/endpoints';
import { queryKeys, useMe, useProjects, useRoles } from '../../api/queries';
import type {
  Member,
  MemberInviteResult,
  MemberListQuery,
  MemberRemovalChoice,
  MemberSortField,
  Role,
} from '../../api/types';
import { AllowManualLoginToggle } from '../../components/members/AllowManualLoginToggle';
import { CopyResetLinkAction } from '../../components/members/CopyResetLinkAction';
import { ViewProjectsModal } from '../../components/projects/ViewProjectsModal';
import { Button, IconButton } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { FormField, Select, TextArea, TextInput } from '../../components/ui/Field';
import { Badge, Callout, EmptyState, PageLoader } from '../../components/ui/misc';
import { formatRelative, plural } from '../../lib/format';
import { useInviteGate } from '../../lib/invite-gate';
import { usePermissions } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Panel } from './Panel';

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the workspace',
  admin: 'Members, projects and all resources',
  member: 'Only the projects they belong to, with the role they get in each',
};

const PAGE_SIZE = 25;
/** the most emails one invite takes (the server's limit) */
const MAX_INVITES = 100;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

function titleCase(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** the emails typed in the invite box: separated by commas, semicolons, spaces or new lines */
function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const email = part.trim();
    if (email) seen.add(email.toLowerCase());
  }
  return [...seen];
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

/** an invite link to read and copy (shown when mail did not carry it, or the clipboard is not available) */
function InviteLinkDialog({ email, link, onClose }: { email: string; link: string; onClose(): void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Invitation link"
      size="sm"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-2">
          Send this link to {email}. It works once, and any earlier link for them stops working.
        </p>
        <span className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs">{link}</code>
          <CopyLinkButton link={link} label={`Copy invitation link for ${email}`} />
        </span>
      </div>
    </Dialog>
  );
}

function CopyLinkButton({ link, label }: { link: string; label: string }) {
  return (
    <IconButton
      label={label}
      size="sm"
      onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}
    >
      <Copy size={13} />
    </IconButton>
  );
}

const COLUMNS: Array<{ field: MemberSortField; label: string; className: string }> = [
  { field: 'name', label: 'Name', className: 'min-w-0 flex-1' },
  { field: 'role', label: 'Role', className: 'w-36' },
  { field: 'mfaEnabled', label: '2FA', className: 'w-14' },
  { field: 'lastActiveAt', label: 'Last active', className: 'w-28' },
];

export function MembersSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canInvite = can('user:create');
  const canChangeRole = can('user:changeRole');
  const canRemove = can('user:delete');
  const canViewProjects = can('project:list');
  const canCopyLink = can('user:generateInviteLink');
  const gate = useInviteGate();
  const roles = useRoles();

  // the list: search (debounced), role filter, sort and page
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [sort, setSort] = useState<{ field: MemberSortField; dir: 'asc' | 'desc' }>({
    field: 'name',
    dir: 'asc',
  });
  const [skip, setSkip] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setSkip(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const listQuery: MemberListQuery = {
    ...(q ? { q } : {}),
    ...(roleFilter ? { role: roleFilter } : {}),
    sort: `${sort.field}:${sort.dir}`,
    take: PAGE_SIZE,
    skip,
  };
  const members = useQuery({
    queryKey: queryKeys.memberList(listQuery),
    queryFn: ({ signal }) => membersApi.listPage({ ...listQuery, signal }),
    placeholderData: keepPreviousData,
  });
  const rows = members.data?.items ?? [];
  const total = members.data?.count ?? 0;
  const filtered = Boolean(q || roleFilter);

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
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [results, setResults] = useState<MemberInviteResult[]>([]);
  const [shownLink, setShownLink] = useState<{ email: string; link: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.members });
  const typed = parseEmails(emails);
  const validEmails =
    typed.length > 0 && typed.length <= MAX_INVITES && typed.every((e) => EMAIL_PATTERN.test(e));
  const invite = useMutation({
    mutationFn: () => membersApi.inviteMany(typed.map((email) => ({ email, role }))),
    onSuccess: async (answer) => {
      await refresh();
      setResults(answer);
      const failed = answer.filter((r) => r.error);
      // what failed stays in the box to fix and send again
      setEmails(failed.map((r) => r.email).join('\n'));
      const sent = answer.length - failed.length;
      if (sent > 0) {
        toast.success(
          sent === 1 ? 'Invitation sent' : `${plural(sent, 'invitation')} sent`,
          answer.find((r) => !r.error)?.email,
        );
      }
      if (failed.length > 0) toast.error(`Could not invite ${plural(failed.length, 'person', 'people')}`);
    },
    onError: (error) => toast.error('Could not send the invitation', errorMessage(error)),
  });
  const resend = useMutation({
    mutationFn: (member: Member) => membersApi.resend(member.invitationId ?? member.userId),
    onSuccess: async (row, member) => {
      await refresh();
      if (row.emailSent) toast.success('Invitation sent again', member.email);
      else if (row.inviteAcceptUrl) setShownLink({ email: member.email, link: row.inviteAcceptUrl });
    },
    onError: (error) => toast.error('Could not send the invitation again', errorMessage(error)),
  });
  const copyLink = useMutation({
    mutationFn: (member: Member) => membersApi.inviteLink(member.invitationId ?? member.userId),
    onSuccess: async ({ link }, member) => {
      try {
        await navigator.clipboard.writeText(link);
        toast.success('Invitation link copied', member.email);
      } catch {
        // no clipboard here: show the link to copy by hand
        setShownLink({ email: member.email, link });
      }
    },
    onError: (error) => toast.error('Could not make the invitation link', errorMessage(error)),
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
  const sortBy = (field: MemberSortField) => {
    setSort((current) => ({
      field,
      dir: current.field === field && current.dir === 'asc' ? 'desc' : 'asc',
    }));
    setSkip(0);
  };
  const closeInvite = () => {
    setInviteOpen(false);
    setResults([]);
  };

  return (
    <Panel
      title="Members"
      description="People in this workspace and what they can do."
      action={
        canInvite && (
          <Button
            variant="primary"
            icon={<UserPlus size={15} />}
            onClick={() => setInviteOpen(true)}
            disabled={gate.disabled}
            title={gate.disabled ? gate.reason : undefined}
          >
            Invite
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <TextInput
          type="search"
          aria-label="Search members"
          placeholder="Search by name or email"
          className="min-w-48 flex-1"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label="Filter by role"
          className="w-44"
          value={roleFilter}
          onChange={(e) => {
            setRoleFilter(e.target.value);
            setSkip(0);
          }}
        >
          <option value="">All roles</option>
          <option value="owner">Owner</option>
          {roleOptions.map((o) => (
            <option key={o.slug} value={o.slug}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex items-center gap-3 border-b border-line px-5 py-2 text-xs font-semibold text-ink-3">
        <span className="size-9" aria-hidden="true" />
        {COLUMNS.map((c) => {
          const active = sort.field === c.field;
          return (
            <span key={c.field} className={c.className}>
              <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-ink"
                aria-label={`Sort by ${c.label}`}
                aria-pressed={active}
                onClick={() => sortBy(c.field)}
              >
                {c.label}
                {active && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </button>
            </span>
          );
        })}
      </div>
      {members.isLoading ? (
        <PageLoader />
      ) : members.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(members.error)}
        </Callout>
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? 'No members match' : 'No members yet'}
          description={filtered ? 'Change the search or the role filter.' : undefined}
        />
      ) : (
        <ul>
          {rows.map((m) => {
            const isMe = m.userId === me.data?.user.id;
            const pending = m.status === 'pending';
            const disabled = m.status === 'disabled';
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
                  <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                    {m.name && <span className="truncate">{m.email}</span>}
                    {pending && <Badge tone="warn">Pending</Badge>}
                    {disabled && <Badge tone="err">Disabled</Badge>}
                    {m.managedByScim && <Badge>Managed by SCIM</Badge>}
                  </span>
                </span>
                {pending && canInvite && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<RefreshCw size={13} />}
                    loading={resend.isPending && resend.variables?.userId === m.userId}
                    onClick={() => resend.mutate(m)}
                  >
                    Resend
                  </Button>
                )}
                {pending && canCopyLink && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Copy size={13} />}
                    onClick={() => copyLink.mutate(m)}
                  >
                    Copy invite link
                  </Button>
                )}
                {!pending && canViewProjects && (
                  <Button size="sm" variant="ghost" onClick={() => setProjectsOf(m.userId)}>
                    View projects
                  </Button>
                )}
                {!pending && <CopyResetLinkAction member={m} />}
                {!pending && <AllowManualLoginToggle member={m} />}
                {canChangeRole && !isMe && !pending && m.role !== 'owner' ? (
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
                  <span className="w-36 text-sm text-ink-2">{roleLabel(m.role)}</span>
                )}
                <span className="w-14 text-sm text-ink-2">{pending ? '–' : m.mfaEnabled ? 'On' : 'Off'}</span>
                <span className="w-28 text-sm text-ink-2">
                  {pending ? '–' : m.lastActiveAt ? formatRelative(m.lastActiveAt) : 'Never'}
                </span>
                {canRemove && !isMe && !pending && m.role !== 'owner' && (
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
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3 text-sm text-ink-2">
          <span>
            {skip + 1}–{Math.min(skip + PAGE_SIZE, total)} of {total}
          </span>
          <span className="flex gap-2">
            <Button size="sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
              Previous
            </Button>
            <Button size="sm" disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip(skip + PAGE_SIZE)}>
              Next
            </Button>
          </span>
        </div>
      )}
      <Dialog
        open={inviteOpen}
        onClose={closeInvite}
        title="Invite a member"
        size="sm"
        footer={
          <>
            <Button onClick={closeInvite}>Close</Button>
            <Button
              variant="primary"
              onClick={() => invite.mutate()}
              loading={invite.isPending}
              disabled={!validEmails}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField
            label="Email"
            hint={`One address, or several separated by commas, spaces or new lines (up to ${MAX_INVITES}).`}
          >
            {(id) => (
              <TextArea
                id={id}
                rows={3}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
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
          {results.length > 0 && (
            <ul className="flex flex-col gap-2" aria-label="Invitation results">
              {results.map((r) => (
                <li key={r.id ?? r.email}>
                  <Callout
                    tone={r.error ? 'err' : 'ok'}
                    title={r.error ? `Could not invite ${r.email}` : `Invitation for ${r.email}`}
                  >
                    {r.error && <span className="block">{r.error}</span>}
                    {!r.error && (
                      <span className="block">
                        {r.emailSent ? 'Sent by email.' : 'Not emailed: send them the link.'}
                      </span>
                    )}
                    {r.inviteAcceptUrl && (
                      <span className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate text-xs">{r.inviteAcceptUrl}</code>
                        <CopyLinkButton
                          link={r.inviteAcceptUrl}
                          label={`Copy invitation link for ${r.email}`}
                        />
                      </span>
                    )}
                  </Callout>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
      {shownLink && (
        <InviteLinkDialog email={shownLink.email} link={shownLink.link} onClose={() => setShownLink(null)} />
      )}
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
