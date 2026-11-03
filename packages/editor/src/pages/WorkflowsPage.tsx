/**
 * Workflows: folders (?folder=<id>), search, tag/status filters, activation toggle, create, import,
 * duplicate, export, move, favorites, archive and restore.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  Copy,
  Download,
  FileUp,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { favoritesApi, workflowsApi } from '../api/endpoints';
import { queryKeys, useFavorites, useFolder, useFolders, useMe, useNodeTypes, useTags } from '../api/queries';
import type { Folder, WorkflowSummary } from '../api/types';
import { NodeIcon } from '../components/NodeIcon';
import { Button, IconButton } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Checkbox, Select, Switch, TextArea } from '../components/ui/Field';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { Badge, Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { Segmented } from '../components/ui/Tabs';
import { DeleteFolderDialog, FolderDialog } from '../components/workflow/FolderDialog';
import { type MoveTarget, MoveToFolderDialog } from '../components/workflow/MoveToFolderDialog';
import { TagChip } from '../components/workflow/TagsEditor';
import { activationDetails } from '../features/editor/editor-actions';
import {
  archiveWorkflow,
  deleteArchivedWorkflow,
  unarchiveWorkflow,
} from '../features/workflows/archive-actions';
import {
  type DragItem,
  type DropTarget,
  dragProps,
  dropItem,
  useDropTarget,
} from '../features/workflows/folder-dnd';
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

function useFavoriteToggle(type: 'workflow' | 'folder', id: string) {
  const queryClient = useQueryClient();
  const favorites = useFavorites();
  const starred = (favorites.data ?? []).some((f) => f.resourceType === type && f.resourceId === id);
  const toggle = useMutation({
    mutationFn: async () => {
      if (starred) await favoritesApi.remove(type, id);
      else await favoritesApi.add(type, id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.favorites }),
    onError: (error) => toast.error('Could not change the favorite', errorMessage(error)),
  });
  return { starred, toggle: () => toggle.mutate() };
}

type MenuEntry = MenuItem | 'separator';

function FolderRow({
  folder,
  path,
  canWrite,
  onOpen,
  onRename,
  onMove,
  onDelete,
  onDropped,
}: {
  folder: Folder;
  /** ids from the top level down to this folder */
  path: string[];
  canWrite: boolean;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onDropped: (item: DragItem, target: DropTarget, name: string) => void;
}) {
  const { starred, toggle } = useFavoriteToggle('folder', folder.id);
  const target: DropTarget = { folderId: folder.id, path };
  const drop = useDropTarget(target, (item) => onDropped(item, target, folder.name), canWrite);
  const item: DragItem = {
    type: 'folder',
    id: folder.id,
    name: folder.name,
    parentFolderId: folder.parentFolderId,
  };
  const items: MenuEntry[] = [
    { key: 'open', label: 'Open', icon: <FolderIcon size={14} />, onSelect: onOpen },
    {
      key: 'favorite',
      label: starred ? 'Remove from favorites' : 'Add to favorites',
      icon: <Star size={14} />,
      onSelect: toggle,
    },
    ...(canWrite
      ? ([
          'separator',
          { key: 'rename', label: 'Rename', icon: <Pencil size={14} />, onSelect: onRename },
          { key: 'move', label: 'Move to folder', icon: <FolderInput size={14} />, onSelect: onMove },
          'separator',
          { key: 'delete', label: 'Delete', icon: <Trash2 size={14} />, danger: true, onSelect: onDelete },
        ] as MenuEntry[])
      : []),
  ];
  return (
    <li
      data-testid={`folder-row-${folder.name}`}
      data-drop-over={drop.over || undefined}
      className={`group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-5 py-3 hover:bg-surface-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] ${
        drop.over ? 'bg-brand-soft outline outline-2 -outline-offset-2 outline-brand' : ''
      }`}
      {...dragProps(item, canWrite)}
      {...drop.props}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {canWrite && (
          <GripVertical
            size={14}
            className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100"
            aria-hidden="true"
          />
        )}
        <FolderIcon size={18} className="shrink-0 text-ink-3" aria-hidden="true" />
        <Link
          to={`/workflows?folder=${encodeURIComponent(folder.id)}`}
          className="block truncate text-base font-semibold text-ink hover:text-brand"
        >
          {folder.name}
        </Link>
        {folder.tags.map((t) => (
          <TagChip key={t.id} tag={t} />
        ))}
      </div>
      <span className="hidden text-xs text-ink-3 md:block">Edited {formatRelative(folder.updatedAt)}</span>
      <span className="flex items-center gap-2">
        <IconButton
          label={starred ? `Remove ${folder.name} from favorites` : `Add ${folder.name} to favorites`}
          size="sm"
          onClick={toggle}
          aria-pressed={starred}
        >
          <Star size={15} className={starred ? 'fill-current text-warn' : ''} />
        </IconButton>
        <Menu
          trigger={(t) => (
            <IconButton
              label={`Actions for folder ${folder.name}`}
              size="sm"
              onClick={t.toggle}
              aria-expanded={t['aria-expanded']}
              aria-haspopup="menu"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          )}
          items={items}
        />
      </span>
    </li>
  );
}

