/** Storage warning in the panel of a Data Table node (P4-05), as n8n's NodeStorageLimitCallout. */
import { Callout } from '../ui/misc';
import { storageUsage, useDataTableLimits } from './StorageBanner';

export function NodeStorageCallout() {
  const { data } = useDataTableLimits();
  if (!data || data.quotaStatus === 'ok') return null;
  const usage = storageUsage(data);
  return data.quotaStatus === 'warn' ? (
    <Callout tone="warn" title="Data tables storage is nearly full">
      {usage} used. This node fails once it is full.
    </Callout>
  ) : (
    <Callout tone="err" title="Data tables storage is full">
      {usage} used. This node can't write until you delete some rows or tables.
    </Callout>
  );
}
