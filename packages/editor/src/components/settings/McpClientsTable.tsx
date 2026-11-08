/** P5-14, P5-15: the OAuth clients registered in this workspace, with revoke (admins). */
import { Trash2 } from 'lucide-react';
import type { McpInstanceStats, McpOAuthClient } from '../../api/types';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { Callout, EmptyState, PageLoader } from '../ui/misc';

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

export function McpClientsTable({
  clients,
  stats,
  loading,
  error,
  revoking,
  onRevoke,
}: {
  clients: McpOAuthClient[] | undefined;
  stats: McpInstanceStats | undefined;
  loading: boolean;
  error: string | null;
  /** the id being revoked */
  revoking: string | null;
  onRevoke: (client: McpOAuthClient) => void;
}) {
  const revoke = async (client: McpOAuthClient) => {
    const ok = await confirmDialog({
      title: `Revoke ${client.name}?`,
      description: 'The client loses access now: its tokens stop working and it has to be approved again.',
      confirmLabel: 'Revoke access',
      tone: 'danger',
    });
    if (ok) onRevoke(client);
  };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" aria-labelledby="mcp-clients">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="mcp-clients" className="text-md font-semibold">
          Connected clients
        </h3>
        {stats && (
          <span className="text-xs text-ink-3" data-testid="mcp-client-count">
            {stats.registeredClients} of {stats.maxRegisteredClients} registered
          </span>
        )}
      </div>
      {loading ? (
        <PageLoader label="Loading clients" />
      ) : error ? (
        <Callout tone="err" title="Couldn't load the clients">
          {error}
        </Callout>
      ) : !clients || clients.length === 0 ? (
        <EmptyState
          title="No clients yet"
          description="An MCP client shows up here after it registers and a user approves it."
        />
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-3">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Client</th>
              <th className="py-1.5 pr-3 font-medium">Callback URLs</th>
              <th className="py-1.5 pr-3 font-medium">Added</th>
              <th className="py-1.5 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.id} className="border-t border-line align-top">
                <td className="py-2 pr-3 font-medium">{client.name}</td>
                <td className="py-2 pr-3 text-ink-2">
                  {client.redirectUris.map((uri) => (
                    <div key={uri} className="break-all font-mono text-xs">
                      {uri}
                    </div>
                  ))}
                </td>
                <td className="py-2 pr-3 text-ink-2">{when(client.createdAt)}</td>
                <td className="py-2 text-right">
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    loading={revoking === client.id}
                    disabled={revoking !== null}
                    aria-label={`Revoke ${client.name}`}
                    onClick={() => void revoke(client)}
                  >
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
