/**
 * Evaluations of one workflow (P5-11): route `workflow/:id/evaluations`.
 * C0 stub: L9 fills it (setup guide, runs table, metrics chart, run controls) and keeps the
 * `Evaluations` heading, which the C0 contract test reads.
 */
import { useParams } from 'react-router';

export function EvaluationsPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8" data-workflow-id={id}>
      <header>
        <h1 className="text-xl font-semibold">Evaluations</h1>
      </header>
    </div>
  );
}
