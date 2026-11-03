/** Settings: personal account, members and invitations, API keys, variables. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plus, Trash2, UserPlus, Variable as VariableIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { errorMessage } from '../api/client';
import { apiKeysApi, membersApi, variablesApi } from '../api/endpoints';
import { queryKeys, useMe, useSettings } from '../api/queries';
import { ROLES, type Role, type Variable } from '../api/types';
import { Button, IconButton } from '../components/ui/Button';
import { cx } from '../components/ui/cx';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { FormField, Select, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Segmented } from '../components/ui/Tabs';
import { formatRelative } from '../lib/format';
import { toast, useUiStore } from '../stores/ui-store';

const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, including billing and deleting the workspace',
  admin: 'Members and all resources',
  editor: 'Workflows, credentials and executions',
  viewer: 'Read-only, cannot read credentials',
};

function canManage(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function SettingsLayout() {
  const links = [
    { to: '/settings/account', label: 'Your account' },
    { to: '/settings/members', label: 'Members' },
    { to: '/settings/api-keys', label: 'API keys' },
    { to: '/settings/variables', label: 'Variables' },
    { to: '/settings/security', label: 'Security' },
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

export function MembersSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const manage = canManage(me.data?.role);
  const members = useQuery({ queryKey: queryKeys.members, queryFn: membersApi.list });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
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
  const remove = async (userId: string, name: string) => {
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      description: 'They lose access to this workspace immediately.',
      confirmLabel: 'Remove member',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await membersApi.remove(userId);
      await refresh();
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
        manage && (
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
                {manage && !isMe && m.role !== 'owner' ? (
                  <Select
                    aria-label={`Role of ${m.name || m.email}`}
                    className="w-32"
                    value={m.role}
                    onChange={(e) => updateRole.mutate({ userId: m.userId, role: e.target.value as Role })}
                  >
                    {ROLES.filter((r) => r !== 'owner' || me.data?.role === 'owner').map((r) => (
                      <option key={r} value={r} title={ROLE_HINTS[r]}>
                        {r.charAt(0).toUpperCase() + r.slice(1)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-sm text-ink-2 capitalize">{m.role}</span>
                )}
                {manage && !isMe && m.role !== 'owner' && (
                  <IconButton
                    label={`Remove ${m.name || m.email}`}
                    size="sm"
                    onClick={() => void remove(m.userId, m.name || m.email)}
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
                {ROLES.filter((r) => r !== 'owner').map((r) => (
                  <option key={r} value={r}>
                    {r.charAt(0).toUpperCase() + r.slice(1)}
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
    </Panel>
  );
}

export function ApiKeysSettingsPage() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: queryKeys.apiKeys, queryFn: apiKeysApi.list });
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () => apiKeysApi.create(name.trim()),
    onSuccess: async (result) => {
      setCreated({ name: result.name, key: result.key });
      setCopied(false);
      setName('');
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
    if (name.trim()) create.mutate();
  };
  return (
    <Panel
      title="API keys"
      description="Use a key in the X-API-KEY header to call the public API at /api/v1."
    >
      <form onSubmit={submit} className="flex items-end gap-2 border-b border-line px-5 py-4">
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
          disabled={!name.trim()}
        >
          Create key
        </Button>
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

const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function VariableRow({ variable, onSaved }: { variable: Variable; onSaved: () => void }) {
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
        onChange={(e) => setKey(e.target.value)}
        aria-invalid={!VARIABLE_KEY.test(key) || undefined}
      />
      <TextInput
        aria-label={`Value of ${variable.key}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span className="flex gap-1">
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'ghost'}
          disabled={!dirty || !VARIABLE_KEY.test(key)}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <IconButton label={`Delete ${variable.key}`} size="sm" onClick={() => void remove()}>
          <Trash2 size={14} />
        </IconButton>
      </span>
    </li>
  );
}

export function VariablesSettingsPage() {
  const queryClient = useQueryClient();
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
  return (
    <Panel
      title="Variables"
      description="Workspace-wide values, read in expressions as $vars.name. Do not store secrets here; use credentials."
    >
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
      {variables.isLoading ? (
        <PageLoader />
      ) : variables.error ? (
        <Callout tone="err" className="m-4">
          {errorMessage(variables.error)}
        </Callout>
      ) : !variables.data?.length ? (
        <EmptyState
          icon={<VariableIcon size={20} />}
          title="No variables yet"
          description="Add values that many workflows share, like a region or a base URL."
        />
      ) : (
        <ul>
          {variables.data.map((v) => (
            <VariableRow key={`${v.id}:${v.key}:${v.value}`} variable={v} onSaved={refresh} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
