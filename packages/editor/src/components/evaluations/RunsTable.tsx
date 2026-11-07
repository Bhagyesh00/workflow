/** The runs of a workflow, newest first, with a column for each metric (P5-11). */
import { TEST_RUN_ERROR_HINTS, TEST_RUN_ERROR_TEXTS, type TestRunDto } from '@workflow/workflow';
import { Square, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import { IconButton } from '../ui/Button';
import { formatMetric, metricNames } from './MetricsChart';
import { isActiveRun, RunStatusPill } from './RunStatusPill';

/** the text a failed run shows: n8n's error text and, for some codes, a second line */
export function runErrorText(run: Pick<TestRunDto, 'errorCode'>): { text: string; hint?: string } | null {
  if (!run.errorCode) return null;
  return {
    text: TEST_RUN_ERROR_TEXTS[run.errorCode] ?? TEST_RUN_ERROR_TEXTS.UNKNOWN_ERROR,
    hint: TEST_RUN_ERROR_HINTS[run.errorCode],
  };
}

export function runDurationMs(run: Pick<TestRunDto, 'runAt' | 'completedAt'>): number | null {
  if (!run.runAt || !run.completedAt) return null;
  return new Date(run.completedAt).getTime() - new Date(run.runAt).getTime();
}

export interface RunsTableProps {
  runs: TestRunDto[];
  workflowId: string;
  canWrite: boolean;
  onStop: (run: TestRunDto) => void;
  onDelete: (run: TestRunDto) => void;
}

export function RunsTable({ runs, workflowId, canWrite, onStop, onDelete }: RunsTableProps) {
  const metrics = metricNames(runs);
  const base = `/workflow/${encodeURIComponent(workflowId)}/evaluations`;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
      <table className="w-full min-w-[40rem] text-left text-sm" aria-label="Test runs">
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th scope="col" className="px-4 py-2 font-semibold">
              Run
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              Status
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              Cases
            </th>
            {metrics.map((name) => (
              <th key={name} scope="col" className="px-4 py-2 font-semibold">
                {name}
              </th>
            ))}
            <th scope="col" className="px-4 py-2 font-semibold">
              Duration
            </th>
            <th scope="col" className="px-4 py-2 text-right font-semibold">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const error = runErrorText(run);
            const active = isActiveRun(run.status);
            const done = run.caseCounts.success + run.caseCounts.error + run.caseCounts.cancelled;
            return (
              <tr key={run.id} className="border-b border-line last:border-0" data-run-id={run.id}>
                <td className="px-4 py-2.5 align-top">
                  <Link
                    to={`${base}/${encodeURIComponent(run.id)}`}
                    className="font-semibold text-brand hover:underline"
                    title={formatDateTime(run.runAt ?? run.createdAt)}
                  >
                    {formatRelative(run.runAt ?? run.createdAt)}
                  </Link>
                </td>
                <td className="px-4 py-2.5 align-top">
                  <RunStatusPill status={run.status} finalResult={run.finalResult} />
                  {error && (
                    <p className="mt-1 max-w-56 text-xs text-err">
                      {error.text}
                      {error.hint && <span className="block text-ink-3">{error.hint}</span>}
                    </p>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top tabular-nums text-ink-2">
                  {run.caseCounts.total === 0 ? '–' : `${done} of ${run.caseCounts.total}`}
                </td>
                {metrics.map((name) => (
                  <td key={name} className="px-4 py-2.5 align-top tabular-nums text-ink-2">
                    {formatMetric(run.metrics?.[name])}
                  </td>
                ))}
                <td className="px-4 py-2.5 align-top tabular-nums text-ink-2">
                  {formatDuration(runDurationMs(run))}
                </td>
                <td className="px-4 py-2.5 text-right align-top">
                  {canWrite &&
                    (active ? (
                      <IconButton
                        label={`Stop run ${formatDateTime(run.runAt ?? run.createdAt)}`}
                        onClick={() => onStop(run)}
                      >
                        <Square size={14} />
                      </IconButton>
                    ) : (
                      <IconButton
                        label={`Delete run ${formatDateTime(run.runAt ?? run.createdAt)}`}
                        onClick={() => onDelete(run)}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
