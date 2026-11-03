/** Workflows: search, tag/status filters, activation toggle, create, import, duplicate, export, delete. */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, FileUp, MoreHorizontal, Plus, Search, Trash2, Workflow } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client';
import { workflowsApi } from '../api/endpoints';
import { useNodeTypes, useTags } from '../api/queries';
import type { WorkflowSummary } from '../api/types';
import { NodeIcon } from '../components/NodeIcon';
import { Button, IconButton } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { Select, Switch, TextArea } from '../components/ui/Field';
import { Menu } from '../components/ui/Menu';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Segmented } from '../components/ui/Tabs';
import { TagChip } from '../components/workflow/TagsEditor';
import { activationDetails } from '../features/editor/editor-actions';
import { downloadJson, formatRelative, safeFileName } from '../lib/format';
import { parseClipboard, withFreshWebhookIds } from '../lib/workflow-ops';
import { toast, useUiStore } from '../stores/ui-store';

export interface ImportedWorkflow {
  name: string;
  nodes: NonNullable<ReturnType<typeof parseClipboard>>['nodes'];
  connections: NonNullable<ReturnType<typeof parseClipboard>>['connections'];
  settings?: Record<string, unknown>;
  pinData?: NonNullable<ReturnType<typeof parseClipboard>>['pinData'];
  stickyNotes?: NonNullable<ReturnType<typeof parseClipboard>>['stickyNotes'];
}

