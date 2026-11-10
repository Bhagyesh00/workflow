/**
 * P6-50 (L5): NDV panel for a node whose type a policy blocks: "This node is restricted", with
 * "Replace node" (lib/replace-node.ts). Mounted by NodeDetailsView for every node; renders nothing
 * for an available type.
 */

import type { WorkflowNode } from '@workflow/workflow';
import type { ReactNode } from 'react';

export interface RestrictedNodePanelProps {
  /** the node open in the NDV */
  node: WorkflowNode;
}

/** stub (L5): renders nothing until L5 draws it */
export function RestrictedNodePanel(_props: RestrictedNodePanelProps): ReactNode {
  return null;
}
