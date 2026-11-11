/**
 * The grid of one data table (P4-05): our own paged table, since pages come from the server. Inline
 * edit per type, rows and columns, header menu, per-type filters, search and page sizes. A viewer
 * gets the same grid with nothing to change.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DATA_TABLE_SYSTEM_COLUMNS,
  DataTableCellValue,
  DataTableColumn,
  DataTableColumnType,
  DataTableFilter,
  DataTablePage,
  DataTableRow,
  DataTableSortDirection,
} from '@workflow/workflow';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Filter, Plus, Search, Trash2, X } from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableInfo } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button, IconButton } from '../ui/Button';
import { cx } from '../ui/cx';
import { confirmDialog } from '../ui/Dialog';
import { Select } from '../ui/Field';
import { Callout, EmptyState, Spinner } from '../ui/misc';
import { AddColumnDialog } from './AddColumnDialog';
import { CellEditor, CellValue } from './CellEditor';
import { ColumnFilter, type ColumnFilterValue, filterSummary } from './ColumnFilter';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { plural } from './ImportCsvDialog';

const PAGE_SIZES = [10, 20, 50];
const SYSTEM_TYPES: Record<(typeof DATA_TABLE_SYSTEM_COLUMNS)[number], DataTableColumnType> = {
  id: 'number',
  createdAt: 'date',
  updatedAt: 'date',
};

/** a value that settles after typing stops, so a search asks the server once */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

interface GridColumn {
  name: string;
  type: DataTableColumnType;
  /** undefined for a system column */
  column?: DataTableColumn;
}

const byRowId = (ids: number[]): DataTableFilter => ({
  type: 'or',
  filters: ids.map((value) => ({ columnName: 'id', condition: 'eq', value })),
});

