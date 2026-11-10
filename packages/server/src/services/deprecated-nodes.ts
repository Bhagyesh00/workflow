/**
 * P6-52 (L7): with `DEPRECATED_NODES_BLOCK` on (default), a save may not add or edit a node whose type
 * description has `deprecated: true` (400, `details.violations` of kind `node-type-deprecated`, n8n's text
 * "Cannot use a "<type>" node ("<name>"): this node type is deprecated. Replace it with the <X> node or
 * remove it from the workflow."). An edit is any difference from the stored node of the same id other than
 * its position. Removal is allowed and a saved one runs; an inline sub-workflow or an Assistant single node
 * with one fails (`assertNoDeprecatedNodes`).
 * Stub from C0: both PASS until L7, because saves and runs call them today.
 */
import type { WorkflowNode } from '@workflow/workflow';
import type { ServiceDeps } from '../context';

/** one refused node in a 400 answer (`details.violations`) */
export interface DeprecatedNodeViolation {
  kind: 'node-type-deprecated';
  type: string;
  nodeName: string;
  /** the description's `replacedBy`, when it names one */
  replacedBy?: string;
}

/** the nodes a save carries (a `WorkflowDefinition` or a stored row fits) */
export interface DeprecatedCheckWorkflow {
  nodes: readonly WorkflowNode[];
}

export async function assertNoNewDeprecatedNodes(
  _deps: ServiceDeps,
  _input: { next: DeprecatedCheckWorkflow; stored?: DeprecatedCheckWorkflow | null },
): Promise<void> {
  // stub (L7): PASSES
}

export async function assertNoDeprecatedNodes(
  _deps: ServiceDeps,
  _nodes: ReadonlyArray<Pick<WorkflowNode, 'name' | 'type'>>,
): Promise<void> {
  // stub (L7): PASSES
}
