/**
 * Settings: the layout and nav, variables. Account, members and API keys live in pages/settings/ (P6-S2)
 * and are re-exported here, so App.tsx's import holds.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Variable as VariableIcon } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { errorMessage } from '../api/client';
import { variablesApi } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import type { Variable } from '../api/types';
import { Button, IconButton } from '../components/ui/Button';
import { cx } from '../components/ui/cx';
import { confirmDialog } from '../components/ui/Dialog';
import { FormField, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

export { AccountSettingsPage } from './settings/AccountSettingsPage';
export { ApiKeysSettingsPage } from './settings/ApiKeysSettingsPage';
export { MembersSettingsPage } from './settings/MembersSettingsPage';

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
    // P6-13: SSO, LDAP, MFA, provisioning and SCIM, for whoever may set up a sign-in method
    ...(can('saml:manage') || can('oidc:manage') || can('ldap:manage')
      ? [{ to: '/settings/authentication', label: 'Authentication' }]
      : []),
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
