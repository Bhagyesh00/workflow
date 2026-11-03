/**
 * Canvas group rules (P3-04) and the sub-workflow extraction rules built on them (P3-05).
 * Two rule sets, as n8n's grouping validation:
 * - grouping: no trigger, one connected section with at most one entry and one exit node (many connections
 *   allowed), sub-nodes travel with their parent, stickies ride along, no non-main connection crossing the
 *   border, one group per node; never the single-main-input/output test.
 * - extraction: the grouping rules plus a single main input and a single main output, and no deprecated node.
 * Save-path validation: five basic checks always; the full checks only when every member's type resolves.
 *
 * C0 STUB: lane L4a writes the bodies. Signatures are the contract for L4, L5, L2 and the server.
 */
import type { NodeTypeDescription, WorkflowDefinition } from './interfaces';

/** resolves a node type description (editor: node catalog; server: registry); undefined = unknown type */
export type NodeDescriptionLookup = (type: string, typeVersion?: number) => NodeTypeDescription | undefined;

/** max length of a group description (P3-04 addendum); the server answers 400 above it */
export const GROUP_DESCRIPTION_MAX_LENGTH = 145;

/** the strict rule set (n8n's relaxed, flag-gated rules are off) */
export interface NodeGroupingRules {
  /** a trigger node may be a member */
  allowTriggers: boolean;
  /** nodes that take main input from outside the group */
  maxEntryNodes: number;
  /** nodes that send main output outside the group */
  maxExitNodes: number;
  /** non-main (AI sub-node) connections may cross the group border */
  allowNonMainBoundary: boolean;
  /** groups a node may belong to */
  maxGroupsPerNode: number;
}

export const NODE_GROUPING_RULES: Readonly<NodeGroupingRules> = Object.freeze({
  allowTriggers: false,
  maxEntryNodes: 1,
  maxExitNodes: 1,
  allowNonMainBoundary: false,
  maxGroupsPerNode: 1,
});

export type GroupingProblemCode =
  // selection rules (grouping and extraction)
  | 'trigger'
  | 'disconnected'
  | 'multiple_entry'
  | 'multiple_exit'
  | 'input_to_non_first'
  | 'output_from_non_last'
  | 'no_path_first_to_last'
  | 'non_main_boundary'
  | 'node_in_other_group'
  // extraction only
  | 'multiple_input_branches'
  | 'multiple_output_branches'
  | 'deprecated'
  // save path (validateWorkflowNodeGroups) basic checks
  | 'duplicate_group_id'
  | 'duplicate_group_name'
  | 'empty_group'
  | 'unknown_node'
  | 'node_in_multiple_groups'
  | 'description_too_long'
  // anything else
  | 'generic';

export interface GroupingProblem {
  code: GroupingProblemCode;
  /** user-facing rule text (toast, 400 body) */
  message: string;
  /** node ids the problem is about */
  nodeIds?: string[];
  /** set by validateWorkflowNodeGroups */
  groupId?: string;
}

/** problems that block grouping the selected node ids; [] = allowed */
export function validateSelectionForGrouping(
  _definition: WorkflowDefinition,
  _nodeIds: readonly string[],
  _types?: NodeDescriptionLookup,
): GroupingProblem[] {
  return [];
}

/** problems that block converting the selected node ids to a sub-workflow; [] = allowed */
export function validateSelectionForExtraction(
  _definition: WorkflowDefinition,
  _nodeIds: readonly string[],
  _types?: NodeDescriptionLookup,
): GroupingProblem[] {
  return [];
}

/** save-path check of `definition.nodeGroups`; [] = valid */
export function validateWorkflowNodeGroups(
  _definition: WorkflowDefinition,
  _types?: NodeDescriptionLookup,
): GroupingProblem[] {
  return [];
}

/** the selection plus the AI sub-nodes attached to selected parents (node ids, selection order first) */
export function expandSelectionWithSubNodes(
  _definition: WorkflowDefinition,
  _nodeIds: readonly string[],
): string[] {
  throw new Error('not implemented (L4a)');
}

/** trimmed description, or undefined when empty */
export function normalizeGroupDescription(_description: string | null | undefined): string | undefined {
  throw new Error('not implemented (L4a)');
}
