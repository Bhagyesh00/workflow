/**
 * Convert a node selection to a sub-workflow (P3-05), as n8n's workflow extraction: the new workflow is
 * "Start" (Execute Workflow Trigger) -> selected nodes -> optional "Return" Set node; the parent gets one
 * "Call <name>" Execute Workflow node at the selection's average position, rewired, with cross-boundary
 * `$('Node')` references mapped. Pure: the caller creates and publishes the new workflow.
 *
 * C0 STUB: lane L5 writes the body.
 */
import type {
  Connections,
  Item,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeGroup,
  WorkflowSettings,
} from './interfaces';
import type { NodeDescriptionLookup } from './node-grouping';

export interface ExtractSubWorkflowInput {
  definition: WorkflowDefinition;
  /** selected node ids (expanded with sub-nodes inside) */
  nodeIds: string[];
  /** name of the new workflow */
  name: string;
  /** id the new workflow will get; used in the Execute Workflow node's workflow reference */
  newWorkflowId?: string;
  /** node types for the extraction rules (trigger, deprecated, sub-nodes) */
  types?: NodeDescriptionLookup;
}

export interface ExtractionResult {
  /** the new workflow's body */
  subWorkflow: {
    name: string;
    nodes: WorkflowNode[];
    connections: Connections;
    settings: WorkflowSettings;
    pinData?: Record<string, Item[]>;
  };
  /** the parent after the conversion */
  parent: {
    nodes: WorkflowNode[];
    connections: Connections;
    pinData?: Record<string, Item[]>;
    nodeGroups?: WorkflowNodeGroup[];
  };
  /** name of the Execute Workflow node added to the parent */
  executeNodeName: string;
}

/** throws when the selection breaks an extraction rule */
export function extractSubWorkflow(_input: ExtractSubWorkflowInput): ExtractionResult {
  throw new Error('not implemented (L5)');
}
