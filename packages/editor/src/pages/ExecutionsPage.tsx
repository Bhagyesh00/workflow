/** Executions list with workflow/status filters and auto-refresh. */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ExecutionStatus } from '@workflow/workflow';
import { History, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { errorMessage } from '../api/client';
import { type ExecutionBulkFilter, executionsApi, workflowsApi } from '../api/endpoints';
import type { AnnotationVote } from '../api/types';
import { PrivateCredentialsMark } from '../components/credentials/PrivateCredentialSection';
import { AnnotationBadges } from '../components/executions/AnnotationBadges';
import { AnnotationFilters, type AnnotationFilterValue } from '../components/executions/AnnotationFilters';
import { BulkActionsBar } from '../components/executions/BulkActionsBar';
import { ExecutionFilterBar } from '../components/executions/ExecutionFilterBar';
import { VersionFilter } from '../components/executions/VersionFilter';
import { VersionLabel } from '../components/executions/VersionLabel';
import { useProjectListScope } from '../components/projects/ProjectFilter';
import { Button } from '../components/ui/Button';
import { Select, Switch, TextInput } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader, StatusBadge } from '../components/ui/misc';
import { formatDateTime, formatDuration, formatRelative } from '../lib/format';

const STATUSES: Array<{ value: ExecutionStatus | ''; label: string }> = [
  { value: '', label: 'Any status' },
  { value: 'success', label: 'Succeeded' },
  { value: 'error', label: 'Failed' },
  { value: 'running', label: 'Running' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'canceled', label: 'Stopped' },
  { value: 'crashed', label: 'Crashed' },
];

const MODE_LABELS: Record<string, string> = {
  manual: 'Manual',
  trigger: 'Trigger',
  webhook: 'Webhook',
  retry: 'Retry',
  integrated: 'Sub-workflow',
  internal: 'Internal',
  cli: 'CLI',
  evaluation: 'Evaluation',
  chat: 'Chat',
  error: 'Error workflow',
};

