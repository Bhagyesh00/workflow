/** The menu of a column header: sort and filter for everyone, rename, move and delete for writers (P4-05). */
import { useQueryClient } from '@tanstack/react-query';
import type { DataTableColumn, DataTableSortDirection } from '@workflow/workflow';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Filter, MoreVertical, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableInfo } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button, IconButton } from '../ui/Button';
import { confirmDialog, Dialog } from '../ui/Dialog';
import { FormField, TextInput } from '../ui/Field';
import { Menu, type MenuItem } from '../ui/Menu';
import { columnNameError } from './AddColumnDialog';

function RenameColumnDialog({
  table,
  column,
  onRenamed,
  onClose,
}: {
  table: DataTableInfo;
  column: DataTableColumn;
  onRenamed: () => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(column.name);
  const [saving, setSaving] = useState(false);
  const error = name ? columnNameError(name, table, column.id) : null;

  const submit = async () => {
    if (!name || error) return;
    if (name === column.name) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await dataTablesApi.renameColumn(table.id, column.id, name);
      onRenamed();
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      onClose();
    } catch (cause) {
      toast.error('Error renaming column', errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rename column"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="rename-data-table-column"
            loading={saving}
            disabled={!name || Boolean(error)}
          >
            Rename
          </Button>
        </>
      }
    >
      <form
        id="rename-data-table-column"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label="Column name" error={error}>
          {(id) => (
            <TextInput
              id={id}
              autoFocus
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </FormField>
      </form>
    </Dialog>
  );
}

export function ColumnHeaderMenu({
  name,
  table,
  column,
  canWrite,
  sort,
  onSort,
  onFilter,
  onMove,
  onColumnGone,
}: {
  name: string;
  table: DataTableInfo;
  /** the user column; undefined for a system column */
  column?: DataTableColumn;
  canWrite: boolean;
  sort?: DataTableSortDirection;
  onSort: (direction: DataTableSortDirection | undefined) => void;
  onFilter: () => void;
  onMove: (column: DataTableColumn, targetIndex: number) => void;
  /** the name stopped existing: anything sorted or filtered by it has to go */
  onColumnGone: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);

  const remove = async (target: DataTableColumn) => {
    const ok = await confirmDialog({
      title: 'Delete column',
      description: `Are you sure you want to delete the column "${target.name}"? Its values in every row go with it. This action cannot be undone.`,
      confirmLabel: 'Delete column',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await dataTablesApi.removeColumn(table.id, target.id);
      onColumnGone(target.name);
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
    } catch (cause) {
      toast.error('Error deleting column', errorMessage(cause));
    }
  };

  const items: Array<MenuItem | 'separator'> = [
    {
      key: 'asc',
      label: 'Sort ascending',
      icon: <ArrowUp size={14} />,
      onSelect: () => onSort('asc'),
    },
    {
      key: 'desc',
      label: 'Sort descending',
      icon: <ArrowDown size={14} />,
      onSelect: () => onSort('desc'),
    },
    ...(sort
      ? [{ key: 'clear', label: 'Clear sort', icon: <X size={14} />, onSelect: () => onSort(undefined) }]
      : []),
    { key: 'filter', label: 'Filter', icon: <Filter size={14} />, onSelect: onFilter },
  ];
  if (canWrite && column) {
    const index = table.columns.findIndex((c) => c.id === column.id);
    items.push(
      'separator',
      {
        key: 'rename',
        label: 'Rename column',
        icon: <Pencil size={14} />,
        onSelect: () => setRenaming(true),
      },
      {
        key: 'left',
        label: 'Move left',
        icon: <ChevronLeft size={14} />,
        disabled: index <= 0,
        onSelect: () => onMove(column, index - 1),
      },
      {
        key: 'right',
        label: 'Move right',
        icon: <ChevronRight size={14} />,
        disabled: index >= table.columns.length - 1,
        onSelect: () => onMove(column, index + 1),
      },
      'separator',
      {
        key: 'delete',
        label: 'Delete column',
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => void remove(column),
      },
    );
  }

  return (
    <>
      <Menu
        // opens to the right, the side the grid can scroll to
        align="start"
        items={items}
        trigger={(t) => (
          <IconButton
            size="sm"
            label={`Column menu for ${name}`}
            onClick={t.toggle}
            aria-expanded={t['aria-expanded']}
            aria-haspopup="menu"
          >
            <MoreVertical size={14} />
          </IconButton>
        )}
      />
      {renaming && column && (
        <RenameColumnDialog
          table={table}
          column={column}
          onRenamed={() => onColumnGone(column.name)}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}
