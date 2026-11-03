/**
 * "Ran on version" on the execution detail page (P3-10): the version name, else the short id (also
 * for a version pruned from the history). The link opens the workflow with its version history.
 */
import { Link } from 'react-router';
import type { ExecutionDetail } from '../../api/types';
import { useUiStore } from '../../stores/ui-store';
import { useWorkflowVersions, versionName } from './VersionLabel';

export function RanOnVersion({ execution }: { execution: ExecutionDetail }) {
  const versionId = execution.workflowVersionId;
  const versions = useWorkflowVersions(versionId ? execution.workflowId : null);
  if (!versionId) return null;
  return (
    <p className="text-xs text-ink-3">
      Ran on version{' '}
      <Link
        to={`/workflow/${encodeURIComponent(execution.workflowId)}`}
        onClick={() => useUiStore.getState().setSidePanel('versions')}
        className="font-semibold text-ink-2 hover:text-brand"
        title={`Open the version history (version ${versionId})`}
      >
        {versionName(versions.data, versionId)}
      </Link>
    </p>
  );
}
