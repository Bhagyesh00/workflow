/**
 * Data tables list (P4-05): cards with search, sort and paging by 10, create, rename, delete, import,
 * download, favorites and the workflows that use a table. Viewers read, download and star.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DATA_TABLE_NAME_MAX, type DataTableListQuery } from '@workflow/workflow';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Table2,
  Trash2,
  Upload,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { dataTablesApi, favoritesApi } from '../api/endpoints';
import { queryKeys, useFavorites } from '../api/queries';
import type { DataTableInfo, ProjectListFilter } from '../api/types';
import { CreateTableDialog } from '../components/data-tables/CreateTableDialog';
import { useDebounced } from '../components/data-tables/DataTableGrid';
import { DownloadCsvDialog } from '../components/data-tables/DownloadCsvDialog';
import { ImportCsvDialog, plural } from '../components/data-tables/ImportCsvDialog';
import { useDataTableLimits } from '../components/data-tables/StorageBanner';
import { confirmWithDependents } from '../components/dependencies/DependencyDetails';
import { DependencyPill } from '../components/dependencies/DependencyPill';
import { ProjectBadge } from '../components/projects/ProjectBadge';
import { ProjectFilter, useProjectListScope } from '../components/projects/ProjectFilter';
import { Button, IconButton } from '../components/ui/Button';
import { confirmDialog, Dialog } from '../components/ui/Dialog';
import { FormField, Select, TextInput } from '../components/ui/Field';
import { Menu, type MenuItem } from '../components/ui/Menu';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { formatRelative } from '../lib/format';
import { usePermissions } from '../lib/permissions';
import { toast } from '../stores/ui-store';

const PAGE_SIZE = 10;
const SORTS = [
  { value: 'updatedAt:desc', label: 'Last updated' },
  { value: 'createdAt:desc', label: 'Last created' },
  { value: 'name:asc', label: 'Name A-Z' },
  { value: 'name:desc', label: 'Name Z-A' },
  { value: 'size:desc', label: 'Largest' },
  { value: 'size:asc', label: 'Smallest' },
];
const SORT_KEY = 'workflow.dataTables.sort';

/** the sort chosen on an earlier visit; the first one when none is saved or the browser blocks storage */
function savedSort(): string {
  try {
    const saved = window.localStorage.getItem(SORT_KEY);
    if (saved && SORTS.some((option) => option.value === saved)) return saved;
  } catch {
    // storage is blocked: the default sort
  }
  return SORTS[0].value;
}

function saveSort(value: string): void {
  try {
    window.localStorage.setItem(SORT_KEY, value);
  } catch {
    // storage is blocked: the sort lasts until the page closes
  }
}
const MEGABYTE = 1024 * 1024;

const sizeText = (bytes: number) => `${(bytes / MEGABYTE).toFixed(bytes && bytes < MEGABYTE ? 2 : 1)} MB`;

export function useTableFavorite(tableId: string) {
  const queryClient = useQueryClient();
  const favorites = useFavorites();
  const starred = (favorites.data ?? []).some(
    (f) => f.resourceType === 'dataTable' && f.resourceId === tableId,
  );
  const mutation = useMutation({
    mutationFn: async () => {
      if (starred) await favoritesApi.remove('dataTable', tableId);
      else await favoritesApi.add('dataTable', tableId);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.favorites }),
    onError: (error) => toast.error('Could not change the favorite', errorMessage(error)),
  });
  return { starred, toggle: () => mutation.mutate() };
}

