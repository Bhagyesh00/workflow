/** One data table: breadcrumbs, its actions and the grid (P4-05). */
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal, Star, Table2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, errorMessage } from '../api/client';
import { dataTablesApi } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import type { DataTableInfo } from '../api/types';
import { DataTableGrid } from '../components/data-tables/DataTableGrid';
import { DependencyPill } from '../components/dependencies/DependencyPill';
import { IconButton } from '../components/ui/Button';
import { Menu } from '../components/ui/Menu';
import { Callout, EmptyState, PageLoader } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';
import { useProtectedWorkspace } from '../lib/protected';
import { useTableActions } from './DataTablesPage';

function TablePage({ table }: { table: DataTableInfo }) {
  const navigate = useNavigate();
  const { can } = usePermissions();
  const protectedWorkspace = useProtectedWorkspace();
  // the grid edits rows by this table's own `dataTable:writeRow`, and columns by `dataTable:writeColumn` on a
  // workspace that is not protected (the server refuses a column change there; rows stay editable)
  const canWrite = can('dataTable:writeRow', table);
  const canChangeColumns = can('dataTable:writeColumn', table) && !protectedWorkspace;
  const { items, dialogs, starred, toggleFavorite } = useTableActions(table, () =>
    navigate('/home/data-tables'),
  );
  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <header className="flex flex-wrap items-center gap-2">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
          <Link to="/home/data-tables" className="text-ink-2 hover:text-ink">
            Data tables
          </Link>
          <span aria-hidden="true" className="text-ink-3">
            /
          </span>
          <h1 className="truncate text-md font-semibold text-ink">{table.name}</h1>
        </nav>
        <DependencyPill kind="dataTable" id={table.id} />
        <span className="flex-1" />
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
      </header>
      <DataTableGrid table={table} canWrite={canWrite} canChangeColumns={canChangeColumns} />
      {dialogs}
    </div>
  );
}

export function DataTableDetailPage() {
  const { id = '' } = useParams();
  const table = useQuery({
    queryKey: queryKeys.dataTable(id),
    queryFn: () => dataTablesApi.get(id),
    retry: false,
  });
  if (table.isLoading) return <PageLoader />;
  if (table.error instanceof ApiError && table.error.status === 404) {
    return (
      <EmptyState
        icon={<Table2 size={20} />}
        title="Data table not found"
        description="It may have been deleted."
        action={
          <Link to="/home/data-tables" className="text-sm font-semibold text-brand hover:underline">
            Back to data tables
          </Link>
        }
      />
    );
  }
  if (!table.data) {
    return (
      <div className="px-6 py-6">
        <Callout tone="err" title="Error fetching data table content">
          {errorMessage(table.error)}
        </Callout>
      </div>
    );
  }
  // a new table starts with its own search, sort, filters and page
  return <TablePage key={table.data.id} table={table.data} />;
}
