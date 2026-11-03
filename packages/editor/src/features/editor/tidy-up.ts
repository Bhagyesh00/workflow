/**
 * Tidy up (P3-03, as n8n): lay out the whole workflow, or the selected nodes, left to right with
 * @dagrejs/dagre (lib/auto-layout.ts), as one undo step (store.applyGraph), then fit the view (or
 * the selection's bounds). Connections never change.
 *
 * C0 STUB: lane L1 writes the body.
 */
import type { ReactFlowInstance } from '@xyflow/react';

/** a selection of 2+ nodes (and the stickies that ride along); omitted = the whole canvas */
export interface TidyUpTarget {
  nodes: string[];
  stickies?: string[];
}

export function tidyUp(_flow: ReactFlowInstance, _target?: TidyUpTarget): void {
  throw new Error('not implemented (L1)');
}
