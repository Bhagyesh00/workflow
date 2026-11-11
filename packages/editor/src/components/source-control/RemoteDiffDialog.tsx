/**
 * P6-76 (L6): the difference between a workflow in this workspace and its copy on the remote branch. The remote
 * copy comes from GET /source-control/remote-content; `diffWorkflows` and `WorkflowDiffSummary` do the rest, so
 * there is no diff code of its own. A workflow that is not on the remote yet says so.
 */
import { useQuery } from '@tanstack/react-query';
import { diffWorkflows } from '@workflow/workflow';
import { useMemo } from 'react';
import { errorMessage, isApiError } from '../../api/client';
import { sourceControlApi, workflowsApi } from '../../api/endpoints';
import { queryKeys } from '../../api/queries';
import type { SourceControlledFile } from '../../api/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Callout, PageLoader } from '../ui/misc';
import { WorkflowDiffSummary } from '../workflow/WorkflowDiffSummary';

export interface RemoteDiffDialogProps {
  /** the status row of a workflow file; open while set */
  file: SourceControlledFile | null;
  onClose(): void;
}

function DiffBody({ file }: { file: SourceControlledFile }) {
  const isWorkflow = file.type === 'workflow';
  const remote = useQuery({
    queryKey: [...queryKeys.sourceControl, 'remote-content', file.id],
    queryFn: () => sourceControlApi.remoteContent('workflow', file.id),
    enabled: isWorkflow,
    retry: false,
    staleTime: 0,
  });
  const local = useQuery({
    queryKey: [...queryKeys.sourceControl, 'local-workflow', file.id],
    queryFn: () => workflowsApi.get(file.id),
    enabled: isWorkflow,
    retry: false,
    staleTime: 0,
  });
  const diff = useMemo(
    () =>
      remote.data && local.data
        ? diffWorkflows(remote.data, {
            name: local.data.name,
            nodes: local.data.nodes,
            connections: local.data.connections,
            settings: local.data.settings ?? {},
          })
        : null,
    [remote.data, local.data],
  );

  if (!isWorkflow) return <p className="text-sm text-ink-2">A diff is only shown for workflows.</p>;
  if (remote.isLoading || local.isLoading) return <PageLoader label="Reading the remote copy" />;
  if (isApiError(remote.error, 404))
    return <p className="text-sm text-ink-2">This workflow is not on the remote yet. A push adds it.</p>;
  if (remote.error) return <Callout tone="err">{errorMessage(remote.error)}</Callout>;
  if (local.error) return <Callout tone="err">{errorMessage(local.error)}</Callout>;
  if (!diff) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-2">
        What this workspace's version changes compared with the remote copy.
      </p>
      <WorkflowDiffSummary diff={diff} label="Local changes compared with the remote" />
    </div>
  );
}

export function RemoteDiffDialog({ file, onClose }: RemoteDiffDialogProps) {
  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      title={file ? `Diff: ${file.name}` : ''}
      size="md"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {file && <DiffBody file={file} />}
    </Dialog>
  );
}
