/**
 * /settings/external-secrets (P4-07): admins connect a secrets vault (AWS, Google Cloud, Azure, HashiCorp
 * Vault, 1Password, Infisical), turn it on, test and reload it. Credentials then read its secrets with
 * `{{ $secrets.<connection>.<secret> }}`. The server never sends a secret value; settings that are
 * secrets arrive blanked and are sent back unchanged to keep them.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeParameters, WorkflowNode } from '@workflow/workflow';
import { resolveNodeParameters } from '@workflow/workflow';
import { Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { secretsApi } from '../api/endpoints';
import { queryKeys, useMe, useProjects } from '../api/queries';
import type { SecretConnection, SecretConnectionState, SecretProviderTypeInfo } from '../api/types';
import { ParameterContext, type ParameterContextValue } from '../components/parameters/context';
import { ParameterList } from '../components/parameters/ParameterForm';
import { Button } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { Checkbox, FormField, Select, Switch, TextInput } from '../components/ui/Field';
import { Badge, Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { setIn } from '../lib/workflow-ops';
import { toast } from '../stores/ui-store';

/** the server's rule for the name used in `$secrets.<name>.<secret>` */
const CONNECTION_KEY = /^[a-zA-Z][a-zA-Z0-9]*$/;

/** P6-28: the workspace switch that lets project admins and editors use project vaults through their system role */
const SYSTEM_ROLES_PATH = '/external-secrets/settings';
const SYSTEM_ROLES_KEY = ['secret-providers', 'system-roles'] as const;

const STATE_META: Record<
  SecretConnectionState,
  { label: string; tone: 'neutral' | 'ok' | 'err' | 'warn' | 'run' }
> = {
  initializing: { label: 'Starting', tone: 'run' },
  initialized: { label: 'Off', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'run' },
  connected: { label: 'Connected', tone: 'ok' },
  error: { label: 'Error', tone: 'err' },
  retrying: { label: 'Retrying', tone: 'warn' },
};

export function stateLabel(connection: SecretConnection): string {
  if (!connection.isEnabled) return 'Off';
  return STATE_META[connection.state]?.label ?? connection.state;
}

export function StateBadge({ connection }: { connection: SecretConnection }) {
  const meta = connection.isEnabled
    ? (STATE_META[connection.state] ?? STATE_META.initializing)
    : STATE_META.initialized;
  return (
    <Badge tone={meta.tone}>
      <span data-testid="secret-state">{stateLabel(connection)}</span>
    </Badge>
  );
}

