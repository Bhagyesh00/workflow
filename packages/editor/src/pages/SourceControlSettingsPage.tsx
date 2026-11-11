/**
 * P6-76 (L6): Settings > Environments (Classic), at /settings/environments (n8n's path). Connect a Git repository
 * over SSH or HTTPS, then pick the branch, the branch colour and the protected workspace switch, or disconnect.
 * Only for `sourceControl:manage` (the settings link is gated on it; the server is the lock).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { sourceControlApi } from '../api/endpoints';
import { queryKeys, useMe, useSourceControlPreferences } from '../api/queries';
import type { SourceControlPreferences } from '../api/types';
import { ConnectionForm } from '../components/source-control/ConnectionForm';
import { Button } from '../components/ui/Button';
import { confirmDialog } from '../components/ui/Dialog';
import { FormField, Select, Switch, TextInput } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';
import { Panel } from './settings/Panel';

const BRANCHES_KEY = [...queryKeys.sourceControl, 'branches'] as const;

function ConnectedBlock({ preferences }: { preferences: SourceControlPreferences }) {
  const queryClient = useQueryClient();
  const branches = useQuery({ queryKey: BRANCHES_KEY, queryFn: sourceControlApi.branches, retry: false });
  const [branch, setBranch] = useState(preferences.branchName);
  const [readOnly, setReadOnly] = useState(preferences.branchReadOnly);
  const [color, setColor] = useState(preferences.branchColor);

  useEffect(() => {
    setBranch(preferences.branchName);
    setReadOnly(preferences.branchReadOnly);
    setColor(preferences.branchColor);
  }, [preferences.branchName, preferences.branchReadOnly, preferences.branchColor]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.sourceControl }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    ]);
  };
  const save = useMutation({
    mutationFn: () =>
      sourceControlApi.patch({ branchName: branch, branchReadOnly: readOnly, branchColor: color }),
    onSuccess: async () => {
      await refresh();
      toast.success('Environment settings saved');
    },
    onError: (error) => toast.error('Could not save the environment settings', errorMessage(error)),
  });
  const disconnect = useMutation({
    mutationFn: () => sourceControlApi.disconnect(),
    onSuccess: async () => {
      await refresh();
      toast.success('Disconnected from Git');
    },
    onError: (error) => toast.error('Could not disconnect', errorMessage(error)),
  });

  const askDisconnect = async () => {
    const ok = await confirmDialog({
      title: 'Disconnect from Git?',
      description:
        'The workspace stops syncing with the repository and the protected switch is turned off. Nothing is deleted from the repository or from this workspace.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (ok) disconnect.mutate();
  };

  const names = branches.data?.branches ?? [];
  const options = names.includes(branch) ? names : [branch, ...names];
  const dirty =
    branch !== preferences.branchName ||
    readOnly !== preferences.branchReadOnly ||
    color.toLowerCase() !== preferences.branchColor.toLowerCase();

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <p className="text-sm text-ink-2">
        Connected to <span className="font-mono text-ink">{preferences.repositoryUrl}</span>
        {preferences.connectionType ? ` over ${preferences.connectionType === 'ssh' ? 'SSH' : 'HTTPS'}` : ''}.
      </p>
      {branches.error && <Callout tone="err">{errorMessage(branches.error)}</Callout>}
      {branches.isLoading ? (
        <PageLoader label="Listing the branches" />
      ) : (
        <FormField
          label="Branch"
          hint="This workspace follows one branch. Another workspace follows another."
        >
          {(id) => (
            <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)}>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      <FormField label="Branch colour" hint="Shown next to the branch name in the sidebar.">
        {(id) => (
          <TextInput
            id={id}
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="h-9 w-16 p-1"
          />
        )}
      </FormField>
      <div className="flex items-start gap-3">
        <Switch checked={readOnly} onChange={setReadOnly} label="Protected workspace" />
        <div className="text-sm">
          <p className="font-semibold text-ink">Protected workspace</p>
          <p className="text-ink-2">
            Changes arrive only by a pull: the server refuses direct edits, new workflows, credentials and
            variables, and a push. Publishing still works.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button variant="danger" loading={disconnect.isPending} onClick={() => void askDisconnect()}>
          Disconnect
        </Button>
      </div>
    </div>
  );
}

export function SourceControlSettingsPage() {
  const me = useMe();
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const allowed = can('sourceControl:manage');
  const preferences = useSourceControlPreferences(allowed);

  if (me.isLoading) return <PageLoader />;
  if (!allowed) return <Callout>Only admins can manage environments.</Callout>;
  if (preferences.isLoading) return <PageLoader />;
  if (preferences.error || !preferences.data) {
    return (
      <Callout tone="err">
        {preferences.error ? errorMessage(preferences.error) : 'Could not load the environment settings.'}
      </Callout>
    );
  }
  const data = preferences.data;
  return (
    <Panel
      title="Environments (Classic)"
      description="Put this workspace on a branch of a Git repository. Push your changes, merge them on the Git host, and pull them into another workspace."
    >
      {data.connected ? (
        <ConnectedBlock preferences={data} />
      ) : (
        <ConnectionForm
          preferences={data}
          onConnected={() => void queryClient.invalidateQueries({ queryKey: queryKeys.sourceControl })}
        />
      )}
    </Panel>
  );
}
