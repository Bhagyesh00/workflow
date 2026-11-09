/**
 * P6-45: the vault section of a project's settings (L19 renders it): the secret names it may read, its own
 * stores, Share or Add store, empty state.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError, errorMessage } from '../../api/client';
import { secretsApi } from '../../api/endpoints';
import { queryKeys, useProject } from '../../api/queries';
import type { SecretConnection } from '../../api/types';
import { usePermissions } from '../../lib/permissions';
import { ConnectionDialog, StateBadge } from '../../pages/SecretsSettingsPage';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { Switch } from '../ui/Field';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

export interface ProjectVaultSectionProps {
  projectId: string;
}

export function ProjectVaultSection({ projectId }: ProjectVaultSectionProps) {
  const queryClient = useQueryClient();
  const project = useProject(projectId);
  const { can } = usePermissions();
  const scoped = project.data ?? null;
  // the workspace switch (project roles use project vaults) widens a project admin on the server only, and the
  // project detail scopes do not carry it: whoever may update the project (a scope only an admin holds) is
  // offered the buttons, and the server answers 403 when the switch is off
  const manages = can('project:update', scoped);
  const canAdd = manages || can('externalSecretsProvider:create', scoped);
  const canUpdate = manages || can('externalSecretsProvider:update', scoped);
  const canDelete = manages || can('externalSecretsProvider:delete', scoped);

  // a workspace vault is shared from the workspace settings
  const canShare = can('externalSecretsProvider:update');
  const [adding, setAdding] = useState(false);

  const completions = useQuery({
    queryKey: queryKeys.projectSecretCompletions(projectId),
    queryFn: () => secretsApi.projectCompletions(projectId),
    enabled: project.isSuccess,
    retry: false,
  });
  const stores = useQuery({
    queryKey: queryKeys.projectSecretConnections(projectId),
    queryFn: () => secretsApi.projectConnections(projectId),
    enabled: project.isSuccess,
    retry: false,
  });
  const types = useQuery({
    queryKey: queryKeys.secretProviderTypes,
    queryFn: secretsApi.types,
    enabled: adding,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['secret-providers'] });
  const setEnabled = useMutation({
    mutationFn: ({ key, isEnabled }: { key: string; isEnabled: boolean }) =>
      secretsApi.updateProjectConnection(projectId, key, { isEnabled }),
    onSuccess: async (c) => {
      await refresh();
      toast.success(c.isEnabled ? 'Store turned on' : 'Store turned off', c.providerKey);
    },
    onError: (error) => toast.error("Couldn't change the store", errorMessage(error)),
  });
  const remove = async (c: SecretConnection) => {
    const ok = await confirmDialog({
      title: `Delete ${c.providerKey}?`,
      description:
        c.credentialsCount > 0
          ? `${c.credentialsCount} ${c.credentialsCount === 1 ? 'credential uses' : 'credentials use'} this store. They stop working until you point them at another store.`
          : 'No credential uses this store.',
      confirmLabel: 'Delete store',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await secretsApi.removeProjectConnection(projectId, c.providerKey);
      await refresh();
      toast.success('Store deleted', c.providerKey);
    } catch (error) {
      toast.error("Couldn't delete the store", errorMessage(error));
    }
  };

  if (project.isLoading) return <PageLoader />;
  // no vault permission here (a 403 on both lists): nothing to show
  const denied = (error: unknown) => error instanceof ApiError && error.status === 403;
  if (!project.isSuccess || (denied(completions.error) && denied(stores.error))) return null;

  const rows = Object.entries(completions.data ?? {}).flatMap(([store, names]) =>
    names.map((name) => ({ store, name })),
  );
  return (
    <section aria-label="External secrets" className="rounded-2xl border border-line bg-surface shadow-card">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold">External secrets</h2>
          <p className="mt-0.5 text-sm text-ink-2">
            The secrets this project's credentials can read with{' '}
            <code className="font-mono text-xs">{'{{ $secrets.<store>.<secret> }}'}</code>. Values stay in the
            vault.
          </p>
        </div>
        {canShare && (
          <Link
            to="/settings/external-secrets"
            className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-sm font-semibold text-ink-2 hover:bg-surface-3"
          >
            Share a store
          </Link>
        )}
        {canAdd && (
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
            Add store
          </Button>
        )}
      </header>

      {completions.isLoading || stores.isLoading ? (
        <PageLoader />
      ) : (completions.isError && !denied(completions.error)) || (stores.isError && !denied(stores.error)) ? (
        <Callout tone="err" className="m-4" title="Couldn't load the stores">
          {errorMessage(completions.error ?? stores.error)}
        </Callout>
      ) : (
        <>
          {rows.length === 0 ? (
            <EmptyState
              icon={<Lock size={20} />}
              title="No secrets in this project"
              description={
                canAdd
                  ? 'Add a store of this project, or share a workspace store with it.'
                  : 'No store is shared with this project yet.'
              }
            />
          ) : (
            <table className="w-full text-left text-sm" aria-label="Secret names">
              <thead>
                <tr className="text-xs text-ink-2">
                  <th className="px-5 py-2 font-semibold">Secret</th>
                  <th className="px-5 py-2 font-semibold">Store</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.store}.${r.name}`} className="border-t border-line">
                    <td className="px-5 py-2 font-mono text-xs">{r.name}</td>
                    <td className="px-5 py-2">{r.store}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(stores.data ?? []).length > 0 && (
            <ul aria-label="Stores" className="border-t border-line">
              {(stores.data ?? []).map((c) => {
                const mine = c.projectId === projectId;
                return (
                  <li
                    key={c.id}
                    data-testid={`project-store-${c.providerKey}`}
                    className="flex items-center gap-3 border-b border-line px-5 py-3 last:border-b-0"
                  >
                    <span className="min-w-0 flex-1 truncate font-semibold">{c.providerKey}</span>
                    <StateBadge connection={c} />
                    {mine ? (
                      <>
                        <Switch
                          label={`${c.providerKey} enabled`}
                          checked={c.isEnabled}
                          disabled={!canUpdate || setEnabled.isPending}
                          onChange={(isEnabled) => setEnabled.mutate({ key: c.providerKey, isEnabled })}
                        />
                        {canDelete && (
                          <Button
                            size="sm"
                            variant="danger"
                            icon={<Trash2 size={13} />}
                            aria-label={`Delete ${c.providerKey}`}
                            onClick={() => void remove(c)}
                          >
                            Delete
                          </Button>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-ink-3">Shared by the workspace</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {adding && (
        <ConnectionDialog
          connection={null}
          types={types.data ?? []}
          typesLoading={types.isLoading}
          existingKeys={(stores.data ?? []).map((c) => c.providerKey)}
          projectId={projectId}
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await refresh();
          }}
        />
      )}
    </section>
  );
}