/** Parse an exported workflow (or a bare clipboard selection) for import. */
export function parseWorkflowImport(
  text: string,
  fallbackName = 'Imported workflow',
): ImportedWorkflow | { error: string } {
  const payload = parseClipboard(text);
  if (!payload) return { error: 'This is not a workflow export. It needs a "nodes" list.' };
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // parseClipboard already validated the JSON
  }
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : fallbackName,
    nodes: withFreshWebhookIds(payload.nodes),
    connections: payload.connections,
    settings:
      raw.settings && typeof raw.settings === 'object'
        ? (raw.settings as Record<string, unknown>)
        : undefined,
    pinData: payload.pinData,
    stickyNotes: payload.stickyNotes,
  };
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const importMutation = useMutation({
    mutationFn: (parsed: ImportedWorkflow) => workflowsApi.create(parsed),
    onSuccess: async (dto) => {
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success('Workflow imported', dto.name);
      onClose();
      navigate(`/workflow/${encodeURIComponent(dto.id)}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = () => {
    const parsed = parseWorkflowImport(text, fileName.replace(/\.json$/i, '') || undefined);
    if ('error' in parsed) return setError(parsed.error);
    setError(null);
    importMutation.mutate(parsed);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import a workflow"
      description="Bring in a workflow exported as JSON. Credentials are not included; reconnect them after importing."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!text.trim()}
            loading={importMutation.isPending}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented
          label="Import source"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'file', label: 'From a file' },
            { value: 'paste', label: 'Paste JSON' },
          ]}
        />
        {mode === 'file' ? (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong px-4 py-8 text-center hover:border-brand">
            <FileUp size={22} className="text-ink-3" />
            <span className="text-sm font-semibold">{fileName || 'Choose a .json file'}</span>
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 20 * 1024 * 1024) return setError('The file is larger than 20 MB.');
                setFileName(file.name);
                setText(await file.text());
                setError(null);
              }}
            />
          </label>
        ) : (
          <TextArea
            aria-label="Workflow JSON"
            rows={10}
            className="font-mono text-xs"
            placeholder='{ "name": "…", "nodes": [], "connections": {} }'
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {error && <Callout tone="err">{error}</Callout>}
      </div>
    </Dialog>
  );
}

function NodeTypeStrip({ types }: { types: string[] }) {
  const nodeTypes = useNodeTypes();
  const unique = [...new Set(types)];
  const shown = unique.slice(0, 6);
  return (
    <span className="flex items-center gap-1">
      {shown.map((type) => {
        const description = nodeTypes.get(type);
        return (
          <span
            key={type}
            title={description?.displayName ?? type}
            className="grid size-7 place-items-center rounded-md bg-surface-3 text-ink-2"
            style={{ color: description?.iconColor }}
          >
            <NodeIcon description={description} fallbackName={type} size={14} />
          </span>
        );
      })}
      {unique.length > shown.length && (
        <span className="pl-0.5 text-xs text-ink-3">+{unique.length - shown.length}</span>
      )}
    </span>
  );
}

function WorkflowRow({ workflow }: { workflow: WorkflowSummary }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });
  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      active ? workflowsApi.activate(workflow.id) : workflowsApi.deactivate(workflow.id),
    onSuccess: async (dto) => {
      await refresh();
      toast.success(dto.active ? 'Workflow activated' : 'Workflow deactivated', dto.name);
    },
    onError: (error) => {
      const details = activationDetails(error);
      toast.error(
        'Could not change activation',
        details
          ? details.map((d) => (d.node ? `${d.node}: ${d.message}` : d.message)).join('\n')
          : errorMessage(error),
      );
    },
  });
  const duplicate = async () => {
    try {
      const full = await workflowsApi.get(workflow.id);
      const copy = await workflowsApi.create({
        name: `${full.name} copy`,
        nodes: withFreshWebhookIds(full.nodes),
        connections: full.connections,
        settings: full.settings,
        pinData: full.pinData,
        stickyNotes: full.stickyNotes,
        tagIds: full.tags.map((t) => t.id),
      });
      await refresh();
      toast.success('Workflow duplicated', copy.name);
    } catch (error) {
      toast.error('Could not duplicate the workflow', errorMessage(error));
    }
  };
  const exportJson = async () => {
    try {
      const full = await workflowsApi.get(workflow.id);
      downloadJson(`${safeFileName(full.name)}.json`, {
        name: full.name,
        nodes: full.nodes,
        connections: full.connections,
        settings: full.settings,
        pinData: full.pinData,
        stickyNotes: full.stickyNotes,
      });
    } catch (error) {
      toast.error('Could not export the workflow', errorMessage(error));
    }
  };
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete “${workflow.name}”?`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete workflow',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await workflowsApi.remove(workflow.id);
      await refresh();
      toast.success('Workflow deleted');
    } catch (error) {
      toast.error('Could not delete the workflow', errorMessage(error));
    }
  };
  return (
    <li className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-5 py-3.5 hover:bg-surface-2 md:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <Link
          to={`/workflow/${encodeURIComponent(workflow.id)}`}
          className="block truncate text-base font-semibold text-ink hover:text-brand"
        >
          {workflow.name}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <span>Edited {formatRelative(workflow.updatedAt)}</span>
          {workflow.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </p>
      </div>
      <span className="hidden md:block">
        <NodeTypeStrip types={workflow.nodeTypes ?? []} />
      </span>
      <span className="hidden text-xs text-ink-3 md:block">Created {formatRelative(workflow.createdAt)}</span>
      <span className="flex items-center gap-2">
        <Switch
          label={`${workflow.active ? 'Deactivate' : 'Activate'} ${workflow.name}`}
          checked={workflow.active}
          disabled={toggle.isPending}
          onChange={(v) => toggle.mutate(v)}
        />
        <Menu
          trigger={(t) => (
            <IconButton
              label={`Actions for ${workflow.name}`}
              size="sm"
              onClick={t.toggle}
              aria-expanded={t['aria-expanded']}
              aria-haspopup="menu"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          )}
          items={[
            {
              key: 'open',
              label: 'Open',
              icon: <Workflow size={14} />,
              onSelect: () => navigate(`/workflow/${encodeURIComponent(workflow.id)}`),
            },
            {
              key: 'duplicate',
              label: 'Duplicate',
              icon: <Copy size={14} />,
              onSelect: () => void duplicate(),
            },
            {
              key: 'export',
              label: 'Download as JSON',
              icon: <Download size={14} />,
              onSelect: () => void exportJson(),
            },
            'separator',
            {
              key: 'delete',
              label: 'Delete',
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => void remove(),
            },
          ]}
        />
      </span>
    </li>
  );
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const tags = useTags();
  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  // in the ui store so the command bar can open it (P3-01 "Import from file")
  const importOpen = useUiStore((s) => s.importOpen);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  useEffect(() => () => setImportOpen(false), [setImportOpen]);
  const deferredSearch = useDeferredValue(search.trim());
  const query = useInfiniteQuery({
    queryKey: ['workflows', { search: deferredSearch, tagId, status }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      workflowsApi.list({
        search: deferredSearch || undefined,
        tagId: tagId || undefined,
        active: status === 'all' ? undefined : status === 'active',
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const workflows = query.data?.pages.flatMap((p) => p.data) ?? [];
  const filtering = Boolean(deferredSearch || tagId || status !== 'all');

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="mt-1 text-sm text-ink-2">Everything that runs in this workspace.</p>
        </div>
        <Button icon={<FileUp size={15} />} onClick={() => setImportOpen(true)}>
          Import
        </Button>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/workflow/new')}>
          Create workflow
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <input
            className="wf-field pl-9"
            placeholder="Search by name"
            aria-label="Search workflows"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          aria-label="Filter by tag"
          className="w-44"
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
        >
          <option value="">All tags</option>
          {(tags.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Segmented
          label="Filter by status"
          value={status}
          onChange={setStatus}
          items={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
      </div>
      <section
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        aria-label="Workflow list"
      >
        {query.isLoading ? (
          <PageLoader />
        ) : query.error ? (
          <Callout tone="err" className="m-4" title="Could not load workflows">
            {errorMessage(query.error)}
          </Callout>
        ) : workflows.length === 0 ? (
          filtering ? (
            <EmptyState
              icon={<Search size={20} />}
              title="No workflows match"
              description="Try another name, tag or status."
            />
          ) : (
            <EmptyState
              icon={<Workflow size={20} />}
              title="Build your first workflow"
              description="Start from a trigger, add the steps that should follow, and run it right away."
              action={
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('/workflow/new')}>
                  Create workflow
                </Button>
              }
            />
          )
        ) : (
          <ul>
            {workflows.map((w) => (
              <WorkflowRow key={w.id} workflow={w} />
            ))}
          </ul>
        )}
        {query.hasNextPage && (
          <div className="p-3 text-center">
            <Button size="sm" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )}
      </section>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}
