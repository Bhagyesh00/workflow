/**
 * P6-57 (L13): the workspace's last 7 days on the Overview (ProjectLayout, kind "home"), for callers
 * with `insights:list`. A tile opens its chart on the Insights page. It shows nothing for anyone else, and
 * nothing while the read fails (the Overview does not depend on it).
 */
import { useState } from 'react';
import { useInsightsSummary } from '../../api/queries';
import { usePermissions } from '../../lib/permissions';
import { SummaryStrip } from './SummaryStrip';

const WEEK_MS = 7 * 24 * 3_600_000;

export function InsightsSummaryStrip() {
  const { can } = usePermissions();
  const allowed = can('insights:list');
  const [end] = useState(() => Date.now());
  const summary = useInsightsSummary(
    { startDate: new Date(end - WEEK_MS).toISOString(), endDate: new Date(end).toISOString() },
    allowed,
  );
  if (!allowed || summary.isError) return null;
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pt-2" aria-label="Last 7 days">
      <h2 className="mb-2 text-sm font-medium text-ink-2">Last 7 days</h2>
      <SummaryStrip
        summary={summary.data}
        loading={summary.isPending}
        linkTo={(type) => `/insights/${type}`}
      />
    </section>
  );
}
