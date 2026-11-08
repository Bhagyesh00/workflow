/**
 * P5-04, P5-14, P5-15: Settings > MCP: the status switch, auto expose, the connect dialog, the caller's MCP
 * key (inside it), the workflows table, the OAuth clients and callback URLs. Admins change the switches, the
 * workflow flags in bulk, the clients and the callback URLs; editors see the workflows; every member can
 * connect with their own key. The server checks each role again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import { mcpApi } from '../api/endpoints';
import { useMe } from '../api/queries';
import type { McpToggleAccessBody, McpWorkflowSummary } from '../api/types';
import { McpClientsTable } from '../components/settings/McpClientsTable';
import { McpConnectDialog } from '../components/settings/McpConnectDialog';
import { McpRedirectUris } from '../components/settings/McpRedirectUris';
import { McpWorkflowsTable } from '../components/settings/McpWorkflowsTable';
import { Button } from '../components/ui/Button';
import { Switch } from '../components/ui/Field';
import { Callout, PageLoader } from '../components/ui/misc';
import { toast } from '../stores/ui-store';

const KEYS = {
  settings: ['mcp', 'settings'] as const,
  workflows: (search: string) => ['mcp', 'workflows', search] as const,
  workflowsAll: ['mcp', 'workflows'] as const,
  clients: ['mcp', 'clients'] as const,
  stats: ['mcp', 'stats'] as const,
  redirectUris: ['mcp', 'redirect-uris'] as const,
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function McpSettingsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const role = me.data?.role;
  const isAdmin = role === 'owner' || role === 'admin';
  const isEditor = isAdmin || role === 'editor';
  const [connectOpen, setConnectOpen] = useState(false);
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim(), 250);

  const settings = useQuery({ queryKey: KEYS.settings, queryFn: mcpApi.settings, enabled: Boolean(role) });
  const workflows = useQuery({
    queryKey: KEYS.workflows(term),
    queryFn: () => mcpApi.workflows({ search: term || undefined }),
    enabled: isEditor,
  });
  const clients = useQuery({ queryKey: KEYS.clients, queryFn: mcpApi.clients, enabled: isAdmin });
  const stats = useQuery({ queryKey: KEYS.stats, queryFn: mcpApi.stats, enabled: isAdmin });
  const redirectUris = useQuery({ queryKey: KEYS.redirectUris, queryFn: mcpApi.redirectUris, enabled: isAdmin });

  const patch = useMutation({
    mutationFn: mcpApi.patchSettings,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEYS.settings });
      toast.success('MCP settings saved');
    },
    onError: (error) => toast.error("Couldn't save the MCP settings", errorMessage(error)),
  });

  const toggle = useMutation({
    mutationFn: (body: McpToggleAccessBody) => mcpApi.toggleAccess(body),
    onSuccess: async (result, body) => {
      await queryClient.invalidateQueries({ queryKey: KEYS.workflowsAll });
      toast.success(
        body.allWorkflows
          ? `${result.updatedCount} workflow${result.updatedCount === 1 ? '' : 's'} updated`
          : 'MCP access saved',
      );
    },
    onError: (error) => toast.error("Couldn't change MCP access", errorMessage(error)),
  });

  const saveUris = useMutation({
    mutationFn: mcpApi.patchRedirectUris,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: KEYS.redirectUris });
      toast.success('Callback URLs saved');
    },
    onError: (error) => toast.error("Couldn't save the callback URLs", errorMessage(error)),
  });

  const revoke = useMutation({
    mutationFn: (clientId: string) => mcpApi.deleteClient(clientId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: KEYS.clients }),
        queryClient.invalidateQueries({ queryKey: KEYS.stats }),
      ]);
      toast.success('Client revoked');
    },
    onError: (error) => toast.error("Couldn't revoke the client", errorMessage(error)),
  });

  if (me.isLoading || (settings.isLoading && !settings.data)) return <PageLoader />;
  if (me.isError || settings.isError || !settings.data) {
    return (
      <section className="flex max-w-2xl flex-col gap-4">
        <h2 className="text-lg font-semibold">MCP</h2>
        <Callout tone="err" title="Couldn't load the MCP settings">
          {errorMessage(settings.error ?? me.error)}
        </Callout>
      </section>
    );
  }

  const current = settings.data;
  // the server's URL on the MCP base URL: the editor's own origin may be another host
  const serverUrl =
    current.serverUrl ??
    `${window.location.origin}/mcp-server/${encodeURIComponent(me.data?.tenant.slug ?? '')}/http`;
  const canSwitch = isAdmin && !current.managedByEnv;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP</h2>
          <p className="mt-1 text-sm text-ink-2">
            Let AI clients that speak MCP find, read and run this workspace's workflows.
          </p>
        </div>
        <Button variant="primary" icon={<Plug size={14} />} onClick={() => setConnectOpen(true)}>
          Connect
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">MCP access</p>
            <p className="text-sm text-ink-2">
              {current.managedByEnv
                ? 'This is set by the server environment and cannot be changed here.'
                : 'Clients can connect to this workspace while it is on.'}
            </p>
          </div>
          {canSwitch ? (
            <Switch
              label="MCP access"
              checked={current.mcpAccessEnabled}
              disabled={patch.isPending}
              onChange={(value) => patch.mutate({ mcpAccessEnabled: value })}
            />
          ) : (
            <span className="text-sm font-medium" data-testid="mcp-status">
              {current.mcpAccessEnabled ? 'On' : 'Off'}
            </span>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <div>
              <p className="text-sm font-semibold">Make new workflows available</p>
              <p className="text-sm text-ink-2">Every workflow created from now on is open to MCP clients.</p>
            </div>
            <Switch
              label="Make new workflows available"
              checked={current.autoExposeNewWorkflows}
              disabled={patch.isPending || current.managedByEnv}
              onChange={(value) => patch.mutate({ autoExposeNewWorkflows: value })}
            />
          </div>
        )}
      </div>

      {!isAdmin && !current.mcpAccessEnabled && (
        <Callout>MCP access is off. An admin can turn it on.</Callout>
      )}

      {isEditor && (
        <McpWorkflowsTable
          workflows={workflows.data}
          loading={workflows.isLoading}
          error={workflows.isError ? errorMessage(workflows.error) : null}
          search={search}
          onSearch={setSearch}
          canToggle={isAdmin}
          mcpOn={current.mcpAccessEnabled}
          busy={toggle.isPending}
          onToggle={(workflow: McpWorkflowSummary, value) =>
            toggle.mutate({ availableInMCP: value, workflowIds: [workflow.id] })
          }
          onBulk={(value) => toggle.mutate({ availableInMCP: value, allWorkflows: true })}
        />
      )}

      {isAdmin && (
        <>
          <McpClientsTable
            clients={clients.data}
            stats={stats.data}
            loading={clients.isLoading}
            error={clients.isError ? errorMessage(clients.error) : null}
            revoking={revoke.isPending ? (revoke.variables ?? null) : null}
            onRevoke={(client) => revoke.mutate(client.id)}
          />
          {redirectUris.isError ? (
            <Callout tone="err" title="Couldn't load the callback URLs">
              {errorMessage(redirectUris.error)}
            </Callout>
          ) : redirectUris.data ? (
            <McpRedirectUris
              value={redirectUris.data.allowedRedirectUris}
              saving={saveUris.isPending}
              onSave={(uris) => saveUris.mutate(uris)}
            />
          ) : (
            <PageLoader label="Loading callback URLs" />
          )}
        </>
      )}

      {connectOpen && (
        <McpConnectDialog
          serverUrl={serverUrl}
          mcpOn={current.mcpAccessEnabled}
          onClose={() => setConnectOpen(false)}
        />
      )}
    </section>
  );
}