export function ExecutionsPage() {
  // a project's page lists that project's executions; Overview lists every project's
  const { projectId } = useProjectListScope('executions');
  const [params, setParams] = useSearchParams();
  const workflowId = params.get('workflowId') ?? '';
  const status = params.get('status') ?? '';
  // P3-09 annotation filters (comma-separated tag ids, all must match) and P3-10 version filter
  const annotationTags = (params.get('annotationTags') ?? '').split(',').filter(Boolean);
  const voteParam = params.get('vote');
  const vote: AnnotationVote | undefined = voteParam === 'up' || voteParam === 'down' ? voteParam : undefined;
  const workflowVersionId = params.get('workflowVersionId') ?? '';
  // P5-61 highlighted data filter: the key, a part of the value (the whole value when exact)
  const customDataKey = params.get('customDataKey') ?? '';
  const customDataValue = params.get('customDataValue') ?? '';
  const customDataExact = params.get('customDataExact') === 'true';
  // P6-85 start time range (ISO times)
  const startedAfter = params.get('startedAfter') ?? '';
  const startedBefore = params.get('startedBefore') ?? '';
  const [autoRefresh, setAutoRefresh] = useState(true);
  // P6-85 bulk actions: the picked runs, or every run matching the filters
  const [selected, setSelected] = useState<string[]>([]);
  const [allMatching, setAllMatching] = useState(false);
  const workflows = useQuery({
    queryKey: ['workflows', 'filter-options', projectId],
    queryFn: () => workflowsApi.list({ limit: 200, projectId: projectId ?? undefined }),
  });
  const query = useInfiniteQuery({
    queryKey: [
      'executions',
      {
        projectId,
        workflowId,
        status,
        annotationTags,
        vote,
        workflowVersionId,
        customDataKey,
        customDataValue,
        customDataExact,
        startedAfter,
        startedBefore,
      },
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      executionsApi.list({
        projectId: projectId ?? undefined,
        workflowId: workflowId || undefined,
        status: status || undefined,
        annotationTags: annotationTags.length ? annotationTags : undefined,
        vote,
        workflowVersionId: workflowVersionId || undefined,
        customDataKey: customDataKey || undefined,
        customDataValue: customDataKey && customDataValue ? customDataValue : undefined,
        customDataExact: customDataKey && customDataValue && customDataExact ? true : undefined,
        startedAfter: startedAfter || undefined,
        startedBefore: startedBefore || undefined,
        limit: 50,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: autoRefresh ? 5000 : false,
  });
  const executions = query.data?.pages.flatMap((p) => p.data) ?? [];
  // what a bulk action covers when it takes the whole filter: the list's own filter, no paging
  const bulkFilter: ExecutionBulkFilter = {
    projectId: projectId ?? undefined,
    workflowId: workflowId || undefined,
    status: status || undefined,
    annotationTags: annotationTags.length ? annotationTags : undefined,
    vote,
    workflowVersionId: workflowVersionId || undefined,
    customDataKey: customDataKey || undefined,
    customDataValue: customDataKey && customDataValue ? customDataValue : undefined,
    customDataExact: customDataKey && customDataValue && customDataExact ? true : undefined,
    startedAfter: startedAfter || undefined,
    startedBefore: startedBefore || undefined,
  };
  // a new filter is a new list: the picks and "all matching" no longer describe it
  const filterKey = JSON.stringify(bulkFilter);
  const [pickedFor, setPickedFor] = useState(filterKey);
  if (pickedFor !== filterKey) {
    setPickedFor(filterKey);
    setSelected([]);
    setAllMatching(false);
  }
  // "every run matching" stops at the newest listed run (as n8n): a run that starts after the list loaded stays
  // (a list of runs that have not started has no start to use: the time the list loaded)
  const newestStart = executions.reduce(
    (newest, e) => (e.startedAt && e.startedAt > newest ? e.startedAt : newest),
    '',
  );
  const deleteBefore = newestStart || new Date(query.dataUpdatedAt).toISOString();
  const pageIds = executions.map((e) => e.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  const toggleRow = (id: string, on: boolean) => {
    setAllMatching(false);
    setSelected((now) => (on ? [...new Set([...now, id])] : now.filter((x) => x !== id)));
  };
  const togglePage = (on: boolean) => {
    setAllMatching(false);
    setSelected(on ? pageIds : []);
  };
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const setAnnotationFilter = (value: AnnotationFilterValue) => {
    const next = new URLSearchParams(params);
    if (value.tags.length) next.set('annotationTags', value.tags.join(','));
    else next.delete('annotationTags');
    if (value.vote) next.set('vote', value.vote);
    else next.delete('vote');
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Executions</h1>
          <p className="mt-1 text-sm text-ink-2">Every run of every workflow, newest first.</p>
        </div>
        <span className="flex items-center gap-2 text-sm text-ink-2">
          <Switch label="Refresh automatically" checked={autoRefresh} onChange={setAutoRefresh} size="sm" />
          <span aria-hidden="true">Refresh automatically</span>
        </span>
        <Button
          icon={<RefreshCw size={14} />}
          onClick={() => void query.refetch()}
          loading={query.isRefetching && !autoRefresh}
        >
          Refresh
        </Button>
      </header>
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label="Filter by workflow"
          className="w-64"
          value={workflowId}
          onChange={(e) => {
            // a version belongs to one workflow
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('workflowId', e.target.value);
            else next.delete('workflowId');
            next.delete('workflowVersionId');
            setParams(next, { replace: true });
          }}
        >
          <option value="">All workflows</option>
          {(workflows.data?.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by status"
          className="w-44"
          value={status}
          onChange={(e) => setFilter('status', e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        {workflowId && (
          <VersionFilter
            workflowId={workflowId}
            value={workflowVersionId}
            onChange={(id) => setFilter('workflowVersionId', id)}
          />
        )}
        <AnnotationFilters value={{ tags: annotationTags, vote }} onChange={setAnnotationFilter} />
        <fieldset
          aria-label="Highlighted data"
          className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
        >
          <TextInput
            aria-label="Highlighted data key"
            className="w-36"
            placeholder="Highlighted key"
            maxLength={50}
            value={customDataKey}
            onChange={(e) => setFilter('customDataKey', e.target.value)}
          />
          <TextInput
            aria-label="Highlighted data value"
            className="w-36"
            placeholder="Value"
            maxLength={255}
            disabled={!customDataKey}
            value={customDataValue}
            onChange={(e) => setFilter('customDataValue', e.target.value)}
          />
          <span className="flex items-center gap-2 text-sm text-ink-2">
            <Switch
              label="Exact match"
              size="sm"
              disabled={!customDataKey}
              checked={customDataExact}
              onChange={(on) => setFilter('customDataExact', on ? 'true' : '')}
            />
            <span aria-hidden="true">Exact</span>
          </span>
        </fieldset>
        <ExecutionFilterBar
          value={{ startedAfter: startedAfter || undefined, startedBefore: startedBefore || undefined }}
          onChange={(next) => {
            const nextParams = new URLSearchParams(params);
            for (const key of ['startedAfter', 'startedBefore'] as const) {
              if (next[key]) nextParams.set(key, next[key]);
              else nextParams.delete(key);
            }
            setParams(nextParams, { replace: true });
          }}
        />
      </div>
      <BulkActionsBar
        selectedIds={selected}
        filter={bulkFilter}
        allMatching={allMatching}
        deleteBefore={deleteBefore}
        onClear={() => {
          setSelected([]);
          setAllMatching(false);
        }}
      />
      {allOnPage && query.hasNextPage && !allMatching && (
        <p className="-mt-3 text-sm text-ink-2">
          The {pageIds.length} runs on this page are selected.{' '}
          <button
            type="button"
            className="font-semibold text-brand hover:underline"
            onClick={() => setAllMatching(true)}
          >
            Select every run matching the filters
          </button>
        </p>
      )}
      <section
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
        aria-label="Execution list"
      >
        {query.isLoading ? (
          <PageLoader />
        ) : query.error ? (
          <Callout tone="err" className="m-4" title="Could not load executions">
            {errorMessage(query.error)}
          </Callout>
        ) : executions.length === 0 ? (
          <EmptyState
            icon={<History size={20} />}
            title="No executions yet"
            description="Runs appear here as soon as a workflow is executed, manually or by a trigger."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-ink-3">
              <tr>
                <th className="w-10 py-2.5 pl-5 font-semibold">
                  <input
                    type="checkbox"
                    aria-label="Select all runs on this page"
                    className="size-4 accent-[var(--wf-brand)]"
                    checked={allMatching || allOnPage}
                    onChange={(e) => togglePage(e.target.checked)}
                  />
                </th>
                <th className="px-3 py-2.5 font-semibold">Workflow</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Started</th>
                <th className="px-3 py-2.5 font-semibold">Duration</th>
                <th className="px-3 py-2.5 font-semibold">Mode</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((e) => (
                <tr key={e.id} className="border-t border-line hover:bg-surface-2">
                  <td className="w-10 py-3 pl-5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${e.workflowName}`}
                      className="size-4 accent-[var(--wf-brand)]"
                      checked={allMatching || selected.includes(e.id)}
                      onChange={(ev) => toggleRow(e.id, ev.target.checked)}
                    />
                  </td>
                  <td className="max-w-80 px-3 py-3">
                    <Link
                      to={`/executions/${encodeURIComponent(e.id)}`}
                      className="block truncate font-semibold text-ink hover:text-brand"
                    >
                      {e.workflowName}
                    </Link>
                    {e.errorMessage && (
                      <p className="truncate text-xs text-err" title={e.errorMessage}>
                        {e.errorMessage}
                      </p>
                    )}
                    <VersionLabel workflowId={e.workflowId} versionId={e.workflowVersionId} />
                    <AnnotationBadges annotation={e.annotation} />
                  </td>
                  <td className="px-3 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={e.status} />
                      {e.usedPrivateCredentials && (
                        <PrivateCredentialsMark label="Ran with the account of the user who started it" />
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-ink-2" title={formatDateTime(e.startedAt)}>
                    {formatRelative(e.startedAt)}
                  </td>
                  <td className="px-3 py-3 text-ink-2">{formatDuration(e.durationMs)}</td>
                  <td className="px-3 py-3 text-ink-2">{MODE_LABELS[e.mode] ?? e.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {query.hasNextPage && (
          <div className="p-3 text-center">
            <Button size="sm" onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Load more
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
