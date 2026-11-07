/**
 * "Logs" tab of the log panel (P5-60): the run as a tree of node runs with sub-node runs (model,
 * tools, memory) nested under their parent, tokens summed up the tree, and the details of the
 * selected run. A new run clears the selection.
 */
import type { RunData } from '@workflow/workflow';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration } from '../../lib/format';
import {
  buildLogsTree,
  findLogNode,
  formatTokens,
  type LogNode,
  totalTokens,
  visibleRows,
} from '../../lib/logs-tree';
import { useWorkflowStore } from '../../stores/workflow-store';
import { EmptyState, Spinner } from '../ui/misc';
import { LogDetails } from './LogDetails';
import { LogsTree } from './LogsTree';

export interface LogsTabProps {
  runData: RunData;
  onFocusNode: (name: string) => void;
}

/** a run is told apart by when its first node started; later nodes of the same run keep it */
function runKey(runData: RunData): string {
  let first = Number.POSITIVE_INFINITY;
  for (const runs of Object.values(runData)) for (const task of runs) first = Math.min(first, task.startTime);
  return Number.isFinite(first) ? String(first) : '';
}

export function LogsTab({ runData, onFocusNode }: LogsTabProps) {
  const connections = useWorkflowStore((s) => s.connections);
  const roots = useMemo(() => buildLogsTree(runData, connections), [runData, connections]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = useMemo(() => visibleRows(roots, collapsed), [roots, collapsed]);
  const key = runKey(runData);
  const lastKey = useRef(key);

  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    setSelectedId(null);
    setCollapsed(new Set());
  }, [key]);

  if (roots.length === 0) {
    return (
      <EmptyState
        title="No run yet"
        description="Execute the workflow to see each node's run here."
        className="py-8"
      />
    );
  }

  const selected = findLogNode(roots, selectedId);
  const tokens = formatTokens(totalTokens(roots));
  const running = rows.some((r) => r.node.status === 'running');
  const all = flatten(roots);
  const runs = all.length;
  const span = Math.max(...all.map((n) => n.start + n.duration)) - Math.min(...all.map((n) => n.start));

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[40%] min-w-52 shrink-0 flex-col border-r border-line">
        <p className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-3">
          {running && <Spinner size={12} />}
          <span>{running ? 'Running' : `${runs} ${runs === 1 ? 'run' : 'runs'}`}</span>
          {span > 0 && !running && <span>{formatDuration(span)}</span>}
          {tokens && <span>{tokens}</span>}
        </p>
        <div className="wf-scroll min-h-0 flex-1 overflow-auto">
          <LogsTree
            rows={rows}
            collapsed={collapsed}
            onToggle={toggle}
            selectedId={selected?.id ?? null}
            onSelect={(node: LogNode) => setSelectedId(node.id)}
            onFocusNode={onFocusNode}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <LogDetails key={selected.id} node={selected} runData={runData} />
        ) : (
          <EmptyState
            title="Select a node run"
            description="Its input and output show here."
            className="py-8"
          />
        )}
      </div>
    </div>
  );
}

function flatten(nodes: LogNode[]): LogNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