function WorkflowRow({
  workflow,
  canWrite,
  onMove,
}: {
  workflow: WorkflowSummary;
  canWrite: boolean;
  onMove: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workflows'] });
  const { starred, toggle: toggleFavorite } = useFavoriteToggle('workflow', workflow.id);
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
        folderId: full.folderId,
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
  const actionDeps = { navigate, queryClient };
  const item: DragItem = {
    type: 'workflow',
    id: workflow.id,
    name: workflow.name,
    folderId: workflow.folderId,
  };
  const writeItems: MenuEntry[] = workflow.isArchived
    ? [
        {
          key: 'restore',
          label: 'Restore',
          icon: <ArchiveRestore size={14} />,
          onSelect: () => void unarchiveWorkflow(workflow.id, actionDeps),
        },
        {
          key: 'delete',
          label: 'Delete',
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => void deleteArchivedWorkflow(workflow.id, actionDeps),
        },
      ]
    : [
        {
          key: 'archive',
          label: 'Archive',
          icon: <Archive size={14} />,
          onSelect: () => void archiveWorkflow(workflow.id, actionDeps),
        },
      ];
  const items: MenuEntry[] = [
    {
      key: 'open',
      label: 'Open',
      icon: <Workflow size={14} />,
      onSelect: () => navigate(`/workflow/${encodeURIComponent(workflow.id)}`),
    },
    {
      key: 'favorite',
      label: starred ? 'Remove from favorites' : 'Add to favorites',
      icon: <Star size={14} />,
      onSelect: toggleFavorite,
    },
    ...(canWrite && !workflow.isArchived
      ? ([
          { key: 'move', label: 'Move to folder', icon: <FolderInput size={14} />, onSelect: onMove },
          {
            key: 'duplicate',
            label: 'Duplicate',
            icon: <Copy size={14} />,
            onSelect: () => void duplicate(),
          },
        ] as MenuEntry[])
      : []),
    {
      key: 'export',
      label: 'Download as JSON',
      icon: <Download size={14} />,
      onSelect: () => void exportJson(),
    },
    ...(canWrite ? (['separator', ...writeItems] as MenuEntry[]) : []),
  ];
  return (
    <li
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line px-5 py-3.5 hover:bg-surface-2 md:grid-cols-[minmax(0,2fr)_auto_minmax(0,1fr)_auto]"
      {...dragProps(item, canWrite)}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {canWrite && (
            <GripVertical
              size={14}
              className="shrink-0 text-ink-3 opacity-0 group-hover:opacity-100"
              aria-hidden="true"
            />
          )}
          <Link
            to={`/workflow/${encodeURIComponent(workflow.id)}`}
            className="block truncate text-base font-semibold text-ink hover:text-brand"
          >
            {workflow.name}
          </Link>
          {workflow.isArchived && <Badge tone="warn">Archived</Badge>}
        </div>
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
        <IconButton
          label={starred ? `Remove ${workflow.name} from favorites` : `Add ${workflow.name} to favorites`}
          size="sm"
          onClick={toggleFavorite}
          aria-pressed={starred}
        >
          <Star size={15} className={starred ? 'fill-current text-warn' : ''} />
        </IconButton>
        <Switch
          label={`${workflow.active ? 'Deactivate' : 'Activate'} ${workflow.name}`}
          checked={workflow.active}
          disabled={toggle.isPending || workflow.isArchived || !canWrite}
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
          items={items}
        />
      </span>
    </li>
  );
}

function Crumb({
  label,
  to,
  target,
  canWrite,
  onDropped,
}: {
  label: string;
  to?: string;
  target: DropTarget;
  canWrite: boolean;
  onDropped: (item: DragItem, target: DropTarget) => void;
}) {
  const drop = useDropTarget(target, (item) => onDropped(item, target), canWrite);
  const cls = `rounded-md px-1.5 py-0.5 ${drop.over ? 'bg-brand-soft text-brand outline outline-2 outline-brand' : ''}`;
  return to ? (
    <Link to={to} className={`${cls} text-ink-2 hover:bg-surface-3 hover:text-ink`} {...drop.props}>
      {label}
    </Link>
  ) : (
    <span className={`${cls} font-semibold text-ink`} aria-current="location" {...drop.props}>
      {label}
    </span>
  );
}

/** "Workflows / A / B": every item is a link and a drop target */
function Breadcrumb({
  path,
  current,
  canWrite,
  onDropped,
}: {
  path: Array<{ id: string; name: string }>;
  current: { id: string; name: string };
  canWrite: boolean;
  onDropped: (item: DragItem, target: DropTarget, name: string) => void;
}) {
  const crumbs = [...path, current];
  return (
    <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
      <Crumb
        label="Workflows"
        to="/workflows"
        target={{ folderId: null, path: [] }}
        canWrite={canWrite}
        onDropped={(item, target) => onDropped(item, target, 'the top level')}
      />
      {crumbs.map((c, i) => (
        <span key={c.id} className="inline-flex items-center gap-1">
          <ChevronRight size={13} className="text-ink-3" aria-hidden="true" />
          <Crumb
            label={c.name}
            to={i === crumbs.length - 1 ? undefined : `/workflows?folder=${encodeURIComponent(c.id)}`}
            target={{ folderId: c.id, path: crumbs.slice(0, i + 1).map((x) => x.id) }}
            canWrite={canWrite}
            onDropped={(item, target) => onDropped(item, target, c.name)}
          />
        </span>
      ))}
    </nav>
  );
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tags = useTags();
  const [params] = useSearchParams();
  const folderId = params.get('folder') ?? undefined;
  const canWrite = useMe().data?.role !== 'viewer';
  const [search, setSearch] = useState('');
  const [tagId, setTagId] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [folderDialog, setFolderDialog] = useState<
    { mode: 'create' } | { mode: 'rename'; folder: Folder } | null
  >(null);
  const [deleting, setDeleting] = useState<Folder | null>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);
  // in the ui store so the command bar can open it (P3-01 "Import from file")
  const importOpen = useUiStore((s) => s.importOpen);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  useEffect(() => () => setImportOpen(false), [setImportOpen]);
  const deferredSearch = useDeferredValue(search.trim());
  const filtering = Boolean(deferredSearch || tagId || status !== 'all');
  const folder = useFolder(folderId);
  // a search looks through every folder; browsing lists one folder
  const scope = filtering ? undefined : (folderId ?? 'root');
  const folders = useFolders(scope, !filtering);
  const query = useInfiniteQuery({
    queryKey: ['workflows', { search: deferredSearch, tagId, status, scope, showArchived }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      workflowsApi.list({
        search: deferredSearch || undefined,
        tagId: tagId || undefined,
        active: status === 'all' ? undefined : status === 'active',
        folderId: scope,
        archived: showArchived ? 'all' : undefined,
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const workflows = query.data?.pages.flatMap((p) => p.data) ?? [];
  const folderRows = filtering ? [] : (folders.data?.data ?? []);
  const here = [...(folder.data?.path ?? []).map((p) => p.id), ...(folderId ? [folderId] : [])];
  const missingFolder = Boolean(folderId && folder.error);

  const onDropped = (item: DragItem, target: DropTarget, targetName: string) => {
    void dropItem(item, target, { queryClient, targetName });
  };
  const createHere = async () => {
    if (!folderId) return navigate('/workflow/new');
    try {
      const dto = await workflowsApi.create({ name: 'My workflow', nodes: [], connections: {}, folderId });
      await queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/workflow/${encodeURIComponent(dto.id)}`);
    } catch (error) {
      toast.error('Could not create the workflow', errorMessage(error));
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{folder.data ? folder.data.name : 'Workflows'}</h1>
          {folder.data ? (
            <div className="mt-1">
              <Breadcrumb
                path={folder.data.path}
                current={{ id: folder.data.id, name: folder.data.name }}
                canWrite={canWrite}
                onDropped={onDropped}
              />
            </div>
          ) : (
            <p className="mt-1 text-sm text-ink-2">Everything that runs in this workspace.</p>
          )}
        </div>
        {canWrite && (
          <Button icon={<FolderPlus size={15} />} onClick={() => setFolderDialog({ mode: 'create' })}>
            New folder
          </Button>
        )}
        <Button icon={<FileUp size={15} />} onClick={() => setImportOpen(true)}>
          Import
        </Button>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => void createHere()}>
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
        <Checkbox
          label="Show archived workflows"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
      </div>
      <section
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        aria-label="Workflow list"
      >
        {query.isLoading || (!filtering && folders.isLoading) ? (
          <PageLoader />
        ) : missingFolder ? (
          <EmptyState
            icon={<FolderIcon size={20} />}
            title="This folder does not exist"
            description="It may have been deleted."
            action={<Button onClick={() => navigate('/workflows')}>Back to workflows</Button>}
          />
        ) : query.error ? (
          <Callout tone="err" className="m-4" title="Could not load workflows">
            {errorMessage(query.error)}
          </Callout>
        ) : workflows.length === 0 && folderRows.length === 0 ? (
          filtering ? (
            <EmptyState
              icon={<Search size={20} />}
              title="No workflows match"
              description="Try another name, tag or status."
            />
          ) : folderId ? (
            <EmptyState
              icon={<FolderIcon size={20} />}
              title="This folder is empty"
              description="Create a workflow here, or drag workflows and folders onto it."
              action={
                <Button variant="primary" icon={<Plus size={15} />} onClick={() => void createHere()}>
                  Create workflow
                </Button>
              }
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
            {folderRows.map((f) => (
              <FolderRow
                key={f.id}
                folder={f}
                path={[...here, f.id]}
                canWrite={canWrite}
                onOpen={() => navigate(`/workflows?folder=${encodeURIComponent(f.id)}`)}
                onRename={() => setFolderDialog({ mode: 'rename', folder: f })}
                onMove={() =>
                  setMoving({ kind: 'folder', id: f.id, name: f.name, parentFolderId: f.parentFolderId })
                }
                onDelete={() => setDeleting(f)}
                onDropped={onDropped}
              />
            ))}
            {workflows.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                canWrite={canWrite}
                onMove={() =>
                  setMoving({ kind: 'workflow', ids: [w.id], name: w.name, folderId: w.folderId })
                }
              />
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
      {folderDialog?.mode === 'create' && (
        <FolderDialog
          mode="create"
          open
          onClose={() => setFolderDialog(null)}
          parentFolderId={folderId ?? null}
        />
      )}
      {folderDialog?.mode === 'rename' && (
        <FolderDialog mode="rename" open onClose={() => setFolderDialog(null)} folder={folderDialog.folder} />
      )}
      {deleting && <DeleteFolderDialog open folder={deleting} onClose={() => setDeleting(null)} />}
      <MoveToFolderDialog open={Boolean(moving)} target={moving} onClose={() => setMoving(null)} />
    </div>
  );
}