export function RenameTableDialog({ table, onClose }: { table: DataTableInfo; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(table.name);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const submit = async () => {
    if (!trimmed) return;
    if (trimmed === table.name) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await dataTablesApi.rename(table.id, trimmed);
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
      onClose();
    } catch (error) {
      toast.error('Error renaming data table', errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename data table"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-data-table"
            loading={saving}
            disabled={!trimmed}
          >
            Rename
          </Button>
        </>
      }
    >
      <form
        id="rename-data-table"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label="Name">
          {(id) => (
            <TextInput
              id={id}
              autoFocus
              autoComplete="off"
              maxLength={DATA_TABLE_NAME_MAX}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}

type TableDialog = 'rename' | 'import' | 'download';

/** the actions of a table, shared by its card and its page, and the dialogs they open */
export function useTableActions(table: DataTableInfo, onDeleted?: () => void) {
  const queryClient = useQueryClient();
  // each action by this table's own scopes (its project's role), else the workspace role's
  const { can } = usePermissions();
  const canChange = can('dataTable:update', table);
  const canDelete = can('dataTable:delete', table);
  const canClear = can('dataTable:writeRow', table);
  const { starred, toggle } = useTableFavorite(table.id);
  const [dialog, setDialog] = useState<TableDialog>();

  const remove = async () => {
    // P6-86: the workflows that use the table are listed in the warning
    const ok = await confirmWithDependents(
      {
        title: 'Delete data table',
        description: `Are you sure you want to delete the data table "${table.name}"? This action cannot be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger',
      },
      'dataTable',
      table.id,
    );
    if (!ok) return;
    try {
      await dataTablesApi.remove(table.id);
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
      await queryClient.invalidateQueries({ queryKey: queryKeys.favorites });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dependencies });
      onDeleted?.();
    } catch (error) {
      toast.error('Error deleting data table', errorMessage(error));
    }
  };

  const clear = async () => {
    const ok = await confirmDialog({
      title: 'Clear all rows',
      description: `Are you sure you want to delete every row of "${table.name}"? This action cannot be undone.`,
      confirmLabel: 'Clear rows',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await dataTablesApi.clearRows(table.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
    } catch (error) {
      toast.error('Error deleting rows', errorMessage(error));
    }
  };

  const items: Array<MenuItem | 'separator'> = [
    {
      key: 'favorite',
      label: starred ? 'Remove from favorites' : 'Add to favorites',
      icon: <Star size={14} />,
      onSelect: toggle,
    },
    {
      key: 'download',
      label: 'Download CSV',
      icon: <Download size={14} />,
      onSelect: () => setDialog('download'),
    },
    ...(canChange
      ? ([
          {
            key: 'import',
            label: 'Import CSV',
            icon: <Upload size={14} />,
            onSelect: () => setDialog('import'),
          },
          {
            key: 'rename',
            label: 'Rename',
            icon: <Pencil size={14} />,
            onSelect: () => setDialog('rename'),
          },
        ] satisfies MenuItem[])
      : []),
    ...(canClear || canDelete ? (['separator'] as const) : []),
    ...(canClear
      ? ([
          {
            key: 'clear',
            label: 'Clear all rows',
            icon: <Eraser size={14} />,
            danger: true,
            onSelect: () => void clear(),
          },
        ] satisfies MenuItem[])
      : []),
    ...(canDelete
      ? ([
          {
            key: 'delete',
            label: 'Delete',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => void remove(),
          },
        ] satisfies MenuItem[])
      : []),
  ];

  const close = () => setDialog(undefined);
  const dialogs = (
    <>
      {dialog === 'rename' && <RenameTableDialog table={table} onClose={close} />}
      {dialog === 'import' && <ImportCsvDialog table={table} onClose={close} />}
      {dialog === 'download' && <DownloadCsvDialog tableId={table.id} onClose={close} />}
    </>
  );
  return { items, dialogs, starred, toggleFavorite: toggle };
}

function TableCard({
  table,
  sizeBytes,
  showProject,
}: {
  table: DataTableInfo;
  sizeBytes: number | undefined;
  showProject: boolean;
}) {
  const { items, dialogs, starred, toggleFavorite } = useTableActions(table);
  return (
    <li className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <Table2 size={16} aria-hidden="true" className="shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/data-tables/${encodeURIComponent(table.id)}`}
          className="block truncate font-semibold text-ink hover:text-brand"
        >
          {table.name}
        </Link>
        <p className="truncate text-xs text-ink-2">
          {plural(table.columns.length, 'column')}
          {sizeBytes !== undefined && ` · ${sizeText(sizeBytes)}`}
          {` · Updated ${formatRelative(table.updatedAt)}`}
        </p>
      </div>
      {showProject && (
        <ProjectBadge
          homeProject={table.homeProject}
          sharedWithProjects={table.sharedWithProjects}
          resourceType="dataTable"
        />
      )}
      <DependencyPill kind="dataTable" id={table.id} />
      <IconButton
        size="sm"
        label={starred ? `Remove ${table.name} from favorites` : `Add ${table.name} to favorites`}
        active={starred}
        onClick={toggleFavorite}
      >
        <Star size={14} fill={starred ? 'currentColor' : 'none'} />
      </IconButton>
      <Menu
        items={items}
        trigger={(t) => (
          <IconButton
            size="sm"
            label={`Actions for ${table.name}`}
            onClick={t.toggle}
            aria-expanded={t['aria-expanded']}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={15} />
          </IconButton>
        )}
      />
      {dialogs}
    </li>
  );
}

export function DataTablesPage() {
  const scope = useProjectListScope('data-tables');
  // the Create button and the empty state's call to action: `dataTable:create` in the page's project
  const canWrite = scope.canCreate('dataTable:create');
  const [params, setParams] = useSearchParams();
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [sort, setSort] = useState(savedSort);
  const [skip, setSkip] = useState(0);
  const [creating, setCreating] = useState(false);
  const limits = useDataTableLimits();

  const [column, direction] = sort.split(':') as [
    NonNullable<DataTableListQuery['sortBy']>['column'],
    NonNullable<DataTableListQuery['sortBy']>['direction'],
  ];
  const query: DataTableListQuery & ProjectListFilter = {
    skip,
    take: PAGE_SIZE,
    name: search || undefined,
    sortBy: { column, direction },
    ...scope.listFilter,
  };
  const list = useQuery({
    queryKey: queryKeys.dataTables(query),
    queryFn: () => dataTablesApi.list(query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const tables = list.data?.data ?? [];
  const count = list.data?.count ?? 0;

  // a create link (the node's locator) opens the dialog
  const linkedCreate = canWrite && params.get('new') === '1';
  const closeCreate = () => {
    setCreating(false);
    if (params.has('new')) setParams({}, { replace: true });
  };

  // the last table of the last page went
  if (!list.isPlaceholderData && list.data && skip > 0 && skip >= count) {
    setSkip(Math.max(Math.floor((count - 1) / PAGE_SIZE), 0) * PAGE_SIZE);
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Data tables</h1>
          <p className="mt-1 text-sm text-ink-2">
            Tables your workflows read and write, shared by everyone in this workspace.
          </p>
        </div>
        {canWrite && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
            New data table
          </Button>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <input
            className="wf-field pl-9"
            placeholder="Search data tables"
            aria-label="Search data tables"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              setSkip(0);
            }}
          />
        </div>
        {scope.kind === 'home' && (
          <ProjectFilter
            value={scope.filterValue}
            onChange={(next) => {
              scope.setFilterValue(next);
              setSkip(0);
            }}
          />
        )}
        <Select
          aria-label="Sort data tables"
          className="w-44"
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
            saveSort(event.target.value);
            setSkip(0);
          }}
        >
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      {list.isLoading ? (
        <PageLoader />
      ) : list.error ? (
        <Callout tone="err" title="Could not load the data tables">
          {errorMessage(list.error)}
        </Callout>
      ) : !tables.length ? (
        search ? (
          <EmptyState title="No data tables match your search" />
        ) : canWrite ? (
          <EmptyState
            icon={<Table2 size={20} />}
            title="Create your first data table"
            description="Keep rows between runs, and share them between workflows."
            action={
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setCreating(true)}>
                Create a data table
              </Button>
            }
          />
        ) : (
          <EmptyState icon={<Table2 size={20} />} title="No data tables yet" />
        )
      ) : (
        <>
          <ul aria-label="Data table list" className="flex flex-col gap-2">
            {tables.map((table) => (
              <TableCard
                key={table.id}
                table={table}
                sizeBytes={limits.data?.dataTables[table.id]?.sizeBytes}
                showProject={scope.kind !== 'project'}
              />
            ))}
          </ul>
          <div className="flex items-center justify-end gap-3">
            <span className="text-xs text-ink-2">
              {skip + 1}-{Math.min(skip + PAGE_SIZE, count)} of {count}
            </span>
            <IconButton
              size="sm"
              label="Previous page"
              disabled={skip === 0}
              onClick={() => setSkip(Math.max(skip - PAGE_SIZE, 0))}
            >
              <ChevronLeft size={15} />
            </IconButton>
            <IconButton
              size="sm"
              label="Next page"
              disabled={skip + PAGE_SIZE >= count}
              onClick={() => setSkip(skip + PAGE_SIZE)}
            >
              <ChevronRight size={15} />
            </IconButton>
          </div>
        </>
      )}

      {(creating || linkedCreate) && (
        <CreateTableDialog initialName={params.get('name') ?? ''} onClose={closeCreate} />
      )}
    </div>
  );
}
