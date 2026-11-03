/**
 * Replace a node (P3-11, as n8n useCanvasOperations replaceNode): the new node takes the old one's
 * position and the connections its type accepts (others are dropped), stays in the old node's group,
 * and the old node is removed. Refused (graph unchanged) when validateWorkflowNodeGroups on the
 * result is not empty. Other nodes' $('Old') references are not rewritten (as n8n).
 *
 * C0 STUB: lane L2 writes the body. features/editor/add-node.ts calls it while ui.replaceTarget is set
 * and applies the result as one undo step.
 */
import type { NodeDescriptionLookup, NodeTypeDescription, WorkflowNode } from '@workflow/workflow';
import type { WorkflowGraph } from './workflow-ops';

export type ReplaceNodeResult =
  | { graph: WorkflowGraph /** the new node's final name */; nodeName: string }
  /** the group's blocked message; nothing changes */
  | { error: string };

export function replaceNode(
  _graph: WorkflowGraph,
  _oldName: string,
  _replacement: WorkflowNode,
  _descriptions: { get(type: string): NodeTypeDescription | undefined },
  _types?: NodeDescriptionLookup,
): ReplaceNodeResult {
  throw new Error('not implemented (L2)');
}
