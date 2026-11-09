/**
 * P5-72 (L9): the MCP servers the Assistant can use (outside servers, not this app's own MCP server): list,
 * add, edit, delete (admin). A connection holds a credential id, never a secret. Below admin the list is
 * read-only. The server checks the address, the credential and the role again.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { assistantApi } from '../../api/endpoints';
import { queryKeys, useCredentials, useMe } from '../../api/queries';
import type {
  AssistantMcpAuthentication,
  AssistantMcpConnectionBody,
  AssistantMcpConnectionDTO,
  AssistantMcpTransport,
} from '../../api/types';
import { canWith } from '../../lib/permissions';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { confirmDialog, Dialog } from '../ui/Dialog';
import { FormField, Select, Switch, TextInput } from '../ui/Field';
import { Badge, Callout, EmptyState, PageLoader } from '../ui/misc';

/** the sign-in methods of the MCP Client node and the credential type each one takes */
const AUTH_OPTIONS: Array<{
  value: AssistantMcpAuthentication;
  label: string;
  credentialType: string | null;
}> = [
  { value: 'none', label: 'None', credentialType: null },
  { value: 'bearerAuth', label: 'Bearer token', credentialType: 'httpBearerAuth' },
  { value: 'headerAuth', label: 'Header', credentialType: 'httpHeaderAuth' },
  { value: 'multipleHeadersAuth', label: 'Several headers', credentialType: 'httpMultipleHeadersAuth' },
  { value: 'mcpOAuth2Api', label: 'MCP OAuth2', credentialType: 'mcpOAuth2Api' },
];

const authLabel = (value: AssistantMcpAuthentication) =>
  AUTH_OPTIONS.find((o) => o.value === value)?.label ?? value;

/** per-tool settings can only tighten the workspace's MCP permissions */
type ToolMode = 'require_approval' | 'blocked';
interface ToolRow {
  key: number;
  name: string;
  mode: ToolMode;
}

interface Draft {
  name: string;
  url: string;
  transport: AssistantMcpTransport;
  authentication: AssistantMcpAuthentication;
  credentialId: string;
  enabled: boolean;
  tools: ToolRow[];
}

let rowKey = 0;

function draftOf(connection?: AssistantMcpConnectionDTO): Draft {
  return {
    name: connection?.name ?? '',
    url: connection?.url ?? '',
    transport: connection?.transport ?? 'httpStreamable',
    authentication: connection?.authentication ?? 'none',
    credentialId: connection?.credentialId ?? '',
    enabled: connection?.enabled ?? true,
    tools: Object.entries(connection?.toolPermissions ?? {}).map(([name, mode]) => ({
      key: rowKey++,
      name,
      mode: mode === 'blocked' ? 'blocked' : 'require_approval',
    })),
  };
}

/** a quick check before the request; the server decides */
function addressProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'Enter the address of the server, for example https://mcp.example.com/mcp';
  }
  if (url.protocol === 'https:') return null;
  const host = url.hostname;
  if (
    url.protocol === 'http:' &&
    (host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host))
  ) {
    return null;
  }
  return 'Use an https address (http is only allowed for localhost)';
}

