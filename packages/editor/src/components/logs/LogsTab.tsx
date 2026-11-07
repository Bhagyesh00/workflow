/**
 * "Logs" tab of the log panel (P5-60): the run as a tree of node runs with sub-node runs (model,
 * tools, memory) nested under their parent, tokens summed up the tree, and the details of the
 * selected run.
 * C0 stub: L4 fills it (logs-tree.ts, LogsTree, LogDetails, pop-out). It renders, never throws,
 * because it is the panel's default tab.
 */
import type { RunData } from '@workflow/workflow';
import { EmptyState } from '../ui/misc';

export interface LogsTabProps {
  runData: RunData;
  onFocusNode: (name: string) => void;
}

export function LogsTab({ runData }: LogsTabProps) {
  const hasRun = Object.keys(runData).length > 0;
  return (
    <EmptyState
      title={hasRun ? 'Run logs' : 'No run yet'}
      description="Execute the workflow to see each node's run here."
      className="py-8"
    />
  );
}
