/** New data table, from scratch or from a CSV file with its detected columns (P4-05). */
import { useQueryClient } from '@tanstack/react-query';
import {
  DATA_TABLE_COLUMN_TYPES,
  DATA_TABLE_NAME_MAX,
  type DataTableColumnInput,
  type DataTableColumnType,
} from '@workflow/workflow';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableCsvPreview } from '../../api/types';
import { workingProjectId } from '../../features/editor/open-resources';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox, FormField, Select, TextInput } from '../ui/Field';
import { Callout } from '../ui/misc';
import { COLUMN_TYPE_LABELS, columnNameFormatError } from './AddColumnDialog';
import { CsvFilePicker, previewSummary } from './ImportCsvDialog';

interface DraftColumn extends DataTableColumnInput {
  /** the name in the file */
  source: string;
  include: boolean;
  /** identifies the entry in the list, whatever the name says */
  key: number;
}

const DUPLICATE = 'Column names must be different';
/** renaming while leaving a column out is not offered; delete the column after the table is made */
const RENAME_AND_LEAVE_OUT =
  'Include every column to rename one. You can delete a column after the table is made.';

function columnError(column: DraftColumn, all: DraftColumn[]): string | null {
  if (!column.include) return null;
  const format = columnNameFormatError(column.name);
  if (format) return format;
  return all.filter((c) => c.include && c.name === column.name).length > 1 ? DUPLICATE : null;
}

export function CreateTableDialog({
  initialName = '',
  onClose,
}: {
  initialName?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(initialName);
  const [source, setSource] = useState<'scratch' | 'csv'>('scratch');
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [hasHeaders, setHasHeaders] = useState(true);
  const [preview, setPreview] = useState<DataTableCsvPreview>();
  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(0);

  const fromCsv = source === 'csv';
  const trimmed = name.trim();
  const errors = columns.map((column) => columnError(column, columns));
  const included = columns.filter((column) => column.include);
  const renameConflict =
    included.length < columns.length && included.some((column) => column.name !== column.source);
  const csvReady = Boolean(preview) && included.length > 0 && !errors.some(Boolean) && !renameConflict;
  const canSubmit = trimmed.length > 0 && trimmed.length <= DATA_TABLE_NAME_MAX && (!fromCsv || csvReady);

  const readPreview = async (picked: { name: string; text: string }, headers: boolean) => {
    setPreview(undefined);
    setColumns([]);
    try {
      const answer = await dataTablesApi.csvPreview(picked.text, headers, workingProjectId());
      setFile(picked);
      setPreview(answer);
      setColumns(
        answer.columns.map((c) => ({ ...c, source: c.name, include: true, key: nextKey.current++ })),
      );
    } catch (cause) {
      setFile(undefined);
      toast.error('Error uploading CSV file', errorMessage(cause));
    }
  };

  const patch = (index: number, change: Partial<DraftColumn>) =>
    setColumns((list) => list.map((c, i) => (i === index ? { ...c, ...change } : c)));

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const table = await dataTablesApi.create({
        name: trimmed,
        projectId: workingProjectId(),
        columns: fromCsv
          ? included.map(({ name: column, type, source: header }) => ({
              name: column,
              type,
              csvColumnName: header,
            }))
          : [],
        ...(fromCsv ? { csv: file?.text, hasHeaders } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
      onClose();
      navigate(`/data-tables/${encodeURIComponent(table.id)}`);
    } catch (cause) {
      toast.error('Error creating data table', errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New data table"
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="create-data-table"
            loading={saving}
            disabled={!canSubmit}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        id="create-data-table"
        className="flex flex-col gap-4"
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
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">How to start</legend>
          {(
            [
              ['scratch', 'From scratch'],
              ['csv', 'Import CSV'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="inline-flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="data-table-source"
                className="size-4 accent-[var(--wf-brand)]"
                checked={source === value}
                onChange={() => setSource(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {fromCsv && (
          <>
            <CsvFilePicker
              fileName={file?.name}
              onPicked={(picked) => {
                setFile(picked);
                void readPreview(picked, hasHeaders);
              }}
            />
            <Checkbox
              label="My CSV file contains a header row"
              checked={hasHeaders}
              onChange={(event) => {
                const next = event.target.checked;
                setHasHeaders(next);
                if (file) void readPreview(file, next);
              }}
            />
          </>
        )}
        {fromCsv && preview && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-2">{previewSummary(preview)}</p>
            <ul className="wf-scroll flex max-h-64 flex-col gap-2 overflow-auto">
              {columns.map((column, index) => (
                <li key={column.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="size-4 shrink-0 accent-[var(--wf-brand)]"
                      aria-label={`Include column ${index + 1}`}
                      checked={column.include}
                      onChange={(event) => patch(index, { include: event.target.checked })}
                    />
                    <TextInput
                      aria-label={`Name of column ${index + 1}`}
                      autoComplete="off"
                      disabled={!column.include}
                      value={column.name}
                      onChange={(event) => patch(index, { name: event.target.value })}
                    />
                    <Select
                      aria-label={`Type of column ${index + 1}`}
                      className="w-32 shrink-0"
                      disabled={!column.include}
                      value={column.type}
                      onChange={(event) => patch(index, { type: event.target.value as DataTableColumnType })}
                    >
                      {DATA_TABLE_COLUMN_TYPES.map((value) => (
                        <option key={value} value={value}>
                          {COLUMN_TYPE_LABELS[value]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {errors[index] && (
                    <p className="pl-6 text-xs text-err" role="alert">
                      {errors[index]}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {renameConflict && <Callout tone="warn">{RENAME_AND_LEAVE_OUT}</Callout>}
          </div>
        )}
      </form>
    </Dialog>
  );
}
