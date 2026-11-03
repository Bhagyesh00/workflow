/**
 * Convert the selected nodes to a sub-workflow (P3-05, as n8n useWorkflowExtraction): extract with
 * @workflow/workflow extractSubWorkflow, create the new workflow in the parent's folder, publish
 * it (a failed publish is logged, the conversion still succeeds), replace the nodes in the parent
 * with one Execute Workflow node via store.applyGraph (one undo step), toast "Created
 * sub-workflow" with "Open in new tab".
 *
 * C0 STUB: lane L5 writes the body.
 */
import type { EditorDeps } from './editor-actions';

export interface ConvertToSubWorkflowInput {
  nodeNames: string[];
  /** the new workflow's name */
  name: string;
}

export interface ConvertToSubWorkflowResult {
  workflowId: string;
  /** the Execute Workflow node that replaced the selection in the parent */
  executeNodeName: string;
}

export function convertToSubWorkflow(
  _deps: EditorDeps,
  _input: ConvertToSubWorkflowInput,
): Promise<ConvertToSubWorkflowResult | null> {
  throw new Error('not implemented (L5)');
}
