/**
 * Nodes whose run data is stale (P3-06): dirtyNodesFromDiff(ranDefinition, current, runData),
 * keyed by node name. Feeds the canvas badge (FlowCanvas dirtyNodes) and the output banner.
 *
 * C0 STUB: lane L6 writes it; returns no dirty nodes until then.
 */
import type { DirtyReason } from '@workflow/workflow';

const NONE: Record<string, DirtyReason> = Object.freeze({}) as Record<string, DirtyReason>;

export function useDirtyNodes(): Record<string, DirtyReason> {
  return NONE;
}
