/**
 * P6-84 (L16): `/settings/usage`, for every signed-in user: active workflows against the limit and this
 * month's runs (`Settings.usage`).
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { settingsApi } from '../api/endpoints';
import { queryKeys } from '../api/queries';
import { PageLoader } from '../components/ui/misc';

export function UsagePage(): ReactNode {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: settingsApi.get,
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (isLoading) return <PageLoader />;
  const usage = data?.usage;
  const raw = data?.limits?.activeWorkflows;
  const limit = typeof raw === 'number' ? raw : null;
  const active = usage?.activeWorkflows ?? 0;
  const pct = limit ? Math.min(100, Math.round((active / limit) * 100)) : 0;
  return (
    <div className="flex max-w-xl flex-col gap-5">
      <h2 className="text-lg font-semibold">Usage</h2>
      <section className="rounded-lg border border-line p-4" aria-label="Active workflows">
        <div className="text-sm text-ink-2">Active workflows</div>
        <div className="mt-1 text-2xl font-semibold" data-testid="usage-active">
          {limit === null
            ? `${active} active workflows (unlimited)`
            : `${active} of ${limit} active workflows`}
        </div>
        {limit !== null && (
          <div
            className="mt-2 h-2 rounded bg-surface-2"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={limit}
            aria-valuenow={Math.min(active, limit)}
            aria-label="Active workflows used"
          >
            <div className="h-2 rounded bg-brand" style={{ width: `${pct}%` }} />
          </div>
        )}
      </section>
      <section className="rounded-lg border border-line p-4" aria-label="Runs this month">
        <div className="text-sm text-ink-2">Runs this month{usage ? ` (${usage.period})` : ''}</div>
        <div className="mt-1 text-2xl font-semibold" data-testid="usage-runs">
          {usage?.executions ?? 0} runs
        </div>
      </section>
    </div>
  );
}
