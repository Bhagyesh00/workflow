/**
 * Nodes whose run data is stale (P3-06): dirtyNodesFromDiff(ranDefinition, current, runData),
 * keyed by node name. Feeds the canvas badge (FlowCanvas dirtyNodes) and the output banner.
 * Undoing a change makes the graph equal to the one that ran again, so the mark goes away.
 */
import { type DirtyReason, dirtyNodesFromDiff } from '@workflow/workflow';
import { useMemo, useRef } from 'react';
import { useRunStore } from '../../stores/run-store';
import { useWorkflowStore } from '../../stores/workflow-store';

const NONE: Record<string, DirtyReason> = Object.freeze({}) as Record<string, DirtyReason>;

function sameMarks(a: Record<string, DirtyReason>, b: Record<string, DirtyReason>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function useDirtyNodes(): Record<string, DirtyReason> {
  const ran = useRunStore((s) => s.ranDefinition);
  const runData = useRunStore((s) => s.runData);
  const runWorkflowId = useRunStore((s) => s.workflowId);
  const workflowId = useWorkflowStore((s) => s.meta.id);
  const name = useWorkflowStore((s) => s.meta.name);
  const nodes = useWorkflowStore((s) => s.nodes);
  const connections = useWorkflowStore((s) => s.connections);
  const pinData = useWorkflowStore((s) => s.pinData);
  const previous = useRef<Record<string, DirtyReason>>(NONE);

  return useMemo(() => {
    let next = NONE;
    const sameWorkflow = !runWorkflowId || !workflowId || runWorkflowId === workflowId;
    if (ran && sameWorkflow && Object.keys(runData).length) {
      const marks = dirtyNodesFromDiff(ran, { name, nodes, connections, pinData }, runData);
      if (Object.keys(marks).length) next = marks;
    }
    // keep the same object while the marks are unchanged, so the canvas does not rebuild its elements
    if (next !== NONE && sameMarks(next, previous.current)) return previous.current;
    previous.current = next;
    return next;
  }, [ran, runData, runWorkflowId, workflowId, name, nodes, connections, pinData]);
}
