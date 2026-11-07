/**
 * One test run of a workflow (P5-11): route `workflow/:id/evaluations/:runId`.
 * C0 stub: L9 fills it (totals, cases table, case cancel, error texts, polling) and keeps the
 * `Evaluations` heading, which the C0 contract test reads.
 */
import { useParams } from 'react-router';

export function EvaluationRunPage() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  return (
    <div
      className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8"
      data-workflow-id={id}
      data-run-id={runId}
    >
      <header>
        <h1 className="text-xl font-semibold">Evaluations</h1>
      </header>
    </div>
  );
}
