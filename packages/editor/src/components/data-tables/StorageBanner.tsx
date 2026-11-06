/** Workspace storage warning above every page (P4-05), as n8n's storage limit banners. */
import { useQuery } from '@tanstack/react-query';
import { dataTablesApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { DataTableLimits } from '../../api/types';
import { Callout } from '../ui/misc';

const MEGABYTE = 1024 * 1024;

export function useDataTableLimits() {
  return useQuery({
    queryKey: queryKeys.dataTableLimits,
    queryFn: () => dataTablesApi.limits(),
    retry: false,
    staleTime: 30_000,
  });
}

/** "170 / 200 MB" */
export function storageUsage(limits: DataTableLimits): string {
  const used = Math.ceil(limits.totalBytes / MEGABYTE);
  return `${used} / ${Math.round(limits.maxBytes / MEGABYTE)} MB`;
}

export function DataTableStorageBanner() {
  const { data } = useDataTableLimits();
  if (!data || data.quotaStatus === 'ok') return null;
  const usage = storageUsage(data);
  if (data.quotaStatus === 'warn') {
    return (
      <Callout tone="warn" className="mx-4 mt-3">
        {usage} of data tables storage used. Delete rows or tables before it runs out, or workflows that
        write to them will fail.
      </Callout>
    );
  }
  return (
    <Callout tone="err" className="mx-4 mt-3">
      {usage} of data tables storage used. Workflows can't add rows until you delete some rows or tables.
    </Callout>
  );
}
