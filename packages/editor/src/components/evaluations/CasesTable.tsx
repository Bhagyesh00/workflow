/** The cases of one test run: status, inputs, outputs, metrics, the execution, cancel for a pending case (P5-11). */
import { type DataObject, TEST_CASE_ERROR_TEXTS, type TestCaseDto } from '@workflow/workflow';
import { Ban } from 'lucide-react';
import { Link } from 'react-router';
import { IconButton } from '../ui/Button';
import { formatMetric, metricNames } from './MetricsChart';
import { RunStatusPill } from './RunStatusPill';

/** the error text of a failed case, with the message the server kept (already redacted) */
export function caseErrorText(testCase: Pick<TestCaseDto, 'errorCode' | 'errorDetails'>): string | null {
  if (!testCase.errorCode) return null;
  return TEST_CASE_ERROR_TEXTS[testCase.errorCode] ?? TEST_CASE_ERROR_TEXTS.UNKNOWN_ERROR;
}

function detailMessage(details: DataObject | null): string | null {
  const message = details?.message;
  return typeof message === 'string' && message ? message : null;
}

/** an object as short `key: value` text; text is written as text, never as markup */
function ObjectCell({ value }: { value: DataObject | null }) {
  const entries = value ? Object.entries(value) : [];
  if (entries.length === 0) return <span className="text-ink-3">–</span>;
  return (
    <dl className="flex max-w-64 flex-col gap-0.5 text-xs">
      {entries.map(([key, v]) => (
        <div key={key} className="flex gap-1.5">
          <dt className="shrink-0 text-ink-3">{key}</dt>
          <dd className="min-w-0 break-words text-ink-2">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface CasesTableProps {
  cases: TestCaseDto[];
  canWrite: boolean;
  /** a run that was stopped or finished has nothing left to cancel */
  onCancelCase: (testCase: TestCaseDto) => void;
}

export function CasesTable({ cases, canWrite, onCancelCase }: CasesTableProps) {
  const metrics = metricNames(cases);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-card">
      <table className="w-full min-w-[44rem] text-left text-sm" aria-label="Test cases">
        <thead>
          <tr className="border-b border-line text-xs text-ink-3">
            <th scope="col" className="px-4 py-2 font-semibold">
              Row
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              Status
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              Inputs
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              Outputs
            </th>
            {metrics.map((name) => (
              <th key={name} scope="col" className="px-4 py-2 font-semibold">
                {name}
              </th>
            ))}
            <th scope="col" className="px-4 py-2 text-right font-semibold">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {cases.map((testCase) => {
            const error = caseErrorText(testCase);
            const detail = detailMessage(testCase.errorDetails);
            return (
              <tr key={testCase.id} className="border-b border-line last:border-0" data-case-id={testCase.id}>
                <td className="px-4 py-2.5 align-top tabular-nums text-ink-2">{testCase.runIndex + 1}</td>
                <td className="px-4 py-2.5 align-top">
                  <RunStatusPill status={testCase.status} />
                  {error && (
                    <p className="mt-1 max-w-56 text-xs text-err">
                      {error}
                      {detail && <span className="block break-words text-ink-3">{detail}</span>}
                    </p>
                  )}
                </td>
                <td className="px-4 py-2.5 align-top">
                  <ObjectCell value={testCase.inputs} />
                </td>
                <td className="px-4 py-2.5 align-top">
                  <ObjectCell value={testCase.outputs} />
                </td>
                {metrics.map((name) => (
                  <td key={name} className="px-4 py-2.5 align-top tabular-nums text-ink-2">
                    {formatMetric(testCase.metrics?.[name])}
                  </td>
                ))}
                <td className="px-4 py-2.5 text-right align-top">
                  <div className="flex items-center justify-end gap-2">
                    {testCase.executionId && (
                      <Link
                        to={`/executions/${encodeURIComponent(testCase.executionId)}`}
                        className="text-xs font-semibold text-brand hover:underline"
                        aria-label={`Open the execution of row ${testCase.runIndex + 1}`}
                      >
                        Execution
                      </Link>
                    )}
                    {canWrite && testCase.status === 'new' && (
                      <IconButton
                        label={`Cancel row ${testCase.runIndex + 1}`}
                        onClick={() => onCancelCase(testCase)}
                      >
                        <Ban size={14} />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