function ConnectionDialog({
  connection,
  onClose,
}: {
  /** undefined: a new connection */
  connection: AssistantMcpConnectionDTO | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(connection));
  const [touched, setTouched] = useState(false);
  const credentials = useCredentials();
  const credentialType = AUTH_OPTIONS.find((o) => o.value === draft.authentication)?.credentialType ?? null;
  const choices = (credentials.data ?? []).filter((c) => c.type === credentialType);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: (body: AssistantMcpConnectionBody) =>
      connection
        ? assistantApi.patchMcpConnection(connection.id, body)
        : assistantApi.createMcpConnection(body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.assistantMcpConnections });
      toast.success(connection ? 'MCP server saved' : 'MCP server added');
      onClose();
    },
    onError: (error) => toast.error("Couldn't save the MCP server", errorMessage(error)),
  });

  const nameProblem = draft.name.trim() ? null : 'Give the server a name';
  const urlProblem = addressProblem(draft.url);
  const credentialProblem =
    credentialType && !draft.credentialId ? 'Choose the credential this server signs in with' : null;
  const problem = nameProblem ?? urlProblem ?? credentialProblem;

  const submit = () => {
    setTouched(true);
    if (problem) return;
    const toolPermissions: Record<string, ToolMode> = {};
    for (const row of draft.tools) {
      const name = row.name.trim();
      if (name) toolPermissions[name] = row.mode;
    }
    save.mutate({
      name: draft.name.trim(),
      url: draft.url.trim(),
      transport: draft.transport,
      authentication: draft.authentication,
      credentialId: credentialType ? draft.credentialId : null,
      enabled: draft.enabled,
      toolPermissions,
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={connection ? `Edit ${connection.name}` : 'Add an MCP server'}
      description="The Assistant can use the tools of this server. Its tools ask for approval unless you allow them in the permissions below."
      dismissible={!save.isPending}
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={save.isPending}>
            {connection ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <FormField label="Name" required error={touched ? nameProblem : null}>
          {(id) => (
            <TextInput
              id={id}
              value={draft.name}
              maxLength={64}
              data-autofocus
              onChange={(e) => set('name', e.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="Address"
          required
          error={touched ? urlProblem : null}
          hint="The server's MCP address. Only https works, apart from localhost."
        >
          {(id) => (
            <TextInput
              id={id}
              value={draft.url}
              placeholder="https://mcp.example.com/mcp"
              onChange={(e) => set('url', e.target.value)}
            />
          )}
        </FormField>
        <FormField label="Transport">
          {(id) => (
            <Select
              id={id}
              value={draft.transport}
              onChange={(e) => set('transport', e.target.value as AssistantMcpTransport)}
            >
              <option value="httpStreamable">HTTP Streamable</option>
              <option value="sse">Server Sent Events (deprecated)</option>
            </Select>
          )}
        </FormField>
        <FormField label="Sign in with">
          {(id) => (
            <Select
              id={id}
              value={draft.authentication}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  authentication: e.target.value as AssistantMcpAuthentication,
                  credentialId: '',
                }))
              }
            >
              {AUTH_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {credentialType && (
          <FormField
            label="Credential"
            required
            error={touched ? credentialProblem : null}
            hint={
              choices.length || credentials.isLoading
                ? 'The server never sees this credential outside its own address.'
                : `No ${credentialType} credential yet. Create one on the Credentials page.`
            }
          >
            {(id) => (
              <Select
                id={id}
                value={draft.credentialId}
                onChange={(e) => set('credentialId', e.target.value)}
              >
                <option value="">Choose a credential</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-ink">Use this server</span>
          <Switch label="Use this server" checked={draft.enabled} onChange={(v) => set('enabled', v)} />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-semibold text-ink">Tool settings</legend>
          <p className="text-xs text-ink-2">
            Ask first for a tool, or turn it off. A tool here can only be made stricter than the permissions
            below.
          </p>
          {draft.tools.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <TextInput
                aria-label="Tool name"
                value={row.name}
                placeholder="tool_name"
                onChange={(e) =>
                  set(
                    'tools',
                    draft.tools.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)),
                  )
                }
              />
              <Select
                aria-label="Tool mode"
                className="w-44 shrink-0"
                value={row.mode}
                onChange={(e) =>
                  set(
                    'tools',
                    draft.tools.map((r) =>
                      r.key === row.key ? { ...r, mode: e.target.value as ToolMode } : r,
                    ),
                  )
                }
              >
                <option value="require_approval">Ask me first</option>
                <option value="blocked">Blocked</option>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remove tool setting"
                icon={<Trash2 size={14} />}
                onClick={() =>
                  set(
                    'tools',
                    draft.tools.filter((r) => r.key !== row.key),
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              icon={<Plus size={14} />}
              onClick={() =>
                set('tools', [...draft.tools, { key: rowKey++, name: '', mode: 'require_approval' }])
              }
            >
              Add a tool setting
            </Button>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

export function AssistantMcpConnections() {
  const queryClient = useQueryClient();
  const me = useMe();
  const isAdmin = canWith(me.data, 'instanceAi:manage');
  const [editing, setEditing] = useState<AssistantMcpConnectionDTO | 'new' | null>(null);
  const list = useQuery({
    queryKey: queryKeys.assistantMcpConnections,
    queryFn: assistantApi.mcpConnections,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.assistantMcpConnections });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      assistantApi.patchMcpConnection(id, { enabled }),
    onSuccess: refresh,
    onError: (error) => toast.error("Couldn't change the MCP server", errorMessage(error)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => assistantApi.deleteMcpConnection(id),
    onSuccess: async () => {
      await refresh();
      toast.success('MCP server deleted');
    },
    onError: (error) => toast.error("Couldn't delete the MCP server", errorMessage(error)),
  });

  const askDelete = async (connection: AssistantMcpConnectionDTO) => {
    const ok = await confirmDialog({
      title: `Delete ${connection.name}?`,
      description: 'The Assistant stops using its tools. The credential stays.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(connection.id);
  };

  const connections = list.data ?? [];

  return (
    <section className="mt-3 flex flex-col gap-3" aria-label="MCP servers the Assistant can use">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink">MCP servers the Assistant can use</h3>
          <p className="text-xs text-ink-2">
            Outside servers you list here. This is not this app's own MCP server.
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            Add server
          </Button>
        )}
      </div>

      {!isAdmin && me.data && <Callout>Only an admin can change these servers.</Callout>}

      {list.isLoading ? (
        <PageLoader label="Loading MCP servers" />
      ) : list.isError ? (
        <Callout tone="err" title="Couldn't load the MCP servers">
          {errorMessage(list.error)}
        </Callout>
      ) : connections.length === 0 ? (
        <EmptyState
          title="No MCP servers yet"
          description="Add a server and the Assistant can use its tools, after you approve each use."
        />
      ) : (
        <ul
          aria-label="Configured MCP servers"
          className="flex flex-col divide-y divide-line rounded-lg border border-line"
        >
          {connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-ink">{connection.name}</p>
                <p className="truncate text-xs text-ink-2">{connection.url}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge>{connection.transport === 'sse' ? 'SSE' : 'HTTP Streamable'}</Badge>
                  <Badge>{authLabel(connection.authentication)}</Badge>
                  {Object.keys(connection.toolPermissions).length > 0 && (
                    <Badge tone="warn">{Object.keys(connection.toolPermissions).length} tool settings</Badge>
                  )}
                </div>
              </div>
              <Switch
                size="sm"
                label={`Use ${connection.name}`}
                checked={connection.enabled}
                disabled={!isAdmin || toggle.isPending}
                onChange={(enabled) => toggle.mutate({ id: connection.id, enabled })}
              />
              {isAdmin && (
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Edit ${connection.name}`}
                    icon={<Pencil size={14} />}
                    onClick={() => setEditing(connection)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${connection.name}`}
                    icon={<Trash2 size={14} />}
                    onClick={() => askDelete(connection)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ConnectionDialog
          key={editing === 'new' ? 'new' : editing.id}
          connection={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
