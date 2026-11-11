/**
 * P6-57 (L13): `/insights/:insightType?` (`insights:list`): tiles, range picker, project filter, chart
 * and the workflow table. Reads the route param itself (the type of the chart, `total` when it is missing or
 * unknown). Owner and admin; anyone else sees a plain "no access" note (the server answers 403 too).
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/client';
import { insightsApi } from '../api/endpoints';
import {
  queryKeys,
  useInsightsByTime,
  useInsightsByWorkflow,
  useInsightsSummary,
  useMe,
  useProjects,
} from '../api/queries';
import type {
  InsightsByWorkflowQuery,
  InsightsDateRangeKey,
  InsightsGranularity,
  InsightsQuery,
  InsightsSettings,
  InsightsSummaryType,
} from '../api/types';
import { InsightsChart } from '../components/insights/InsightsChart';
import { RangeAlert } from '../components/insights/RangeAlert';
import { RANGE_DAYS, RangePicker } from '../components/insights/RangePicker';
import { INSIGHTS_TILES, MANUAL_RUNS_HINT, SummaryStrip } from '../components/insights/SummaryStrip';
import { WorkflowTable } from '../components/insights/WorkflowTable';
import { Select } from '../components/ui/Field';
import { Callout, EmptyState, PageLoader, Spinner } from '../components/ui/misc';
import { usePermissions } from '../lib/permissions';

const DAY_MS = 24 * 3_600_000;

/** what the picker offers until the server's list arrives (the same seven presets) */
const FALLBACK_RANGES: InsightsSettings['dateRanges'] = (
  Object.keys(RANGE_DAYS) as InsightsDateRangeKey[]
).map((key) => ({
  key,
  licensed: true,
  granularity: RANGE_DAYS[key] <= 1 ? 'hour' : RANGE_DAYS[key] <= 30 ? 'day' : 'week',
}));

const isType = (value: string | undefined): value is InsightsSummaryType =>
  INSIGHTS_TILES.some((tile) => tile.type === value);

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function InsightsPage() {
  const params = useParams();
  const type: InsightsSummaryType = isType(params.insightType) ? params.insightType : 'total';
  const me = useMe();
  const { can } = usePermissions();
  const allowed = can('insights:list');

  const [range, setRange] = useState<InsightsDateRangeKey>('week');
  // the end of the range is fixed when the range or project changes, so each read has one stable query
  const [anchor, setAnchor] = useState(() => Date.now());
  const [projectId, setProjectId] = useState('');
  const [sortBy, setSortBy] = useState<NonNullable<InsightsByWorkflowQuery['sortBy']>>('total:desc');
  const [skip, setSkip] = useState(0);
  const [take, setTake] = useState(10);

  const query: InsightsQuery = {
    startDate: new Date(anchor - RANGE_DAYS[range] * DAY_MS).toISOString(),
    endDate: new Date(anchor).toISOString(),
    ...(projectId ? { projectId } : {}),
    ...(timeZone() ? { timeZone: timeZone() } : {}),
  };

  const settings = useQuery({
    queryKey: queryKeys.insightsSettings,
    queryFn: insightsApi.settings,
    enabled: allowed,
  });
  const projects = useProjects(allowed);
  const summary = useInsightsSummary(query, allowed);
  const series = useInsightsByTime(query, allowed, type === 'timeSaved');
  const workflows = useInsightsByWorkflow({ ...query, sortBy, skip, take }, allowed);

  if (me.isPending) return <PageLoader />;
  if (!allowed) {
    return (
      <div className="mx-auto max-w-6xl px-6 py-8">
        <EmptyState
          title="You don't have access to Insights"
          description="Ask an owner or an admin to open it for you."
        />
      </div>
    );
  }

  const ranges = settings.data?.dateRanges ?? FALLBACK_RANGES;
  const granularity: InsightsGranularity =
    ranges.find((r) => r.key === range)?.granularity ??
    (RANGE_DAYS[range] <= 1 ? 'hour' : RANGE_DAYS[range] <= 30 ? 'day' : 'week');

  const reset = () => {
    setAnchor(Date.now());
    setSkip(0);
  };
  const failure = [summary, series, workflows].find((q) => q.isError)?.error;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 py-8">
      <header className="flex flex-wrap items-end gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-semibold">Insights</h1>
          <p className="mt-1 text-sm text-ink-2">How your production workflows run. {MANUAL_RUNS_HINT}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              reset();
            }}
          >
            <option value="">All projects</option>
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <RangePicker
            value={range}
            ranges={ranges}
            onChange={(next) => {
              setRange(next);
              reset();
            }}
          />
        </div>
      </header>

      <RangeAlert range={range} earliestDataDate={settings.data?.earliestDataDate ?? null} />

      {failure !== undefined && (
        <Callout tone="err" title="Couldn't load Insights">
          {errorMessage(failure)}
        </Callout>
      )}

      <SummaryStrip
        summary={summary.data}
        loading={summary.isPending}
        active={type}
        linkTo={(next) => `/insights/${next}`}
      />

      {series.data ? (
        <InsightsChart type={type} data={series.data} granularity={granularity} />
      ) : (
        series.isPending && (
          <div className="grid h-48 place-items-center rounded-xl border border-line bg-surface">
            <Spinner />
          </div>
        )
      )}

      <section className="flex flex-col gap-2" aria-label="By workflow">
        <h2 className="text-md font-semibold">By workflow</h2>
        <WorkflowTable
          page={workflows.data}
          loading={workflows.isPending}
          sortBy={sortBy}
          onSortChange={(next) => {
            setSortBy(next);
            setSkip(0);
          }}
          skip={skip}
          take={take}
          onPageChange={(nextSkip, nextTake) => {
            setSkip(nextSkip);
            setTake(nextTake);
          }}
        />
      </section>
    </div>
  );
}
