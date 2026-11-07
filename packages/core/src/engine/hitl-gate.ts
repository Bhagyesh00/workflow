/** The human review gate on a tool: a send-and-wait node in front of the tools it guards. L5 fills it. */
import type { AiTool, ExecuteData, NodeType, WorkflowNode } from '@workflow/workflow';
import type { ToolRunHost } from './node-as-tool';

export async function createHitlGate(
  _host: ToolRunHost,
  _hitlNode: WorkflowNode,
  _hitlType: NodeType,
  _parent: WorkflowNode,
  _parentExec: ExecuteData,
  _itemIndex: number,
  _signal: AbortSignal,
  _closeFunctions: Array<() => Promise<void>>,
): Promise<AiTool[]> {
  throw new Error('not implemented (L5)');
}