export function SecretsSettingsPage() {
  const me = useMe();
  const { can } = usePermissions();
  // P6-45: by scope (owner and admin hold it); the project role's vaults are on the project's settings
  const isAdmin = can('externalSecretsProvider:list');
  const canUpdate = can('externalSecretsProvider:update');
  const queryClient = useQueryClient();
  const systemRoles = useQuery({
    queryKey: SYSTEM_ROLES_KEY,
    queryFn: () => api.get<{ systemRolesEnabled: boolean }>(SYSTEM_ROLES_PATH),
    enabled: isAdmin,
    retry: false,
  });
  const setSystemRoles = useMutation({
    mutationFn: (systemRolesEnabled: boolean) =>
      api.post<{ systemRolesEnabled: boolean }>(SYSTEM_ROLES_PATH, { systemRolesEnabled }),
    onSuccess: async (result) => {
      queryClient.setQueryData(SYSTEM_ROLES_KEY, result);
      toast.success(
        result.systemRolesEnabled
          ? 'Project roles can use project vaults'
          : 'Project vaults follow their own roles',
      );
    },
    onError: (error) => toast.error("Couldn't change the setting", errorMessage(error)),
  });
  const types = useQuery({
    queryKey: queryKeys.secretProviderTypes,
    queryFn: secretsApi.types,
    enabled: isAdmin,
  });
  const connections = useQuery({
    queryKey: queryKeys.secretConnections,
    queryFn: secretsApi.connections,
    enabled: isAdmin,
  });
  const [editing, setEditing] = useState<SecretConnection | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['secret-providers'] });
  };

  const setEnabled = useMutation({
    mutationFn: ({ key, isEnabled }: { key: string; isEnabled: boolean }) =>
      secretsApi.updateConnection(key, { isEnabled }),
    onSuccess: async (connection) => {
      await refresh();
      toast.success(
        connection.isEnabled ? 'Connection turned on' : 'Connection turned off',
        connection.providerKey,
      );
    },
    onError: (error) => toast.error("Couldn't change the connection", errorMessage(error)),
  });

  const run = async (key: string, action: 'test' | 'reload') => {
    setBusy(`${action}:${key}`);
    try {
      if (action === 'test') {
        const result = await secretsApi.testConnection(key);
        if (result.success) toast.success('Connection works', key);
        else toast.error('Connection failed', result.error);
      } else {
        const result = await secretsApi.reloadConnection(key);
        if (result.success) toast.success('Secrets reloaded', key);
        else toast.error("Couldn't reload the secrets", key);
      }
      await refresh();
    } catch (error) {
      toast.error(
        action === 'test' ? "Couldn't test the connection" : "Couldn't reload the secrets",
        errorMessage(error),
      );
    } finally {
      setBusy(null);
    }
  };

  const remove = async (connection: SecretConnection) => {
    const used = connection.credentialsCount;
    const ok = await confirmDialog({
      title: `Delete ${connection.providerKey}?`,
      description:
        used > 0
          ? `${used} ${used === 1 ? 'credential uses' : 'credentials use'} this connection. They stop working until you point them at another connection.`
          : 'No credential uses this connection.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await secretsApi.removeConnection(connection.providerKey);
      await refresh();
      toast.success('Connection deleted', connection.providerKey);
    } catch (error) {
      toast.error("Couldn't delete the connection", errorMessage(error));
    }
  };

  if (me.isLoading) return <PageLoader />;
  if (!isAdmin) return <Callout>Only admins can manage external secrets.</Callout>;

  const typeName = (name: string) => types.data?.find((t) => t.name === name)?.displayName ?? name;
  return (
    <section className="flex max-w-3xl flex-col gap-4" aria-label="External secrets">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">External secrets</h2>
          <p className="mt-1 text-sm text-ink-2">
            Connect a secrets vault. A credential field then reads a secret with{' '}
            <code className="font-mono text-xs">{'{{ $secrets.<connection>.<secret> }}'}</code>. The values
            stay in the vault: they are never shown here or saved in a workflow.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>
          Add connection
        </Button>
      </header>

      <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface p-4">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Project roles use project vaults</p>
          <p className="mt-0.5 text-sm text-ink-2">
            When on, a project admin can manage and a project editor can read the vaults of their project
            through the project role. When off, only members with a vault permission in that project can.
          </p>
        </div>
        <Switch
          label="Project roles use project vaults"
          checked={systemRoles.data?.systemRolesEnabled === true}
          disabled={!canUpdate || systemRoles.isLoading || setSystemRoles.isPending}
          onChange={(on) => setSystemRoles.mutate(on)}
        />
      </div>

      {connections.isLoading ? (
        <PageLoader />
      ) : connections.isError ? (
        <Callout tone="err" title="Couldn't load the connections">
          {errorMessage(connections.error)}
        </Callout>
      ) : (connections.data ?? []).length === 0 ? (
        <EmptyState
          icon={<Lock size={20} />}
          title="No connections yet"
          description="Add a connection to read secrets from your vault."
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Connections">
          {(connections.data ?? []).map((c) => (
            <li
              key={c.id}
              data-testid={`secret-card-${c.providerKey}`}
              className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold text-ink">
                    <span className="truncate">{c.providerKey}</span>
                    <StateBadge connection={c} />
                  </p>
                  <p className="mt-0.5 text-sm text-ink-2">
                    {typeName(c.type)}
                    {c.isEnabled && c.state === 'connected' && (
                      <>
                        {' '}
                        · {c.secretsCount} {c.secretsCount === 1 ? 'secret' : 'secrets'}
                      </>
                    )}
                    {' · '}
                    {c.credentialsCount} {c.credentialsCount === 1 ? 'credential' : 'credentials'}
                  </p>
                  {(c.projects ?? []).length > 0 && (
                    <p className="mt-0.5 text-sm text-ink-3">
                      Shared with {(c.projects ?? []).map((p) => p.name).join(', ')}
                    </p>
                  )}
                </div>
                <Switch
                  label={`${c.providerKey} enabled`}
                  checked={c.isEnabled}
                  disabled={setEnabled.isPending}
                  onChange={(isEnabled) => setEnabled.mutate({ key: c.providerKey, isEnabled })}
                />
              </div>
              {c.isEnabled && c.lastError && (
                <Callout tone="err" title="The last connect failed">
                  {c.lastError}
                </Callout>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setEditing(c)}>Edit</Button>
                <Button
                  loading={busy === `test:${c.providerKey}`}
                  onClick={() => void run(c.providerKey, 'test')}
                >
                  Test
                </Button>
                <Button
                  icon={<RefreshCw size={14} />}
                  disabled={!c.isEnabled}
                  loading={busy === `reload:${c.providerKey}`}
                  onClick={() => void run(c.providerKey, 'reload')}
                >
                  Reload
                </Button>
                <Button
                  variant="danger"
                  icon={<Trash2 size={14} />}
                  aria-label={`Delete ${c.providerKey}`}
                  onClick={() => void remove(c)}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ConnectionDialog
          connection={editing === 'new' ? null : editing}
          types={types.data ?? []}
          typesLoading={types.isLoading}
          existingKeys={(connections.data ?? []).map((c) => c.providerKey)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

/**
 * The add and edit dialog. With `projectId` it saves a vault owned by that project (the project settings'
 * Add store); without it a workspace vault, which can be shared with projects.
 */
export function ConnectionDialog({
  connection,
  types,
  typesLoading,
  existingKeys,
  projectId,
  onClose,
  onSaved,
}: {
  connection: SecretConnection | null;
  types: SecretProviderTypeInfo[];
  typesLoading: boolean;
  existingKeys: string[];
  projectId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const editing = connection !== null;
  const [providerKey, setProviderKey] = useState(connection?.providerKey ?? '');
  const [type, setType] = useState(connection?.type ?? '');
  const [settings, setSettings] = useState<NodeParameters>((connection?.settings ?? {}) as NodeParameters);
  const [touched, setTouched] = useState(false);
  const teamProjects = (useProjects(!projectId).data ?? []).filter((p) => p.type === 'team');
  const [sharedIds, setSharedIds] = useState<string[]>((connection?.projects ?? []).map((p) => p.id));
  useEffect(() => {
    if (!type && types[0]) setType(types[0].name);
  }, [type, types]);
  const info = types.find((t) => t.name === type);
  const properties = useMemo(() => info?.properties ?? [], [info]);

  const keyError = !providerKey.trim()
    ? 'Enter a name'
    : !CONNECTION_KEY.test(providerKey)
      ? 'Use letters and numbers only, starting with a letter'
      : !editing && existingKeys.includes(providerKey)
        ? 'A connection with this name already exists'
        : null;

  const save = useMutation({
    mutationFn: async () => {
      const values = resolveNodeParameters(properties, settings) as Record<string, unknown>;
      if (projectId) {
        if (editing)
          return secretsApi.updateProjectConnection(projectId, connection.providerKey, { settings: values });
        return secretsApi.createProjectConnection(projectId, { providerKey, type, settings: values });
      }
      if (editing)
        return secretsApi.updateConnection(connection.providerKey, {
          settings: values,
          projectIds: sharedIds,
        });
      return secretsApi.createConnection({ providerKey, type, settings: values, projectIds: sharedIds });
    },
    onSuccess: async (saved) => {
      toast.success(editing ? 'Connection saved' : 'Connection added', saved.providerKey);
      await onSaved();
    },
    onError: (error) => toast.error("Couldn't save the connection", errorMessage(error)),
  });

  const node: WorkflowNode = useMemo(
    () => ({
      id: 'secretConnection',
      name: 'secretConnection',
      type,
      typeVersion: 1,
      position: [0, 0],
      parameters: settings,
    }),
    [type, settings],
  );
  const context: ParameterContextValue = useMemo(
    () => ({
      node,
      rootValues: settings,
      readOnly: false,
      allowExpressions: false,
      keepSecretOnEmpty: editing,
      onChange: (path, value) => setSettings((s) => setIn(s, path, value) as NodeParameters),
    }),
    [node, settings, editing],
  );

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      title={editing ? `Edit ${connection.providerKey}` : 'Add connection'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!info}
            onClick={() => {
              setTouched(true);
              if (!keyError) save.mutate();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      {typesLoading ? (
        <PageLoader />
      ) : (
        <div className="flex flex-col gap-4">
          <FormField
            label="Connection name"
            hint={`Used as $secrets.${providerKey || 'name'}.<secret>`}
            error={touched ? keyError : undefined}
          >
            {(id) => (
              <TextInput
                id={id}
                value={providerKey}
                disabled={editing}
                maxLength={128}
                placeholder="vault"
                onChange={(e) => setProviderKey(e.target.value)}
                data-autofocus
              />
            )}
          </FormField>
          <FormField label="Provider">
            {(id) => (
              <Select
                id={id}
                value={type}
                disabled={editing}
                onChange={(e) => {
                  setType(e.target.value);
                  setSettings({});
                }}
              >
                {types.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.displayName}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <ParameterContext.Provider value={context}>
            <ParameterList properties={properties} values={settings} path={[]} />
          </ParameterContext.Provider>
          {!projectId && teamProjects.length > 0 && (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-semibold">Share with projects</legend>
              {teamProjects.map((p) => (
                <Checkbox
                  key={p.id}
                  label={p.name}
                  checked={sharedIds.includes(p.id)}
                  onChange={(e) =>
                    setSharedIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((i) => i !== p.id)))
                  }
                />
              ))}
            </fieldset>
          )}
          {!editing && <Callout>A new connection is off until you turn it on.</Callout>}
        </div>
      )}
    </Dialog>
  );
}
