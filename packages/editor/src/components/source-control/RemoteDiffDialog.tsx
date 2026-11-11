/**
 * P6-76 (L6): a workflow's local version against the remote one (`sourceControlApi.remoteContent`), through
 * `diffWorkflows` from the workflow package and `WorkflowDiffSummary`.
 */
import type { ReactNode } from 'react';
import type { SourceControlledFile } from '../../api/types';

export interface RemoteDiffDialogProps {
  /** the status row of a workflow file; open while set */
  file: SourceControlledFile | null;
  onClose(): void;
}

/** stub (L6): renders nothing until L6 draws it */
export function RemoteDiffDialog(_props: RemoteDiffDialogProps): ReactNode {
  return null;
}
