/**
 * Import a CSV file into a table (P4-05), and the file picker the create dialog shares. The file goes
 * to the server as text in a JSON body. Every column of the file must be a column of the table.
 */
import { useQueryClient } from '@tanstack/react-query';
import { DATA_TABLE_ERRORS, DATA_TABLE_SYSTEM_COLUMNS } from '@workflow/workflow';
import { FileUp } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableCsvPreview, DataTableInfo } from '../../api/types';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { Dialog } from '../ui/Dialog';
import { Callout } from '../ui/misc';
import { useDataTableLimits } from './StorageBanner';

const CSV_TOO_LARGE = 'File upload error: File too large';

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error("Couldn't read the file"));
    reader.readAsText(file);
  });
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export const previewSummary = (preview: DataTableCsvPreview) =>
  `${plural(preview.rowCount, 'row')}, ${plural(preview.columnCount, 'column')}`;

/** a drop zone and file input; answers the file's text, after checking the upload limit */
export function CsvFilePicker({
  fileName,
  onPicked,
}: {
  fileName?: string;
  onPicked: (file: { name: string; text: string }) => void;
}) {
  const limits = useDataTableLimits();
  const [over, setOver] = useState(false);

  const take = async (file: File | undefined) => {
    if (!file) return;
    const limit = limits.data?.uploadMaxFileSize;
    if (limit !== undefined && file.size > limit) {
      toast.error('Error uploading CSV file', CSV_TOO_LARGE);
      return;
    }
    try {
      onPicked({ name: file.name, text: await readText(file) });
    } catch (cause) {
      toast.error('Error uploading CSV file', errorMessage(cause));
    }
  };

  return (
    <label
      className={cx(
        'flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-ink-2 transition-colors',
        over ? 'border-brand bg-brand-soft' : 'border-line-strong hover:bg-surface-2',
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        void take(event.dataTransfer.files[0]);
      }}
    >
      <FileUp size={18} aria-hidden="true" />
      <span>{fileName ?? 'Drop a CSV file here or click to choose one'}</span>
      <input
        type="file"
        accept=".csv,text/csv"
        aria-label="CSV file"
        className="sr-only"
        onChange={(event) => {
          void take(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </label>
  );
}

export function ImportCsvDialog({ table, onClose }: { table: DataTableInfo; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<{ name: string; text: string }>();
  const [preview, setPreview] = useState<DataTableCsvPreview>();
  const [saving, setSaving] = useState(false);

  const system: readonly string[] = DATA_TABLE_SYSTEM_COLUMNS;
  const known = new Set(table.columns.map((c) => c.name));
  const headers = (preview?.columns ?? []).map((c) => c.name).filter((name) => !system.includes(name));
  const unknown = headers.filter((name) => !known.has(name));
  const missing = table.columns.map((c) => c.name).filter((name) => preview && !headers.includes(name));

  const pick = async (picked: { name: string; text: string }) => {
    setFile(undefined);
    setPreview(undefined);
    try {
      const answer = await dataTablesApi.csvPreview(picked.text, true);
      setFile(picked);
      setPreview(answer);
    } catch (cause) {
      toast.error('Error uploading CSV file', errorMessage(cause));
    }
  };

  const submit = async () => {
    if (!file) return;
    setSaving(true);
    try {
      const result = await dataTablesApi.importCsv(table.id, file.text);
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTable(table.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.dataTableLimits });
      await queryClient.invalidateQueries({ queryKey: ['data-tables'] });
      toast.success(
        `Imported ${plural(result.importedRows, 'row')}`,
        result.systemColumnsIgnored.length
          ? `Ignored the system columns: ${result.systemColumnsIgnored.join(', ')}`
          : undefined,
      );
      onClose();
    } catch (cause) {
      toast.error('Failed to import CSV', errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Import CSV into ${table.name}`}
      description="The first row of the file holds column names, and they must match the columns of this table."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!preview || unknown.length > 0}
            onClick={() => void submit()}
          >
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <CsvFilePicker fileName={file?.name} onPicked={(picked) => void pick(picked)} />
        {preview && <p className="text-sm text-ink-2">{previewSummary(preview)}</p>}
        {unknown.map((name) => (
          <Callout key={name} tone="err">
            {DATA_TABLE_ERRORS.unknownColumn(name)}
          </Callout>
        ))}
        {missing.length > 0 && !unknown.length && (
          <Callout tone="info">These columns stay empty: {missing.join(', ')}</Callout>
        )}
      </div>
    </Dialog>
  );
}
