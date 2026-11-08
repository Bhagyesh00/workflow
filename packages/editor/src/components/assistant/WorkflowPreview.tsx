/**
 * P5-67 (L2): a saved workflow as a read-only canvas, as `VersionPreview` (VersionsPanel.tsx), with Open.
 */
import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router';
import { errorMessage } from '../../api/client';
import { workflowsApi } from '../../api/endpoints';
import { queryKeys, useNodeTypes } from '../../api/queries';
import { readOnlyActions } from '../canvas/actions';
import { FlowCanvas } from '../canvas/FlowCanvas';
import { Callout, PageLoader } from '../ui/misc';

export interface WorkflowPreviewProps {
  workflowId: string;
}

export function WorkflowPreview({ workflowId }: WorkflowPreviewProps) {
  const nodeTypes = useNodeTypes();
  const workflow = useQuery({
    queryKey: [...queryKeys.assistant, 'preview', 'workflow', workflowId],
    queryFn: () => workflowsApi.get(workflowId),
  });
  if (workflow.isPending) return <PageLoader label="Loading the workflow" />;
  if (workflow.isError) {
    return <Callout tone="err">{`Couldn't load the workflow. ${errorMessage(workflow.error)}`}</Callout>;
  }
  const data = workflow.data;
  return (
    <section className="flex h-full min-h-0 flex-col gap-3" aria-label={`Preview of ${data.name}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-md font-semibold">{data.name}</p>
          <p className="text-sm text-ink-2">
            {data.nodes.length} node{data.nodes.length === 1 ? '' : 's'} · Read only
          </p>
        </div>
        <Link
          to={`/workflow/${encodeURIComponent(data.id)}`}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3.5 text-sm font-semibold text-ink hover:border-line-strong hover:bg-surface-2"
        >
          <ExternalLink size={14} aria-hidden />
          Open
        </Link>
      </div>
      <div
        className="min-h-[50vh] flex-1 overflow-hidden rounded-xl border border-line"
        data-testid="workflow-preview"
      >
        <ReactFlowProvider>
          <FlowCanvas
            graph={{
              nodes: data.nodes,
              connections: data.connections,
              pinData: {},
              stickyNotes: data.stickyNotes ?? [],
              nodeGroups: data.nodeGroups ?? [],
            }}
            descriptions={nodeTypes}
            runData={{}}
            runningNodes={[]}
            selection={{ nodes: [], stickies: [], edges: [] }}
            readOnly
            actions={readOnlyActions(() => undefined)}
            fitKey={data.id}
            minimap={false}
          />
        </ReactFlowProvider>
      </div>
    </section>
  );
}
