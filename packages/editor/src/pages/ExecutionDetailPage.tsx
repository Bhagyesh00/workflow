/** One execution on a read-only canvas, with node details, retry, stop and delete. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ArrowLeft, Bug, ExternalLink, RotateCcw, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { errorMessage, isApiError } from '../api/client';
import { executionsApi } from '../api/endpoints';
import { queryKeys, useNodeTypes } from '../api/queries';
import { readOnlyActions } from '../components/canvas/actions';
import { FlowCanvas } from '../components/canvas/FlowCanvas';
import { ExecutionAnnotationPanel } from '../components/executions/ExecutionAnnotationPanel';
import { RanOnVersion } from '../components/executions/RanOnVersion';
import { NodeDetailsView } from '../components/ndv/NodeDetailsView';
import { Button } from '../components/ui/Button';
import { Menu } from '../components/ui/Menu';
import { Callout, EmptyState, PageLoader, StatusBadge } from '../components/ui/misc';
import {
  debugExecution,
  deleteExecution,
  retryExecution,
  stopExecution,
} from '../features/executions/execution-commands';
import { formatDateTime, formatDuration } from '../lib/format';
import { usePermissions } from '../lib/permissions';
import { useRunStore } from '../stores/run-store';
import { useUiStore } from '../stores/ui-store';
import { useWorkflowStore } from '../stores/workflow-store';

export function ExecutionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nodeTypes = useNodeTypes();
  const { can } = usePermissions();
  const ndvNode = useUiStore((s) => s.ndvNode);
  const openNdv = useUiStore((s) => s.openNdv);
  const execution = useQuery({
    queryKey: queryKeys.execution(id),
    queryFn: () => executionsApi.get(id),
    retry: false,
    refetchInterval: (q) =>
      ['running', 'waiting', 'new'].includes(q.state.data?.status ?? '') ? 2000 : false,
  });

  useEffect(() => {
    const data = execution.data;
    if (!data) return;
    useWorkflowStore.getState().load(
      {
        id: data.workflowData.id ?? data.workflowId,
        name: data.workflowData.name,
        nodes: data.workflowData.nodes,
        connections: data.workflowData.connections,
        settings: data.workflowData.settings,
        pinData: data.workflowData.pinData,
        stickyNotes: data.workflowData.stickyNotes,
        nodeGroups: data.workflowData.nodeGroups,
      },
      { readOnly: true },
    );
    useRunStore.getState().loadExecution(data);
  }, [execution.data]);

  useEffect(
    () => () => {
      useWorkflowStore.getState().reset();
      useRunStore.getState().reset();
      useUiStore.getState().openNdv(null);
    },
    [],
  );

  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const pinData = useWorkflowStore((s) => s.pinData);
  const stickyNotes = useWorkflowStore((s) => s.stickyNotes);
  const nodeGroups = useWorkflowStore((s) => s.nodeGroups);
  const loadCount = useWorkflowStore((s) => s.loadCount);
  const runData = useRunStore((s) => s.runData);
  const graph = useMemo(
    () => ({ nodes, connections, pinData, stickyNotes, nodeGroups }),
    [nodes, connections, pinData, stickyNotes, nodeGroups],
  );
  const actions = useMemo(() => readOnlyActions((name) => openNdv(name)), [openNdv]);
  const commandDeps = useMemo(() => ({ navigate, queryClient }), [navigate, queryClient]);

  const retry = useMutation({
    mutationFn: (useCurrentWorkflow: boolean) => retryExecution(id, useCurrentWorkflow, commandDeps),
  });
  const stop = useMutation({ mutationFn: () => stopExecution(id, commandDeps) });
  const remove = () => deleteExecution(id, commandDeps);

  if (execution.isLoading || nodeTypes.isLoading) return <PageLoader label="Loading execution" />;
  if (execution.error || !execution.data) {
    return (
      <EmptyState
        className="h-full"
        title={isApiError(execution.error, 404) ? 'Execution not found' : 'Could not load the execution'}
        description={
          isApiError(execution.error, 404)
            ? 'It may have been deleted or pruned.'
            : errorMessage(execution.error)
        }
        action={<Button onClick={() => navigate('/home/executions')}>Back to executions</Button>}
      />
    );
  }
  const data = execution.data;
  const finished = !['running', 'waiting', 'new'].includes(data.status);
  // retry and stop need `workflow:execute` and delete `execution:delete`, by the execution's own scopes
  const canRun = can('workflow:execute', data);
  const canDelete = can('execution:delete', data);
  const retryable = ['error', 'crashed', 'canceled'].includes(data.status);
  const error = data.state?.resultData?.error;
  const canResume = Boolean(data.state?.executionData?.failedExecuteData);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <Link
          to="/home/executions"
          aria-label="Back to executions"
          className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-3 hover:text-ink"
        >
          <ArrowLeft size={16} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg font-semibold">{data.workflowName}</p>
          <p className="text-xs text-ink-3">
            Started {formatDateTime(data.startedAt)}, took {formatDuration(data.durationMs)}
          </p>
          <RanOnVersion execution={data} />
        </div>
        <StatusBadge status={data.status} />
        <Button
          size="sm"
          icon={<ExternalLink size={13} />}
          onClick={() => navigate(`/workflow/${encodeURIComponent(data.workflowId)}`)}
        >
          Open workflow
        </Button>
        <Button
          size="sm"
          icon={<Bug size={13} />}
          title="Open the workflow with this run's trigger data pinned"
          onClick={() => debugExecution(data.workflowId, data.id, { navigate })}
        >
          Debug in editor
        </Button>
        {retryable && canRun && (
          <Menu
            trigger={(t) => (
              <Button
                size="sm"
                variant="primary"
                icon={<RotateCcw size={13} />}
                onClick={t.toggle}
                aria-expanded={t['aria-expanded']}
                aria-haspopup="menu"
                loading={retry.isPending}
              >
                {canResume ? 'Retry from failed node' : 'Retry'}
              </Button>
            )}
            items={[
              { key: 'original', label: 'With the workflow as it ran', onSelect: () => retry.mutate(false) },
              {
                key: 'current',
                label: 'With the current saved workflow',
                onSelect: () => retry.mutate(true),
              },
            ]}
          />
        )}
        {!finished && canRun && (
          <Button
            size="sm"
            variant="danger"
            icon={<Square size={12} />}
            onClick={() => stop.mutate()}
            loading={stop.isPending}
          >
            Stop
          </Button>
        )}
        {canDelete && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 size={13} />}
            onClick={() => void remove()}
            aria-label="Delete execution"
          >
            Delete
          </Button>
        )}
      </header>
      {error && (
        <Callout
          tone="err"
          className="m-3 mb-0"
          title={error.node ? `${error.node}: ${error.message}` : error.message}
        >
          {error.hint && <p>{error.hint}</p>}
          {error.code && <p className="mt-1 font-mono text-xs">{error.code}</p>}
        </Callout>
      )}
      <ExecutionAnnotationPanel execution={data} />
      <div className="relative min-h-0 flex-1">
        <ReactFlowProvider>
          <FlowCanvas
            graph={graph}
            descriptions={nodeTypes}
            runData={runData}
            runningNodes={[]}
            selection={{ nodes: [], stickies: [], edges: [] }}
            readOnly
            actions={actions}
            fitKey={loadCount}
          />
        </ReactFlowProvider>
      </div>
      {ndvNode && <NodeDetailsView nodeName={ndvNode} readOnly onClose={() => openNdv(null)} />}
    </div>
  );
}
