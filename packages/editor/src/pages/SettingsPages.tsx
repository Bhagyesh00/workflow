/** Settings: personal account, members and invitations, API keys, variables. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Trash2, UserPlus, Variable as VariableIcon } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { errorMessage } from '../api/client';
import { apiKeysApi, membersApi, variablesApi } from '../api/endpoints';
import { queryKeys, useMe, useProjects, useRoles, useSettings } from '../api/queries';
import type { MemberRemovalChoice, Role, Variable } from '../api/types';
import { ViewProjectsModal } from '../components/projects/ViewProjectsModal';
import { ApiKeyScopesField } from '../components/settings/ApiKeyScopesField';
import { Button, IconButton } from '../components/ui/Button';
import { cx } from '../components/ui/cx';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { FormField, Select, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Segmented } from '../components/ui/Tabs';
import { formatRelative } from '../lib/format';
import { usePermissions } from '../lib/permissions';
import { toast, useUiStore } from '../stores/ui-store';

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the workspace',
  admin: 'Members, projects and all resources',
  member: 'Only the projects they belong to, with the role they get in each',
};

function titleCase(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function SettingsLayout() {
  const { can } = usePermissions();
  const links = [
    { to: '/settings/account', label: 'Your account' },
    { to: '/settings/members', label: 'Members' },
    // P6-46: project and instance roles
    ...(can('role:manage') ? [{ to: '/settings/roles', label: 'Roles' }] : []),
    { to: '/settings/api-keys', label: 'API keys' },
    { to: '/settings/variables', label: 'Variables' },
    { to: '/settings/security', label: 'Security' },
    // P6-45: each link by the scope its page needs (owner and admin hold all three)
    ...(can('externalSecretsProvider:list')
      ? [{ to: '/settings/external-secrets', label: 'External secrets' }]
      : []),
    // P5-09: the builder's model
    ...(can('aiAssistant:manage') ? [{ to: '/settings/ai', label: 'AI' }] : []),
    // P5-71: the Assistant's model, search, permissions and MCP connections
    ...(can('instanceAi:manage') ? [{ to: '/settings/assistant', label: 'Assistant' }] : []),
    // P5-04: every role (the page shows each role what it may do; the MCP key is per user)
    { to: '/settings/mcp', label: 'MCP' },
  ];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8 md:flex-row">
      <nav aria-label="Settings" className="shrink-0 md:w-52">
        <h1 className="mb-4 text-xl font-semibold">Settings</h1>
        <ul className="flex gap-1 md:flex-col">
          {links.map((l) => (
            <li key={l.to}>
              <NavLink
                to={l.to}
                className={({ isActive }) =>
                  cx(
                    'block rounded-lg px-3 py-2 text-sm font-semibold',
                    isActive ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-surface-3 hover:text-ink',
                  )
                }
              >
                {l.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <div className="flex-1">
          <h2 className="text-md font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function AccountSettingsPage() {
  const me = useMe();
  const settings = useSettings();
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  if (!me.data) return <PageLoader />;
  const { user, tenant, role } = me.data;
  return (
    <div className="flex flex-col gap-5">
      <Panel title="Your account">
        <dl className="grid grid-cols-[140px_1fr] gap-y-3 px-5 py-4 text-sm">
          <dt className="text-ink-3">Name</dt>
          <dd className="font-semibold">{user.name}</dd>
          <dt className="text-ink-3">Email</dt>
          <dd>{user.email}</dd>
          <dt className="text-ink-3">Workspace</dt>
          <dd>{tenant.name}</dd>
          <dt className="text-ink-3">Role</dt>
          <dd className="capitalize">{role}</dd>
          <dt className="text-ink-3">Timezone</dt>
          <dd>{settings.timezone}</dd>
        </dl>
      </Panel>
      <Panel title="Appearance" description="Applies to this browser only.">
        <div className="px-5 py-4">
          <Segmented
            label="Theme"
            value={theme}
            onChange={setTheme}
            items={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'Match system' },
            ]}
          />
        </div>
      </Panel>
    </div>
  );
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
        .map((r) => ({ slug: r.slug, label: r.displayName, hint: r.description ?? ROLE_HINTS[r.slug] ?? '' })),
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

export function ApiKeysSettingsPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: queryKeys.apiKeys, queryFn: apiKeysApi.list });
  const [name, setName] = useState('');
  // empty means every scope
  const [scopes, setScopes] = useState<string[]>([]);
  // "only the scopes I pick" with none picked would make a key that can use every route
  const [onlyPicked, setOnlyPicked] = useState(false);
  // a new key starts on All scopes: the field is made again
  const [scopeFormKey, setScopeFormKey] = useState(0);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => apiKeysApi.create(name.trim(), scopes),
    onSuccess: async (result) => {
      setCreated({ name: result.name, key: result.key });
      setCopied(false);
      setName('');
      setScopes([]);
      setOnlyPicked(false);
      setScopeFormKey((n) => n + 1);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
    onError: (error) => toast.error('Could not create the key', errorMessage(error)),
  });
  const remove = async (id: string, keyName: string) => {
    const ok = await confirmDialog({
      title: `Delete “${keyName}”?`,
      description: 'Anything using this key stops working right away.',
      confirmLabel: 'Delete key',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await apiKeysApi.remove(id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
      toast.success('API key deleted');
    } catch (error) {
      toast.error('Could not delete the key', errorMessage(error));
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() && !(onlyPicked && !scopes.length)) create.mutate();
  };
  return (
    <Panel
      title="API keys"
      description="Use a key in the X-API-KEY header to call the public API at /api/v1."
    >
      <form onSubmit={submit} className="flex flex-col gap-3 border-b border-line px-5 py-4">
        <div className="flex items-end gap-2">
          <FormField label="New key name" className="flex-1">
            {(id) => (
              <TextInput
                id={id}
                placeholder="Deploy pipeline"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} />}
            loading={create.isPending}
            disabled={!name.trim() || (onlyPicked && scopes.length === 0)}
          >
            Create key
          </Button>
        </div>
        <ApiKeyScopesField
          key={scopeFormKey}
          value={scopes}
          onChange={setScopes}
          onModeChange={setOnlyPicked}
          disabled={create.isPending}
        />
      </form>
      {keys.isLoading ? (
        <PageLoader />
      ) : keys.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(keys.error)}
        </Callout>
      ) : !keys.data?.length ? (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No API keys"
          description="Create one to automate this workspace from scripts and CI."
        />
      ) : (
        <ul>
          {keys.data.map((k) => (
            <li key={k.id} className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{k.name}</span>
                <span className="block text-xs text-ink-3">
                  {k.prefix ? <code>wfk_{k.prefix}_…</code> : null}{' '}
                  {k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : 'never used'}
                </span>
              </span>
              <IconButton label={`Delete ${k.name}`} size="sm" onClick={() => void remove(k.id, k.name)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        title="Copy your new key"
        description="This is the only time the key is shown. Store it somewhere safe."
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            I copied it
          </Button>
        }
      >
        {created && (
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 break-all text-xs" data-testid="new-api-key">
              {created.key}
            </code>
            <IconButton
              label="Copy key"
              size="sm"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(created.key)
                  .then(() => setCopied(true))
                  .catch(() => undefined)
              }
            >
              {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
            </IconButton>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function VariableRow({
  variable,
  onSaved,
  readOnly = false,
}: {
  variable: Variable;
  onSaved: () => void;
  readOnly?: boolean;
}) {
  const [key, setKey] = useState(variable.key);
  const [value, setValue] = useState(variable.value);
  const dirty = key !== variable.key || value !== variable.value;
  const save = useMutation({
    mutationFn: () => variablesApi.update(variable.id, { key, value }),
    onSuccess: () => {
      onSaved();
      toast.success('Variable saved');
    },
    onError: (error) => toast.error('Could not save the variable', errorMessage(error)),
  });
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete $vars.${variable.key}?`,
      description: 'Expressions that read it get undefined.',
      confirmLabel: 'Delete variable',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await variablesApi.remove(variable.id);
      onSaved();
    } catch (error) {
      toast.error('Could not delete the variable', errorMessage(error));
    }
  };
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-2 border-b border-line px-5 py-2.5 last:border-b-0">
      <TextInput
        aria-label="Key"
        className="font-mono"
        value={key}
        readOnly={readOnly}
        onChange={(e) => setKey(e.target.value)}
        aria-invalid={!VARIABLE_KEY.test(key) || undefined}
      />
      <TextInput
        aria-label={`Value of ${variable.key}`}
        value={value}
        readOnly={readOnly}
        onChange={(e) => setValue(e.target.value)}
      />
      <span className="flex gap-1">
        {!readOnly && (
          <Button
            size="sm"
            variant={dirty ? 'primary' : 'ghost'}
            disabled={!dirty || !VARIABLE_KEY.test(key)}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        )}
        {!readOnly && (
          <IconButton label={`Delete ${variable.key}`} size="sm" onClick={() => void remove()}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </span>
    </li>
  );
}

export function VariablesSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canCreate = can('variable:create');
  const canEdit = can('variable:update') && can('variable:delete');
  const variables = useQuery({ queryKey: queryKeys.variables, queryFn: variablesApi.list });
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.variables });
  const create = useMutation({
    mutationFn: () => variablesApi.create({ key: key.trim(), value }),
    onSuccess: () => {
      setKey('');
      setValue('');
      refresh();
      toast.success('Variable created');
    },
    onError: (error) => toast.error('Could not create the variable', errorMessage(error)),
  });
  const validKey = VARIABLE_KEY.test(key.trim());
  // a project variable is set and edited from its project's tab
  const workspaceVariables = (variables.data ?? []).filter((v) => !v.projectId);
  return (
    <Panel
      title="Variables"
      description="Workspace-wide values, read in expressions as $vars.name. A project's own variables are set on its Variables tab and win over these. Do not store secrets here; use credentials."
    >
      {canCreate && (
        <form
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-end gap-2 border-b border-line px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (validKey) create.mutate();
          }}
        >
          <FormField
            label="Key"
            error={key && !validKey ? 'Letters, digits and _ only; no leading digit' : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                className="font-mono"
                placeholder="api_region"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            )}
          </FormField>
          <FormField label="Value">
            {(id) => <TextInput id={id} value={value} onChange={(e) => setValue(e.target.value)} />}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            icon={<Plus size={15} />}
            disabled={!validKey}
            loading={create.isPending}
          >
            Add
          </Button>
        </form>
      )}
      {variables.isLoading ? (
        <PageLoader />
      ) : variables.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(variables.error)}
        </Callout>
      ) : !workspaceVariables.length ? (
        <EmptyState
          icon={<VariableIcon size={20} />}
          title="No variables yet"
          description="Add values that many workflows share, like a region or a base URL."
        />
      ) : (
        <ul>
          {workspaceVariables.map((v) => (
            <VariableRow
              key={`${v.id}:${v.key}:${v.value}`}
              variable={v}
              onSaved={refresh}
              readOnly={!canEdit}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
