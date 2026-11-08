/**
 * P5-04, P5-15: which workflows the workspace MCP server may list, read and run. Editors and above see the
 * table; admins switch rows and use the bulk buttons (the server checks the role). Everyone else changes
 * one workflow in its own settings ("Available in MCP").
 */
import type { McpWorkflowSummary } from '../../api/types';
import { Button } from '../ui/Button';
import { confirmDialog } from '../ui/Dialog';
import { Switch, TextInput } from '../ui/Field';
import { Badge, Callout, EmptyState, PageLoader } from '../ui/misc';

export function McpWorkflowsTable({
  workflows,
  loading,
  error,
  search,
  onSearch,
  canToggle,
  mcpOn,
  busy,
  onToggle,
  onBulk,
}: {
  workflows: McpWorkflowSummary[] | undefined;
  loading: boolean;
  error: string | null;
  search: string;
  onSearch: (value: string) => void;
  canToggle: boolean;
  /** the workspace switch: while it is off, a flag does nothing yet */
  mcpOn: boolean;
  /** a change is on its way */
  busy: boolean;
  onToggle: (workflow: McpWorkflowSummary, value: boolean) => void;
  onBulk: (value: boolean) => void;
}) {
  const bulk = async (value: boolean) => {
    const ok = await confirmDialog({
      title: value ? 'Make every workflow available?' : 'Hide every workflow from MCP?',
      description: value
        ? 'MCP clients can find, read and run all workflows in this workspace.'
        : 'MCP clients can no longer find or run any workflow.',
      confirmLabel: value ? 'Make all available' : 'Hide all',
      tone: value ? 'primary' : 'danger',
    });
    if (ok) onBulk(value);
  };
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4" aria-labelledby="mcp-workflows">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="mcp-workflows" className="text-md font-semibold">
            Workflows
          </h3>
          <p className="mt-1 text-sm text-ink-2">The workflows MCP clients can find, read and run.</p>
        </div>
        {canToggle && (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void bulk(true)}>
              Make all available
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void bulk(false)}>
              Hide all
            </Button>
          </div>
        )}
      </div>
      {!mcpOn && <Callout tone="warn">MCP access is off, so no client can reach these yet.</Callout>}
      <TextInput
        aria-label="Search workflows"
        placeholder="Search workflows"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {loading ? (
        <PageLoader label="Loading workflows" />
      ) : error ? (
        <Callout tone="err" title="Couldn't load the workflows">
          {error}
        </Callout>
      ) : !workflows || workflows.length === 0 ? (
        <EmptyState
          title={search ? 'No workflow matches' : 'No workflows yet'}
          description={search ? 'Try another name.' : 'Workflows you can edit show up here.'}
        />
      ) : (
        <ul className="divide-y divide-line">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{workflow.name}</p>
                <p className="text-xs text-ink-3">{workflow.active ? 'Published' : 'Not published'}</p>
              </div>
              {canToggle ? (
                <Switch
                  size="sm"
                  label={`Available in MCP: ${workflow.name}`}
                  checked={workflow.availableInMCP}
                  disabled={busy}
                  onChange={(value) => onToggle(workflow, value)}
                />
              ) : (
                <Badge tone={workflow.availableInMCP ? 'ok' : 'neutral'}>
                  {workflow.availableInMCP ? 'Available' : 'Not available'}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
