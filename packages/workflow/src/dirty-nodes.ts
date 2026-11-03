/**
 * Dirty node detection (P3-06), as n8n's node dirtiness: compares the definition that produced the run data with
 * the current one (diffWorkflows). Only nodes with run data can be dirty. Moves, renames, notes and colour do not
 * count.
 *
 * C0 STUB: lane L6 writes the body.
 */
import type { RunData, WorkflowDefinition } from './interfaces';

/** parameters: own fields changed; connections: inputs changed; pinned: pin data changed; upstream: a sub-node or loop member is dirty */
export type DirtyReason = 'parameters' | 'connections' | 'pinned' | 'upstream';

/** dirty nodes of `current`, keyed by node name (current names) */
export function dirtyNodesFromDiff(
  _ran: WorkflowDefinition,
  _current: WorkflowDefinition,
  _runData: RunData,
): Record<string, DirtyReason> {
  throw new Error('not implemented (L6)');
}
