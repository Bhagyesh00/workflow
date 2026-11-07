/**
 * Evaluations of one workflow (P5-11): route `workflow/:id/evaluations`. A setup guide while the workflow has
 * no Evaluation Trigger or no run, the runs table with a column for each metric, the metrics chart, Run with
 * "run in parallel", Stop test and delete. The list polls while a run is new or running. Viewers read only.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVALUATION_TEXTS, type TestRunDto } from '@workflow/workflow';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { evaluationsApi, workflowsApi } from '../api/endpoints';
import { queryKeys, useMe } from '../api/queries';
import { MetricsChart } from '../components/evaluations/MetricsChart';
import { RunControls } from '../components/evaluations/RunControls';
import { EVALUATION_POLL_MS, isActiveRun } from '../components/evaluations/RunStatusPill';
import { RunsTable } from '../components/evaluations/RunsTable';
import { SetupGuide, setupSteps } from '../components/evaluations/SetupGuide';
import { confirmDialog } from '../components/ui/Dialog';
import { Callout, PageLoader } from '../components/ui/misc';
import { formatDateTime } from '../lib/format';
import { toast } from '../stores/ui-store';

const LIST_LIMIT = 100;

export function EvaluationsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const canWrite = useMe().data?.role !== 'viewer';

  const workflow = useQuery({
    queryKey: queryKeys.workflow(id),
    queryFn: () => workflowsApi.get(id),
    enabled: Boolean(id),
    retry: false,
  });
  const runs = useQuery({
    queryKey: queryKeys.testRuns(id),
    queryFn: () => evaluationsApi.list(id, { limit: LIST_LIMIT }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.some((run) => isActiveRun(run.status)) ? EVALUATION_POLL_MS : false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.testRuns(id) });

  const start = useMutation({
    mutationFn: (concurrency?: number) => evaluationsApi.start(id, concurrency ? { concurrency } : {}),
    onSuccess: refresh,
    onError: (error) => toast.error(EVALUATION_TEXTS.couldNotStart, errorMessage(error)),
  });
  const stop = useMutation({
    mutationFn: (runId: string) => evaluationsApi.cancel(id, runId),
    onSuccess: refresh,
    onError: (error) => toast.error("Couldn't stop the test run", errorMessage(error)),
  });

  const removeRun = async (run: TestRunDto) => {
    const ok = await confirmDialog({
      title: 'Delete test run',
      description: `Are you sure you want to delete the run from ${formatDateTime(run.runAt ?? run.createdAt)}? This action cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await evaluationsApi.remove(id, run.id);
      await refresh();
    } catch (error) {
      toast.error("Couldn't delete the test run", errorMessage(error));
    }
  };

  const list = runs.data ?? [];
  const active = list.find((run) => isActiveRun(run.status));
  const steps = setupSteps(workflow.data?.nodes ?? [], list.length > 0);
  const showGuide = workflow.isSuccess && (!steps.trigger || list.length === 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8" data-workflow-id={id}>
      <header className="flex flex-col gap-3">
        <Link
          to={`/workflow/${encodeURIComponent(id)}`}
          className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to {workflow.data?.name ?? 'the workflow'}
        </Link>
        <h1 className="text-xl font-semibold">Evaluations</h1>
        <p className="text-sm text-ink-2">
          Run the workflow against every row of a dataset and compare the scores between runs.
        </p>
        <RunControls
          canWrite={canWrite}
          blockedReason={
            workflow.isSuccess && !steps.trigger
              ? 'Add an Evaluation Trigger to the workflow to run a test.'
              : null
          }
          running={Boolean(active)}
          starting={start.isPending}
          stopping={stop.isPending}
          onStart={(concurrency) => start.mutate(concurrency)}
          onStop={() => active && stop.mutate(active.id)}
        />
      </header>

      {(workflow.isPending || runs.isPending) && !workflow.isError && !runs.isError && <PageLoader />}
      {(workflow.isError || runs.isError) && (
        <Callout tone="err" title="Couldn't load the evaluations">
          {errorMessage(workflow.error ?? runs.error)}
        </Callout>
      )}

      {showGuide && <SetupGuide steps={steps} workflowId={id} />}

      {list.length > 0 && (
        <>
          <MetricsChart runs={list} />
          <section aria-labelledby="eval-runs" className="flex flex-col gap-3">
            <h2 id="eval-runs" className="font-display text-md font-semibold text-ink">
              Test runs
            </h2>
            <RunsTable
              runs={list}
              workflowId={id}
              canWrite={canWrite}
              onStop={(run) => stop.mutate(run.id)}
              onDelete={(run) => void removeRun(run)}
            />
          </section>
        </>
      )}
    </div>
  );
}