/** `canWrite` edits rows; `canChangeColumns` adds, renames, moves and deletes columns (off on a protected workspace) */
export function DataTableGrid({
  table,
  canWrite,
  canChangeColumns,
}: {
  table: DataTableInfo;
  canWrite: boolean;
  canChangeColumns: boolean;
}) {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState('');
  const search = useDebounced(searchText.trim());
  const [take, setTake] = useState(PAGE_SIZES[0]);
  const [skip, setSkip] = useState(0);
  const [sort, setSort] = useState<{ column: string; direction: DataTableSortDirection }>();
  const [filters, setFilters] = useState<Record<string, ColumnFilterValue>>({});
  const [filterColumn, setFilterColumn] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<{ rowId: number; column: string }>();
  const [cursor, setCursor] = useState({ row: 0, column: 0 });
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(0);
  const [saved, setSaved] = useState(false);
  const pageSizeId = useId();
  const gridRef = useRef<HTMLTableElement>(null);
  const dragged = useRef<DataTableColumn | undefined>(undefined);
  const refocus = useRef<string | undefined>(undefined);

  const userColumns = useMemo(
    () => [...table.columns].sort((a, b) => a.position - b.position),
    [table.columns],
  );
  const leading: GridColumn = { name: 'id', type: SYSTEM_TYPES.id };
  const trailing: GridColumn[] = [
    { name: 'createdAt', type: SYSTEM_TYPES.createdAt },
    { name: 'updatedAt', type: SYSTEM_TYPES.updatedAt },
  ];
  const editable: GridColumn[] = userColumns.map((column) => ({
    name: column.name,
    type: column.type,
    column,
  }));
  const shown = [leading, ...editable, ...trailing];

  const clauses = Object.values(filters).flatMap((filter) => filter.clauses);
  const filter: DataTableFilter | undefined = clauses.length ? { type: 'and', filters: clauses } : undefined;
  const query = { skip, take, sortBy: sort, search: search || undefined, filter };
  const rowsKey = queryKeys.dataTableRows(table.id, query);
  const rows = useQuery({
    queryKey: rowsKey,
    queryFn: () => dataTablesApi.rows(table.id, query),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const list = rows.data?.data ?? [];
  const count = rows.data?.count ?? 0;

  useEffect(() => {
    if (rows.error) toast.error('Error fetching data table content', errorMessage(rows.error));
  }, [rows.error]);

  // the last row of the last page went: show the page before it
  useEffect(() => {
    if (!rows.isPlaceholderData && rows.data && skip > 0 && skip >= rows.data.count) {
      setSkip(Math.max(Math.floor((rows.data.count - 1) / take), 0) * take);
    }
  }, [rows.data, rows.isPlaceholderData, skip, take]);

  // whatever changes the list starts it again from the first page
  const restart = () => {
    setSkip(0);
    setSelected(new Set());
  };
  const changeSort = (next: typeof sort) => {
    setSort(next);
    restart();
  };
  const changeFilter = (name: string, next?: ColumnFilterValue) => {
    setFilters(({ [name]: _old, ...rest }) => (next ? { ...rest, [name]: next } : rest));
    restart();
  };

  // back in the cell after Enter or Escape, so the keyboard keeps its place
  useEffect(() => {
    if (editing || !refocus.current) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${refocus.current}"]`)?.focus();
    refocus.current = undefined;
  }, [editing]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
  };

  const tracked = async (run: () => Promise<void>) => {
    setSaving((n) => n + 1);
    setSaved(false);
    try {
      await run();
      setSaved(true);
    } finally {
      setSaving((n) => n - 1);
    }
  };

  const saveCell = (row: DataTableRow, column: string, value: DataTableCellValue) => {
    setEditing(undefined);
    // the new value shows at once; a failure refetches the old one
    queryClient.setQueryData<DataTablePage<DataTableRow>>(rowsKey, (page) =>
      page
        ? { ...page, data: page.data.map((r) => (r.id === row.id ? { ...r, [column]: value } : r)) }
        : page,
    );
    void tracked(async () => {
      try {
        await dataTablesApi.updateRows(table.id, {
          filter: byRowId([row.id]),
          data: { [column]: value },
        });
      } catch (cause) {
        toast.error('Error updating row', errorMessage(cause));
        throw cause;
      } finally {
        await refresh();
      }
    }).catch(() => undefined);
  };

  const addRow = () =>
    void tracked(async () => {
      try {
        await dataTablesApi.insertRows(table.id, [{}], 'all');
        // the new row is the last one, unless a sort or filter says otherwise
        setSkip(Math.floor(count / take) * take);
        await refresh();
      } catch (cause) {
        toast.error('Error adding row', errorMessage(cause));
        throw cause;
      }
    }).catch(() => undefined);

  const deleteSelected = async () => {
    const ids = [...selected];
    const ok = await confirmDialog({
      title: 'Delete rows',
      description: `Are you sure you want to delete ${plural(ids.length, 'row')}? This action cannot be undone.`,
      confirmLabel: 'Delete rows',
      tone: 'danger',
    });
    if (!ok) return;
    await tracked(async () => {
      try {
        await dataTablesApi.deleteRows(table.id, byRowId(ids));
        setSelected(new Set());
        await refresh();
      } catch (cause) {
        toast.error('Error deleting rows', errorMessage(cause));
        throw cause;
      }
    }).catch(() => undefined);
  };

  const moveColumn = (column: DataTableColumn, targetIndex: number) =>
    void tracked(async () => {
      try {
        await dataTablesApi.moveColumn(table.id, column.id, targetIndex);
        await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      } catch (cause) {
        toast.error('Error moving column', errorMessage(cause));
        throw cause;
      }
    }).catch(() => undefined);

  const dropColumn = (name: string) => {
    changeFilter(name);
    setSort((current) => (current?.column === name ? undefined : current));
  };

  const dragProps = (column: DataTableColumn | undefined) =>
    canChangeColumns && column
      ? {
          draggable: true,
          onDragStart: (event: DragEvent) => {
            dragged.current = column;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', column.name);
          },
          onDragOver: (event: DragEvent) => {
            if (dragged.current) event.preventDefault();
          },
          onDrop: (event: DragEvent) => {
            event.preventDefault();
            const from = dragged.current;
            dragged.current = undefined;
            if (from && from.id !== column.id) {
              moveColumn(
                from,
                userColumns.findIndex((c) => c.id === column.id),
              );
            }
          },
          onDragEnd: () => {
            dragged.current = undefined;
          },
        }
      : {};

  // arrow keys move between cells; Enter or F2 opens the editor
  const onCellKey = (
    event: KeyboardEvent<HTMLTableCellElement>,
    rowIndex: number,
    columnIndex: number,
    open?: () => void,
  ) => {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      const next = {
        row: Math.min(Math.max(rowIndex + move[0], 0), list.length - 1),
        column: Math.min(Math.max(columnIndex + move[1], 0), shown.length - 1),
      };
      setCursor(next);
      gridRef.current?.querySelector<HTMLElement>(`[data-cell="${next.row}:${next.column}"]`)?.focus();
    } else if ((event.key === 'Enter' || event.key === 'F2') && open) {
      event.preventDefault();
      open();
    }
  };

  if (!userColumns.length) {
    return (
      <>
        <EmptyState
          title="No columns yet"
          description={
            canChangeColumns ? 'Add a column to start adding rows.' : 'Nobody has added a column yet.'
          }
          action={
            canChangeColumns ? (
              <Button variant="primary" icon={<Plus size={15} />} onClick={() => setAdding(true)}>
                Add first column
              </Button>
            ) : undefined
          }
        />
        {adding && <AddColumnDialog table={table} onClose={() => setAdding(false)} />}
      </>
    );
  }

  const allSelected = list.length > 0 && list.every((row) => selected.has(row.id));
  const first = count ? skip + 1 : 0;
  const last = Math.min(skip + take, count);
  const filterTarget = shown.find((c) => c.name === filterColumn);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64 max-w-full">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
          />
          <input
            className="wf-field pl-9"
            placeholder="Search rows"
            aria-label="Search rows"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              restart();
            }}
          />
        </div>
        <span className="text-xs text-ink-3">Date searches use UTC format</span>
        <span className="flex-1" />
        <span role="status" className="text-xs text-ink-3">
          {saving > 0 ? 'Saving…' : saved ? 'Saved' : ''}
        </span>
        {canWrite && selected.size > 0 && (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={14} />}
            onClick={() => void deleteSelected()}
          >
            Delete rows ({selected.size})
          </Button>
        )}
      </div>

      {Object.keys(filters).length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap gap-1.5">
          {Object.entries(filters).map(([name, active]) => (
            <li
              key={name}
              className="inline-flex items-center gap-1 rounded-full bg-brand-soft py-0.5 pr-1 pl-2.5 text-xs text-brand"
            >
              <span>
                {name} {filterSummary(shown.find((c) => c.name === name)?.type ?? 'string', active)}
              </span>
              <button
                type="button"
                aria-label={`Remove filter on ${name}`}
                className="rounded-full p-0.5 hover:bg-surface-3"
                onClick={() => changeFilter(name)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {rows.error && !rows.data ? (
        <Callout tone="err" title="Error fetching data table content">
          {errorMessage(rows.error)}
        </Callout>
      ) : (
        // tall enough for an open header menu, which a scrolling box would otherwise cut off
        <div className="wf-scroll min-h-96 overflow-auto rounded-xl border border-line">
          <table
            ref={gridRef}
            role="grid"
            aria-label={`Rows of ${table.name}`}
            aria-busy={rows.isFetching}
            className="w-full border-collapse text-sm"
          >
            <thead className="bg-surface-2 text-left">
              <tr>
                {canWrite && (
                  <td className="w-9 border-b border-line px-2.5">
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-[var(--wf-brand)]"
                      aria-label="Select all rows on this page"
                      checked={allSelected}
                      onChange={(event) =>
                        setSelected(new Set(event.target.checked ? list.map((row) => row.id) : []))
                      }
                    />
                  </td>
                )}
                {shown.map(({ name, column }) => {
                  const direction = sort?.column === name ? sort.direction : undefined;
                  return (
                    <th
                      key={name}
                      scope="col"
                      data-column={name}
                      aria-sort={
                        direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'
                      }
                      className={cx(
                        'border-b border-line px-2.5 py-1 font-semibold whitespace-nowrap text-ink-2',
                        !column && 'font-normal text-ink-3',
                      )}
                      {...dragProps(column)}
                    >
                      <span className="flex items-center gap-1">
                        <span>{name}</span>
                        {direction === 'asc' && <ArrowUp size={12} aria-hidden="true" />}
                        {direction === 'desc' && <ArrowDown size={12} aria-hidden="true" />}
                        {filters[name] && <Filter size={12} aria-hidden="true" className="text-brand" />}
                        <ColumnHeaderMenu
                          name={name}
                          table={{ ...table, columns: userColumns }}
                          column={column}
                          canWrite={canChangeColumns}
                          sort={direction}
                          onSort={(next) => changeSort(next ? { column: name, direction: next } : undefined)}
                          onFilter={() => setFilterColumn(name)}
                          onMove={moveColumn}
                          onColumnGone={dropColumn}
                        />
                      </span>
                    </th>
                  );
                })}
                {canChangeColumns && (
                  <td className="w-9 border-b border-line px-1">
                    <IconButton size="sm" label="Add column" onClick={() => setAdding(true)}>
                      <Plus size={14} />
                    </IconButton>
                  </td>
                )}
              </tr>
            </thead>
            <tbody>
              {list.map((row, rowIndex) => (
                <tr key={row.id} className="hover:bg-surface-2">
                  {canWrite && (
                    <td className="border-b border-line px-2.5">
                      <input
                        type="checkbox"
                        className="size-4 align-middle accent-[var(--wf-brand)]"
                        aria-label={`Select row ${row.id}`}
                        checked={selected.has(row.id)}
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                  )}
                  {shown.map(({ name, type, column }, columnIndex) => {
                    const value = Object.hasOwn(row, name) ? row[name] : null;
                    const isEditing = editing?.rowId === row.id && editing.column === name;
                    const open =
                      canWrite && column ? () => setEditing({ rowId: row.id, column: name }) : undefined;
                    const isCursor =
                      Math.min(cursor.row, list.length - 1) === rowIndex && cursor.column === columnIndex;
                    return (
                      <td
                        key={name}
                        role="gridcell"
                        data-cell={`${rowIndex}:${columnIndex}`}
                        data-column-cell={name}
                        tabIndex={isCursor ? 0 : -1}
                        className={cx(
                          'max-w-80 border-b border-line px-2.5 py-1.5 align-top outline-none focus-visible:ring-2 focus-visible:ring-brand',
                          open && 'cursor-text',
                          !column && 'text-ink-3',
                        )}
                        onFocus={() => setCursor({ row: rowIndex, column: columnIndex })}
                        onClick={() => {
                          if (!isEditing) open?.();
                        }}
                        onKeyDownCapture={(event) => {
                          const leaves = (event.key === 'Enter' && !event.shiftKey) || event.key === 'Escape';
                          if (isEditing && leaves) refocus.current = `${rowIndex}:${columnIndex}`;
                        }}
                        onKeyDown={(event) => onCellKey(event, rowIndex, columnIndex, open)}
                      >
                        {isEditing ? (
                          <CellEditor
                            type={type}
                            value={value}
                            label={`Edit ${name} of row ${row.id}`}
                            onCommit={(next) => saveCell(row, name, next)}
                            onCancel={() => setEditing(undefined)}
                          />
                        ) : (
                          <CellValue value={value} type={type} />
                        )}
                      </td>
                    );
                  })}
                  {canChangeColumns && <td className="border-b border-line" />}
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && !rows.isLoading && (
            <p className="px-3 py-8 text-center text-sm text-ink-3">No rows</p>
          )}
          {rows.isLoading && (
            <p className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-ink-3">
              <Spinner size={13} /> Loading rows
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {canWrite && (
          <Button size="sm" icon={<Plus size={14} />} onClick={addRow}>
            Add row
          </Button>
        )}
        <span className="flex-1" />
        <label htmlFor={pageSizeId} className="flex items-center gap-2 text-xs text-ink-2">
          <span>Rows per page</span>
          <Select
            id={pageSizeId}
            className="w-20"
            value={String(take)}
            onChange={(event) => {
              setTake(Number(event.target.value));
              restart();
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>
        <span className="text-xs text-ink-2">
          {first}-{last} of {count}
        </span>
        <IconButton
          size="sm"
          label="Previous page"
          disabled={skip === 0}
          onClick={() => setSkip(Math.max(skip - take, 0))}
        >
          <ChevronLeft size={15} />
        </IconButton>
        <IconButton
          size="sm"
          label="Next page"
          disabled={skip + take >= count}
          onClick={() => setSkip(skip + take)}
        >
          <ChevronRight size={15} />
        </IconButton>
      </div>

      {adding && <AddColumnDialog table={table} onClose={() => setAdding(false)} />}
      {filterTarget && (
        <ColumnFilter
          column={filterTarget.name}
          type={filterTarget.type}
          current={filters[filterTarget.name]}
          onApply={(next) => {
            changeFilter(filterTarget.name, next);
            setFilterColumn(undefined);
          }}
          onClear={() => {
            changeFilter(filterTarget.name);
            setFilterColumn(undefined);
          }}
          onClose={() => setFilterColumn(undefined)}
        />
      )}
    </div>
  );
}
