/** Add a column to a table; the name rules are checked before the server is asked (P4-05). */
import { useQueryClient } from '@tanstack/react-query';
import {
  DATA_TABLE_COLUMN_NAME_MAX,
  DATA_TABLE_COLUMN_NAME_RE,
  DATA_TABLE_COLUMN_TYPES,
  DATA_TABLE_ERRORS,
  DATA_TABLE_RESERVED_COLUMNS,
  type DataTableColumnType,
} from '@workflow/workflow';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableInfo } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { FormField, Select, TextInput } from '../ui/Field';

export const COLUMN_TYPE_LABELS: Record<DataTableColumnType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
};

const NOT_ALLOWED = ['constructor', 'prototype'];

/** the format and reserved rules of a column name; null when it is fine */
export function columnNameFormatError(name: string): string | null {
  if (!DATA_TABLE_COLUMN_NAME_RE.test(name) || name.length > DATA_TABLE_COLUMN_NAME_MAX) {
    return DATA_TABLE_ERRORS.columnNameInvalid;
  }
  const lower = name.toLowerCase();
  const reserved: readonly string[] = DATA_TABLE_RESERVED_COLUMNS;
  return reserved.some((r) => r.toLowerCase() === lower) || NOT_ALLOWED.includes(lower)
    ? DATA_TABLE_ERRORS.columnNameReserved(name)
    : null;
}

/** every rule of a column name in `table`; `except` is the column being renamed */
export function columnNameError(name: string, table: DataTableInfo, except?: string): string | null {
  const format = columnNameFormatError(name);
  if (format) return format;
  return table.columns.some((c) => c.name === name && c.id !== except)
    ? DATA_TABLE_ERRORS.columnNameExists(name, table.name)
    : null;
}

export function AddColumnDialog({ table, onClose }: { table: DataTableInfo; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<DataTableColumnType>('string');
  const [saving, setSaving] = useState(false);
  const error = name ? columnNameError(name, table) : null;

  const submit = async () => {
    if (!name || error) return;
    setSaving(true);
    try {
      await dataTablesApi.addColumn(table.id, { name, type });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
      onClose();
    } catch (cause) {
      toast.error('Error adding column', errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add column"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="add-data-table-column"
            loading={saving}
            disabled={!name || Boolean(error)}
          >
            Add column
          </Button>
        </>
      }
    >
      <form
        id="add-data-table-column"
        className="flex flex-col gap-4"
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
        <FormField label="Type">
          {(id) => (
            <Select
              id={id}
              value={type}
              onChange={(event) => setType(event.target.value as DataTableColumnType)}
            >
              {DATA_TABLE_COLUMN_TYPES.map((value) => (
                <option key={value} value={value}>
                  {COLUMN_TYPE_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </form>
    </Dialog>
  );
}
