/**
 * Any node as an agent tool. `ToolRunHost` is what the engine lends the tool code: `createNodeAsTool`,
 * `createHitlGate` and `runToolExecutor` all run against it. L2 fills `createNodeAsTool`.
 */
import type {
  AiTool,
  ConnectionType,
  DataObject,
  ExecuteData,
  ExecutionState,
  ExpressionEvaluator,
  NodeType,
  Workflow,
  WorkflowNode,
} from '@workflow/workflow';
import type { ContextDeps } from './node-context';
import type { ExecutionServices } from './services';

export interface ToolRunHost {
  readonly workflow: Workflow;
  readonly services: ExecutionServices;
  readonly evaluator: ExpressionEvaluator;
  readonly state: ExecutionState;
  contextDeps(node: WorkflowNode, exec: ExecuteData, runIndex: number, signal: AbortSignal): ContextDeps;
  supplySubNodes(
    parent: WorkflowNode,
    parentType: NodeType,
    type: ConnectionType,
    itemIndex: number,
    exec: ExecuteData,
    signal: AbortSignal,
    closeFunctions: Array<() => Promise<void>>,
  ): Promise<unknown>;
  logSubNodeRun(
    sub: WorkflowNode,
    parent: WorkflowNode,
    type: ConnectionType,
    input: DataObject,
    output: DataObject,
    error?: Error,
  ): void;
}

export function createNodeAsTool(
  _host: ToolRunHost,
  _tool: WorkflowNode,
  _toolType: NodeType,
  _parent: WorkflowNode,
  _parentExec: ExecuteData,
  _itemIndex: number,
  _signal: AbortSignal,
): AiTool {
  throw new Error('not implemented (L2)');
}
