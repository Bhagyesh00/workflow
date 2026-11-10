/** P6-12: Settings > Authentication > LDAP: connection, attributes, test, sync (dry and live), history. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, PlugZap, RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { ldapApi } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import type { LdapConfig, LdapConnectionSecurity, LdapSyncRun } from '../api/types';
import { Button } from '../components/ui/Button';
import { Checkbox, FormField, Select, Switch, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { formatDateTime } from '../lib/format';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

const SECURITY_LABELS: Record<LdapConnectionSecurity, string> = {
  none: 'None',
  tls: 'TLS (LDAPS)',
  startTls: 'STARTTLS',
};
/** the port a security choice usually means; kept while the admin has typed another one */
const DEFAULT_PORTS: Record<LdapConnectionSecurity, number> = { none: 389, tls: 636, startTls: 389 };

type Form = Omit<LdapConfig, 'bindingAdminPassword'>;

function formOf(config: LdapConfig): Form {
  const { bindingAdminPassword: _blank, ...rest } = config;
  return rest;
}

const numberOr = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function runSummary(run: LdapSyncRun): string {
  return `${run.scanned} scanned, ${run.created} created, ${run.updated} updated, ${run.disabled} disabled`;
}

export function LdapSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canSync = can('ldap:sync');
  const config = useQuery({ queryKey: queryKeys.ldapConfig, queryFn: ldapApi.config });
  const runs = useQuery({ queryKey: queryKeys.ldapSyncRuns, queryFn: ldapApi.syncRuns, enabled: canSync });
  const [form, setForm] = useState<Form | null>(null);
  const [password, setPassword] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config.data) setForm(formOf(config.data));
  }, [config.data]);

  const saved = config.data ? formOf(config.data) : null;
  const dirty = Boolean(form && saved && (JSON.stringify(form) !== JSON.stringify(saved) || password !== ''));
  const hasConnection = Boolean(saved?.connectionUrl);

  const save = useMutation({
    mutationFn: (body: Partial<LdapConfig>) => ldapApi.saveConfig(body),
    onSuccess: async (result) => {
      setSaveError(null);
      setPassword('');
      setTested(null);
      queryClient.setQueryData(queryKeys.ldapConfig, result);
      setForm(formOf(result));
      toast.success('LDAP settings saved');
    },
    onError: (error) => setSaveError(errorMessage(error)),
  });
  const test = useMutation({
    mutationFn: ldapApi.testConnection,
    onSuccess: () => setTested({ ok: true, text: 'The directory answered and the admin account signed in.' }),
    onError: (error) => setTested({ ok: false, text: errorMessage(error) }),
  });
  const sync = useMutation({
    mutationFn: (mode: 'dry' | 'live') => ldapApi.sync(mode),
    onSuccess: async (run) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.ldapSyncRuns });
      if (run.status === 'error') toast.error('The sync did not finish', run.error ?? undefined);
      else toast.success(run.runMode === 'dry' ? 'Dry run done' : 'Sync done', runSummary(run));
    },
    onError: (error) => toast.error('Could not run the sync', errorMessage(error)),
  });

  if (config.isLoading || !form) {
    return config.error ? <Callout tone="err">{errorMessage(config.error)}</Callout> : <PageLoader />;
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ ...form, ...(password ? { bindingAdminPassword: password } : {}) });
  };
  const chooseSecurity = (security: LdapConnectionSecurity) => {
    setForm((f) =>
      f
        ? {
            ...f,
            connectionSecurity: security,
            connectionPort:
              f.connectionPort === DEFAULT_PORTS[f.connectionSecurity]
                ? DEFAULT_PORTS[security]
                : f.connectionPort,
          }
        : f,
    );
  };
  const syncBlock = dirty
    ? 'Save your changes first.'
    : !hasConnection
      ? 'Save the connection settings first.'
      : null;

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} aria-label="LDAP settings" className="flex flex-col gap-5">
        <Panel
          title="LDAP sign-in"
          description="People sign in with their directory password. Owners can still sign in with an email and password."
          action={
            <Switch
              label="Allow LDAP sign-in"
              checked={form.loginEnabled}
              onChange={(value) => set('loginEnabled', value)}
              disabled={save.isPending}
            />
          }
        >
          <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
            <FormField label="Login button label" hint="Shown on the sign-in page.">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.loginLabel}
                  placeholder="Company directory"
                  onChange={(e) => set('loginLabel', e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Server address" hint="A host name or address, without ldap:// or a port.">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.connectionUrl}
                  placeholder="ldap.example.com"
                  onChange={(e) => set('connectionUrl', e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Connection security">
              {(id) => (
                <Select
                  id={id}
                  value={form.connectionSecurity}
                  onChange={(e) => chooseSecurity(e.target.value as LdapConnectionSecurity)}
                >
                  {(Object.keys(SECURITY_LABELS) as LdapConnectionSecurity[]).map((key) => (
                    <option key={key} value={key}>
                      {SECURITY_LABELS[key]}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="Port">
              {(id) => (
                <TextInput
                  id={id}
                  type="number"
                  min={1}
                  max={65535}
                  value={form.connectionPort}
                  onChange={(e) => set('connectionPort', numberOr(e.target.value, form.connectionPort))}
                />
              )}
            </FormField>
            <FormField label="Base DN" hint="Where the search starts, such as dc=example,dc=com.">
              {(id) => (
                <TextInput id={id} value={form.baseDn} onChange={(e) => set('baseDn', e.target.value)} />
              )}
            </FormField>
            <FormField label="User filter" hint="Optional, one filter such as (objectClass=person).">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.userFilter}
                  placeholder="(objectClass=person)"
                  onChange={(e) => set('userFilter', e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="Admin DN"
              hint="The account that searches the directory. Leave empty to search anonymously."
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={form.bindingAdminDn}
                  autoComplete="off"
                  onChange={(e) => set('bindingAdminDn', e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="Admin password"
              hint="Stored encrypted and never shown again. Leave blank to keep the saved one."
            >
              {(id) => (
                <TextInput
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </FormField>
          </div>
          {form.connectionSecurity === 'none' && (
            <Callout tone="warn" className="mx-5 mb-4">
              With no security, passwords cross the network in the clear. Use TLS or STARTTLS unless the
              network is fully yours.
            </Callout>
          )}
          <div className="border-t border-line px-5 py-4">
            <Checkbox
              label="Allow certificates that can't be verified"
              checked={form.allowUnauthorizedCerts}
              onChange={(e) => set('allowUnauthorizedCerts', e.target.checked)}
            />
            {form.allowUnauthorizedCerts && (
              <Callout tone="warn" className="mt-3">
                The server's certificate is not checked, so anyone on the network could pose as your
                directory. Use this only on a network you trust.
              </Callout>
            )}
          </div>
        </Panel>

        <Panel title="Attributes" description="Which directory attributes make a person in this workspace.">
          <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
            <FormField label="Login ID attribute" hint="What people type to sign in, such as uid or mail.">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.loginIdAttribute}
                  onChange={(e) => set('loginIdAttribute', e.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="LDAP ID attribute"
              hint="A value that never changes, such as entryUUID or objectGUID."
            >
              {(id) => (
                <TextInput
                  id={id}
                  value={form.ldapIdAttribute}
                  onChange={(e) => set('ldapIdAttribute', e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Email attribute">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.emailAttribute}
                  onChange={(e) => set('emailAttribute', e.target.value)}
                />
              )}
            </FormField>
            <FormField label="First name attribute">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.firstNameAttribute}
                  onChange={(e) => set('firstNameAttribute', e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Last name attribute">
              {(id) => (
                <TextInput
                  id={id}
                  value={form.lastNameAttribute}
                  onChange={(e) => set('lastNameAttribute', e.target.value)}
                />
              )}
            </FormField>
          </div>
          <div className="flex flex-col gap-3 border-t border-line px-5 py-4">
            <Checkbox
              label="Link existing accounts by email"
              checked={form.linkExistingAccountsByEmail}
              onChange={(e) => set('linkExistingAccountsByEmail', e.target.checked)}
            />
            <p className="-mt-2 pl-6 text-xs text-ink-2">
              Only people who are members of this workspace, or invited to it, are ever linked. Everyone else
              is refused.
            </p>
            <Checkbox
              label="Skip entries that share an email"
              checked={form.enforceEmailUniqueness}
              onChange={(e) => set('enforceEmailUniqueness', e.target.checked)}
            />
          </div>
        </Panel>

        <Panel
          title="Synchronization"
          description="Adds new people, updates names and turns off people who left the directory."
        >
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="flex items-center gap-3">
              <Switch
                label="Synchronize users"
                checked={form.synchronizationEnabled}
                onChange={(value) => set('synchronizationEnabled', value)}
                disabled={save.isPending}
              />
              <span className="text-sm">Synchronize users on a schedule</span>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <FormField label="Sync interval (minutes)">
                {(id) => (
                  <TextInput
                    id={id}
                    type="number"
                    min={1}
                    value={form.synchronizationInterval}
                    onChange={(e) =>
                      set('synchronizationInterval', numberOr(e.target.value, form.synchronizationInterval))
                    }
                  />
                )}
              </FormField>
              <FormField label="Page size" hint="0 reads everything in one page.">
                {(id) => (
                  <TextInput
                    id={id}
                    type="number"
                    min={0}
                    value={form.searchPageSize}
                    onChange={(e) => set('searchPageSize', numberOr(e.target.value, form.searchPageSize))}
                  />
                )}
              </FormField>
              <FormField label="Search timeout (seconds)">
                {(id) => (
                  <TextInput
                    id={id}
                    type="number"
                    min={0}
                    value={form.searchTimeout}
                    onChange={(e) => set('searchTimeout', numberOr(e.target.value, form.searchTimeout))}
                  />
                )}
              </FormField>
            </div>
          </div>
        </Panel>

        {saveError && <Callout tone="err">{saveError}</Callout>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            Save settings
          </Button>
          <Button
            type="button"
            variant="secondary"
            icon={<PlugZap size={15} />}
            loading={test.isPending}
            disabled={dirty || !hasConnection}
            title={dirty ? 'Save your changes first.' : undefined}
            onClick={() => {
              setTested(null);
              test.mutate();
            }}
          >
            Test connection
          </Button>
        </div>
        {tested && (
          <Callout
            tone={tested.ok ? 'ok' : 'err'}
            title={tested.ok ? 'Connection works' : "Couldn't connect"}
          >
            {tested.text}
          </Callout>
        )}
      </form>

      {canSync && (
        <Panel
          title="Sync history"
          description="A dry run counts what a sync would change and writes nothing else."
          action={
            <div className="flex gap-2">
              <Button
                variant="secondary"
                icon={<RefreshCw size={15} />}
                loading={sync.isPending && sync.variables === 'dry'}
                disabled={Boolean(syncBlock) || sync.isPending}
                title={syncBlock ?? undefined}
                onClick={() => sync.mutate('dry')}
              >
                Dry run
              </Button>
              <Button
                variant="primary"
                icon={<RefreshCw size={15} />}
                loading={sync.isPending && sync.variables === 'live'}
                disabled={Boolean(syncBlock) || sync.isPending}
                title={syncBlock ?? undefined}
                onClick={() => sync.mutate('live')}
              >
                Run sync
              </Button>
            </div>
          }
        >
          {runs.isLoading ? (
            <PageLoader />
          ) : runs.error ? (
            <Callout tone="err" className="m-4">
              {errorMessage(runs.error)}
            </Callout>
          ) : !runs.data?.length ? (
            <EmptyState
              icon={<History size={20} />}
              title="No syncs yet"
              description="Run a dry run to see what a sync would do."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-ink-3">
                  <tr>
                    <th className="px-5 py-2 font-medium">Started</th>
                    <th className="px-2 py-2 font-medium">Mode</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 text-right font-medium">Scanned</th>
                    <th className="px-2 py-2 text-right font-medium">Created</th>
                    <th className="px-2 py-2 text-right font-medium">Updated</th>
                    <th className="px-2 py-2 text-right font-medium">Disabled</th>
                    <th className="px-5 py-2 font-medium">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((run) => (
                    <tr key={run.id} className="border-t border-line">
                      <td className="px-5 py-2">{formatDateTime(run.startedAt)}</td>
                      <td className="px-2 py-2">{run.runMode === 'dry' ? 'Dry run' : 'Live'}</td>
                      <td className="px-2 py-2">{run.status === 'success' ? 'Success' : 'Error'}</td>
                      <td className="px-2 py-2 text-right">{run.scanned}</td>
                      <td className="px-2 py-2 text-right">{run.created}</td>
                      <td className="px-2 py-2 text-right">{run.updated}</td>
                      <td className="px-2 py-2 text-right">{run.disabled}</td>
                      <td className="px-5 py-2 text-err">{run.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
