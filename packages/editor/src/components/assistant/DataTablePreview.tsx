/**
 * P5-67 (L2): the first 20 rows of a data table through the existing API, with Open. Values render as text.
 */
import { useQuery } from '@tanstack/react-query';
import type { DataTableCellValue } from '@workflow/workflow';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import { Callout, PageLoader } from '../ui/misc';

export interface DataTablePreviewProps {
  dataTableId: string;
}

/** rows the preview shows */
export const DATA_TABLE_PREVIEW_ROWS = 20;

function cellText(value: DataTableCellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function DataTablePreview({ dataTableId }: DataTablePreviewProps) {
  const table = useQuery({
    queryKey: [...queryKeys.assistant, 'preview', 'data-table', dataTableId],
    queryFn: () => dataTablesApi.get(dataTableId),
  });
  const rows = useQuery({
    queryKey: [...queryKeys.assistant, 'preview', 'data-table', dataTableId, 'rows'],
    queryFn: () => dataTablesApi.rows(dataTableId, { take: DATA_TABLE_PREVIEW_ROWS, skip: 0 }),
  });
  if (table.isPending || rows.isPending) return <PageLoader label="Loading the table" />;
  const failure = table.error ?? rows.error;
  if (failure) return <Callout tone="err">{`Couldn't load the table. ${errorMessage(failure)}`}</Callout>;
  const info = table.data;
  const page = rows.data;
  const columns = [...(info?.columns ?? [])].sort((a, b) => a.position - b.position);
  const shown = (page?.data ?? []).slice(0, DATA_TABLE_PREVIEW_ROWS);
  const total = page?.count ?? shown.length;
  return (
    <section className="flex min-h-0 flex-col gap-3" aria-label={`Preview of ${info?.name ?? 'table'}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-md font-semibold">{info?.name}</p>
          <p className="text-sm text-ink-2">
            {total === 0 ? 'No rows' : `Showing ${shown.length} of ${total} row${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <Link
          to={`/data-tables/${encodeURIComponent(dataTableId)}`}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-semibold text-ink hover:border-line-strong hover:bg-surface-2"
        >
          <ExternalLink size={14} aria-hidden />
          Open
        </Link>
      </div>
      <div className="wf-scroll max-h-[60vh] overflow-auto rounded-xl border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              <th scope="col" className="border-b border-line px-2 py-1.5 font-semibold text-ink-2">
                id
              </th>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className="border-b border-line px-2 py-1.5 font-semibold text-ink-2"
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <td className="px-2 py-1 text-ink-2">{row.id}</td>
                {columns.map((column) => (
                  <td key={column.id} className="max-w-64 truncate px-2 py-1 text-ink">
                    {cellText(row[column.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
