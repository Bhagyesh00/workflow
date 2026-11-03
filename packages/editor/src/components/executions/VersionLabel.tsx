/**
 * The version an execution row ran on (P3-10): name, else the short id (also for a version that
 * was pruned from the history); nothing for runs without a version (unsaved editor runs, old runs).
 */
import { useQuery } from '@tanstack/react-query';
import { GitCommitHorizontal } from 'lucide-react';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { VersionSummary } from '../../api/types';

/** the newest versions of a workflow (one request per workflow, shared by every row) */
export const VERSION_LOOKUP_LIMIT = 250;

export function useWorkflowVersions(workflowId: string | null | undefined) {
  return useQuery({
    queryKey: [...queryKeys.versions(workflowId ?? 'none'), 'lookup'],
    queryFn: async () => (await workflowsApi.versions(workflowId!, { limit: VERSION_LOOKUP_LIMIT })).data,
    enabled: Boolean(workflowId),
    staleTime: 30_000,
  });
}

/** the name of `versionId`, else its first 8 characters */
export function versionName(versions: VersionSummary[] | undefined, versionId: string): string {
  return versions?.find((v) => v.versionId === versionId)?.versionName ?? versionId.slice(0, 8);
}

export function VersionLabel({ workflowId, versionId }: { workflowId: string; versionId: string | null }) {
  const versions = useWorkflowVersions(versionId ? workflowId : null);
  if (!versionId) return null;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate text-2xs text-ink-3"
      title={`Version ${versionId}`}
    >
      <GitCommitHorizontal size={11} aria-hidden="true" />
      <span className="sr-only">Version </span>
      {versionName(versions.data, versionId)}
    </span>
  );
}
