/** Test one tool on its own: run the node a tool hangs from with the given arguments. L4 fills it. */
import type { DataObject, ExecuteData, Workflow, WorkflowNode } from '@workflow/workflow';
import type { ToolRunHost } from './node-as-tool';

/** `RunOptions.agentRequest` plus the two nodes the engine found for it */
export interface ToolExecutorRequest {
  query: DataObject;
  toolName: string;
  rootNode: string;
  toolNode: string;
}

export function toolRootOf(_workflow: Workflow, _toolNode: string): WorkflowNode {
  throw new Error('not implemented (L4)');
}

export async function runToolExecutor(
  _host: ToolRunHost,
  _request: ToolExecutorRequest,
  _rootExec: ExecuteData,
  _signal: AbortSignal,
  _closeFunctions: Array<() => Promise<void>>,
): Promise<void> {
  throw new Error('not implemented (L4)');
}
