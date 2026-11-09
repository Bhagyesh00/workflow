/**
 * One test run of a workflow (P5-11): route `workflow/:id/evaluations/:runId`. Totals, the cases table with
 * status, inputs, outputs, metrics and a link to each execution, cancel for a pending case, the run's error
 * text, and a poll while the run is new or running. Viewers read only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { evaluationsApi, workflowsApi } from '../api/endpoints';
import { queryKeys, useMe } from '../api/queries';
import { CasesTable } from '../components/evaluations/CasesTable';
import { formatMetric, metricNames } from '../components/evaluations/MetricsChart';
import { VIEWER_REASON } from '../components/evaluations/RunControls';
import { EVALUATION_POLL_MS, isActiveRun, RunStatusPill } from '../components/evaluations/RunStatusPill';
import { runDurationMs, runErrorText } from '../components/evaluations/RunsTable';
import { Button } from '../components/ui/Button';
import { Callout, PageLoader } from '../components/ui/misc';
import { formatDateTime, formatDuration, plural } from '../lib/format';
import { canWith } from '../lib/permissions';
import { toast } from '../stores/ui-store';

const PAGE = 250;

export function EvaluationRunPage() {
  const { id = '', runId = '' } = useParams<{ id: string; runId: string }>();
  const queryClient = useQueryClient();
  const me = useMe().data;
  const workflow = useQuery({
    queryKey: queryKeys.workflow(id),
    queryFn: () => workflowsApi.get(id),
    enabled: Boolean(id),
    retry: false,
  });
  // stopping a test case is `workflow:execute` on this workflow
  const canWrite = canWith(me, 'workflow:execute', workflow.data);

  const run = useQuery({
    queryKey: queryKeys.testRun(id, runId),
    queryFn: () => evaluationsApi.get(id, runId),
    enabled: Boolean(id && runId),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && isActiveRun(query.state.data.status) ? EVALUATION_POLL_MS : false,
  });
  const active = run.data ? isActiveRun(run.data.status) : false;
  const cases = useQuery({
    queryKey: queryKeys.testRunCases(id, runId),
    queryFn: async () => {
      const all = [];
      for (let skip = 0; skip < 1000; skip += PAGE) {
        const page = await evaluationsApi.listCases(id, runId, { skip, limit: PAGE });
        all.push(...page);
        if (page.length < PAGE) break;
      }
      return all;
    },
    enabled: Boolean(id && runId) && run.isSuccess,
    retry: false,
    refetchInterval: active ? EVALUATION_POLL_MS : false,
  });

  // the poll stops with the run, so read the cases once more for their final state
  const wasActive = useRef(false);
  const refetchCases = cases.refetch;
  useEffect(() => {
    if (wasActive.current && !active) void refetchCases();
    wasActive.current = active;
  }, [active, refetchCases]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.testRuns(id) });
  const stop = useMutation({
    mutationFn: () => evaluationsApi.cancel(id, runId),
    onSuccess: refresh,
    onError: (error) => toast.error("Couldn't stop the test run", errorMessage(error)),
  });
  const cancelCase = useMutation({
    mutationFn: (caseId: string) => evaluationsApi.cancelCase(id, runId, caseId),
    onSuccess: refresh,
    onError: (error) => toast.error("Couldn't cancel the test case", errorMessage(error)),
  });

  const data = run.data;
  const error = data ? runErrorText(data) : null;
  const counts = data?.caseCounts;
  const backTo = `/workflow/${encodeURIComponent(id)}/evaluations`;

  return (
    <div
      className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8"
      data-workflow-id={id}
      data-run-id={runId}
    >
      <header className="flex flex-col gap-3">
        <Link to={backTo} className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft size={14} aria-hidden="true" />
          All test runs
        </Link>
        <h1 className="text-xl font-semibold">Evaluations</h1>
        {data && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-ink-2">Run from {formatDateTime(data.runAt ?? data.createdAt)}</p>
            <RunStatusPill status={data.status} finalResult={data.finalResult} />
            {active && (
              <Button
                variant="danger"
                size="sm"
                loading={stop.isPending}
                disabled={!canWrite}
                title={canWrite ? undefined : VIEWER_REASON}
                onClick={() => stop.mutate()}
              >
                Stop test
              </Button>
            )}
          </div>
        )}
        {data && !canWrite && (
          <p className="text-xs text-ink-3" data-testid="run-read-only">
            {VIEWER_REASON}
          </p>
        )}
      </header>

      {run.isPending && <PageLoader />}
      {run.isError && (
        <Callout tone="err" title="Couldn't load the test run">
          {errorMessage(run.error)}
        </Callout>
      )}

      {data && counts && (
        <>
          {error && (
            <Callout tone="err" title={error.text}>
              {error.hint}
            </Callout>
          )}
          <section
            aria-labelledby="run-totals"
            className="rounded-xl border border-line bg-surface p-4 shadow-card"
          >
            <h2 id="run-totals" className="font-display text-md font-semibold text-ink">
              Totals
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <Stat label="Cases" value={String(counts.total)} />
              <Stat label="Succeeded" value={String(counts.success)} />
              <Stat label="Failed" value={String(counts.error)} />
              <Stat label="Pending" value={String(counts.new + counts.running)} />
              <Stat label="Stopped" value={String(counts.cancelled)} />
              <Stat label="At once" value={plural(data.concurrency, 'case')} />
              <Stat label="Duration" value={formatDuration(runDurationMs(data))} />
              {metricNames([data]).map((name) => (
                <Stat key={name} label={name} value={formatMetric(data.metrics?.[name])} />
              ))}
            </dl>
          </section>

          <section aria-labelledby="run-cases" className="flex flex-col gap-3">
            <h2 id="run-cases" className="font-display text-md font-semibold text-ink">
              Cases
            </h2>
            {cases.isError && (
              <Callout tone="err" title="Couldn't load the test cases">
                {errorMessage(cases.error)}
              </Callout>
            )}
            {cases.data && cases.data.length > 0 && (
              <CasesTable
                cases={cases.data}
                canWrite={canWrite}
                onCancelCase={(testCase) => cancelCase.mutate(testCase.id)}
              />
            )}
            {cases.data?.length === 0 && <p className="text-sm text-ink-2">This run has no test cases.</p>}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}
