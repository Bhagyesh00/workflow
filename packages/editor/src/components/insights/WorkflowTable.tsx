/**
 * P6-57 (L13): runs per workflow, with sort, paging and a link when `hasReadAccess`. A header sorts by its column
 * (a second press turns the order round); the pager moves by `take` and the size picker changes it.
 */
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Link } from 'react-router';
import type {
  InsightsByWorkflowPage,
  InsightsByWorkflowQuery,
  InsightsByWorkflowRow,
  InsightsByWorkflowSortField,
} from '../../api/types';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { EmptyState, Spinner } from '../ui/misc';
import { formatMetric } from './SummaryStrip';

export interface WorkflowTableProps {
  page: InsightsByWorkflowPage | undefined;
  loading: boolean;
  sortBy: NonNullable<InsightsByWorkflowQuery['sortBy']>;
  onSortChange(sortBy: NonNullable<InsightsByWorkflowQuery['sortBy']>): void;
  skip: number;
  take: number;
  onPageChange(skip: number, take: number): void;
}

const COLUMNS: ReadonlyArray<{ field: InsightsByWorkflowSortField; label: string; numeric: boolean }> = [
  { field: 'workflowName', label: 'Workflow', numeric: false },
  { field: 'total', label: 'Executions', numeric: true },
  { field: 'failed', label: 'Failed', numeric: true },
  { field: 'failureRate', label: 'Failure rate', numeric: true },
  { field: 'timeSaved', label: 'Time saved', numeric: true },
  { field: 'averageRunTime', label: 'Run time (avg.)', numeric: true },
];

const PAGE_SIZES = [10, 25, 50, 100];

function cell(row: InsightsByWorkflowRow, field: InsightsByWorkflowSortField): string {
  switch (field) {
    case 'total':
      return row.total.toLocaleString('en-US');
    case 'failed':
      return row.failed.toLocaleString('en-US');
    case 'failureRate':
      return formatMetric('failureRate', { value: row.failureRate, unit: 'ratio', deviation: null });
    case 'timeSaved':
      return formatMetric('timeSaved', { value: row.timeSaved, unit: 'minute', deviation: null });
    case 'averageRunTime':
      return formatMetric('averageRunTime', {
        value: row.averageRunTime,
        unit: 'millisecond',
        deviation: null,
      });
    default:
      return '';
  }
}

export function WorkflowTable({
  page,
  loading,
  sortBy,
  onSortChange,
  skip,
  take,
  onPageChange,
}: WorkflowTableProps) {
  const [sortField, sortDirection] = sortBy.split(':') as [InsightsByWorkflowSortField, 'asc' | 'desc'];
  const count = page?.count ?? 0;
  const rows = page?.data ?? [];
  const first = count === 0 ? 0 : skip + 1;
  const last = Math.min(skip + take, count);

  const sortOn = (field: InsightsByWorkflowSortField) => {
    // a name reads best A to Z and a figure biggest first; the same column again turns the order round
    const direction =
      field === sortField
        ? sortDirection === 'desc'
          ? 'asc'
          : 'desc'
        : field === 'workflowName'
          ? 'asc'
          : 'desc';
    onSortChange(`${field}:${direction}`);
  };

  if (!loading && page && count === 0) {
    return (
      <EmptyState
        title="No production executions in this period"
        description="Runs from a trigger, webhook or schedule show up here. Manual executions aren't counted."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm" aria-label="Executions by workflow" aria-busy={loading}>
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-2">
              {COLUMNS.map((column) => (
                <th
                  key={column.field}
                  scope="col"
                  className={column.numeric ? 'px-3 py-2 text-right font-medium' : 'px-3 py-2 font-medium'}
                  aria-sort={
                    column.field === sortField
                      ? sortDirection === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                  }
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-medium hover:text-ink"
                    onClick={() => sortOn(column.field)}
                  >
                    {column.label}
                    {column.field === sortField &&
                      (sortDirection === 'asc' ? (
                        <ArrowUp size={12} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={12} aria-hidden="true" />
                      ))}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && !page && (
              <tr>
                <td colSpan={COLUMNS.length} className="px-3 py-6 text-center text-ink-3">
                  <Spinner />
                </td>
              </tr>
            )}
            {rows.map((row, index) => (
              <tr key={row.workflowId ?? `deleted-${index}`} className="border-b border-line last:border-0">
                <td className="max-w-80 truncate px-3 py-2">
                  {row.workflowId && row.hasReadAccess ? (
                    <Link
                      to={`/workflow/${row.workflowId}`}
                      className="font-medium text-brand hover:underline"
                    >
                      {row.workflowName}
                    </Link>
                  ) : (
                    <span
                      className="text-ink-2"
                      title={row.workflowId ? "You can't open this workflow" : 'This workflow was deleted'}
                    >
                      {row.workflowName}
                    </span>
                  )}
                  {row.projectName && <span className="ml-2 text-xs text-ink-3">{row.projectName}</span>}
                </td>
                {COLUMNS.slice(1).map((column) => (
                  <td key={column.field} className="px-3 py-2 text-right tabular-nums">
                    {cell(row, column.field)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 text-sm text-ink-2">
        <div className="flex items-center gap-2">
          <span aria-hidden="true">Rows per page</span>
          <Select
            aria-label="Rows per page"
            value={String(take)}
            onChange={(event) => onPageChange(0, Number(event.target.value))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </div>
        <span aria-live="polite">
          {first}-{last} of {count}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={skip === 0}
          onClick={() => onPageChange(Math.max(skip - take, 0), take)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={skip + take >= count}
          onClick={() => onPageChange(skip + take, take)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
