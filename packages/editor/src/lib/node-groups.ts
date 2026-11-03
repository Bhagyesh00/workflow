/**
 * Canvas group operations (P3-04) on the editor graph: create, ungroup, rename, move, describe,
 * and the guard that blocks edits crossing a group border (with n8n's auto-extend).
 * The workflow store calls these; each returns a new graph and never mutates its input.
 * The rules come from @workflow/workflow node-grouping.ts (strict rule set).
 */
import {
  expandSelectionWithSubNodes,
  GROUP_DESCRIPTION_MAX_LENGTH,
  type GroupingProblem,
  type GroupingProblemCode,
  type NodeDescriptionLookup,
  type NodeTypeDescription,
  normalizeGroupDescription,
  validateSelectionForGrouping,
  validateWorkflowNodeGroups,
  type WorkflowDefinition,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { newId } from './ids';
import {
  type ConnectionRef,
  connect,
  disconnect,
  insertNodeOnConnection,
  uniqueGroupName,
  type WorkflowGraph,
} from './workflow-ops';

export interface GroupNodesResult {
  graph: WorkflowGraph;
  /** the new group, or null when `problems` blocked it */
  groupId: string | null;
  /** [] when the group was created */
  problems: GroupingProblem[];
}

const definitionOf = (graph: WorkflowGraph, nodeGroups = graph.nodeGroups): WorkflowDefinition => ({
  name: '',
  nodes: graph.nodes,
  connections: graph.connections,
  stickyNotes: graph.stickyNotes,
  nodeGroups,
});

const idsOf = (graph: WorkflowGraph, names: readonly string[]) => {
  const set = new Set(names);
  return graph.nodes.filter((n) => set.has(n.name)).map((n) => n.id);
};

const withGroup = (graph: WorkflowGraph, id: string, patch: (g: WorkflowNodeGroup) => WorkflowNodeGroup) => ({
  ...graph,
  nodeGroups: graph.nodeGroups.map((g) => (g.id === id ? patch(g) : g)),
});

/** the group just made by groupNodes: its title opens for an inline rename once it shows */
let pendingRename: string | null = null;

/** true once for the group groupNodes just created (the canvas starts the inline rename) */
export function consumeGroupRenameRequest(groupId: string): boolean {
  if (pendingRename !== groupId) return false;
  pendingRename = null;
  return true;
}

/** Group the named nodes (default names "Group", "Group 2", ...). */
export function groupNodes(
  graph: WorkflowGraph,
  nodeNames: readonly string[],
  types?: NodeDescriptionLookup,
): GroupNodesResult {
  const definition = definitionOf(graph);
  const ids = idsOf(graph, nodeNames);
  const problems = validateSelectionForGrouping(definition, ids, types);
  if (problems.length) return { graph, groupId: null, problems };
  const group: WorkflowNodeGroup = {
    id: newId(),
    name: uniqueGroupName(
      'Group',
      graph.nodeGroups.map((g) => g.name),
    ),
    // AI sub-nodes travel with their parent
    nodeIds: expandSelectionWithSubNodes(definition, ids),
  };
  pendingRename = group.id;
  return { graph: { ...graph, nodeGroups: [...graph.nodeGroups, group] }, groupId: group.id, problems: [] };
}

/** Remove the group; its nodes stay where they are. */
export function ungroupNodes(graph: WorkflowGraph, groupId: string): WorkflowGraph {
  return { ...graph, nodeGroups: graph.nodeGroups.filter((g) => g.id !== groupId) };
}

/** Rename the group; a taken name gets the next free number, an empty or unchanged name changes nothing. */
export function renameNodeGroup(graph: WorkflowGraph, groupId: string, name: string): WorkflowGraph {
  const group = graph.nodeGroups.find((g) => g.id === groupId);
  const trimmed = name.trim();
  if (!group || !trimmed || trimmed === group.name) return graph;
  const unique = uniqueGroupName(
    trimmed,
    graph.nodeGroups.filter((g) => g.id !== groupId).map((g) => g.name),
  );
  return withGroup(graph, groupId, (g) => ({ ...g, name: unique }));
}

/** Move every member of the group by (dx, dy). */
export function moveNodeGroup(graph: WorkflowGraph, groupId: string, dx: number, dy: number): WorkflowGraph {
  const group = graph.nodeGroups.find((g) => g.id === groupId);
  if (!group || (dx === 0 && dy === 0)) return graph;
  const members = new Set(group.nodeIds);
  const shift = (p: [number, number]): [number, number] => [Math.round(p[0] + dx), Math.round(p[1] + dy)];
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (members.has(n.id) ? { ...n, position: shift(n.position) } : n)),
    stickyNotes: graph.stickyNotes.map((s) =>
      members.has(s.id) ? { ...s, position: shift(s.position) } : s,
    ),
  };
}

/** Set or clear (empty text) the group description; normalizeGroupDescription applies. */
export function setNodeGroupDescription(graph: WorkflowGraph, groupId: string, text: string): WorkflowGraph {
  const group = graph.nodeGroups.find((g) => g.id === groupId);
  if (!group) return graph;
  const description = normalizeGroupDescription(text)?.slice(0, GROUP_DESCRIPTION_MAX_LENGTH);
  if (description === group.description) return graph;
  return withGroup(graph, groupId, (g) => {
    const { description: _old, ...rest } = g;
    return description === undefined ? rest : { ...rest, description };
  });
}

// ---------------------------------------------------------------------------------------------
// Crossing edits

/** which edit the store is about to make with `ref` */
export type CrossingEdit = 'connect' | 'disconnect' | 'insert';

export interface CrossingEditError {
  /** n8n's blocked-edit message for the reason (toast text) */
  message: string;
  /** the group the edit would break (the toast's "Ungroup" action) */
  groupId: string;
}

/** the reasons with their own blocked-edit message; every other code uses the generic one */
type BlockedReason =
  | 'multiple_entry'
  | 'multiple_exit'
  | 'input_to_non_first'
  | 'output_from_non_last'
  | 'no_path_first_to_last'
  | 'non_main_boundary'
  | 'generic';

const BLOCKED: Record<BlockedReason, (name: string) => string> = {
  multiple_entry: (name) => `"${name}" can take input on one node only.`,
  multiple_exit: (name) => `"${name}" can send output from one node only.`,
  input_to_non_first: (name) => `Only the first node of "${name}" can take input from outside the group.`,
  output_from_non_last: (name) => `Only the last node of "${name}" can send output outside the group.`,
  no_path_first_to_last: (name) => `"${name}" needs a path from its first node to its last node.`,
  non_main_boundary: (name) => `AI connections can't cross the border of "${name}".`,
  generic: (name) => `This change would break the group "${name}".`,
};

/** the toast text for an edit blocked by the group named `groupName` */
export function blockedEditMessage(code: GroupingProblemCode, groupName: string): string {
  const reason: BlockedReason = code in BLOCKED ? (code as BlockedReason) : 'generic';
  return `${BLOCKED[reason](groupName)} Ungroup it to make this change.`;
}

/**
 * Stands in for a node type the lookup cannot resolve, so the structural checks (one section,
 * one entry, one exit, no AI connection across the border) still run; only the trigger rule
 * needs the real description.
 */
const STRUCTURAL_ONLY = { group: [] } as unknown as NodeTypeDescription;

function lookupFor(types?: NodeDescriptionLookup): NodeDescriptionLookup {
  return (type, version) => types?.(type, version) ?? STRUCTURAL_ONLY;
}

/** the save-path problems of one group in `graph` ([] = valid) */
function groupProblems(graph: WorkflowGraph, group: WorkflowNodeGroup, types?: NodeDescriptionLookup) {
  return validateWorkflowNodeGroups(definitionOf(graph, [group]), lookupFor(types));
}

const idOfName = (graph: WorkflowGraph, name: string) => graph.nodes.find((n) => n.name === name)?.id;
const groupOfId = (graph: WorkflowGraph, id: string | undefined) =>
  id === undefined ? undefined : graph.nodeGroups.find((g) => g.nodeIds.includes(id));

const PLACEHOLDER = '\u0001inserted\u0001';

/** the graph after the edit, as the store would make it (connect includes the auto-extend) */
function afterEdit(
  graph: WorkflowGraph,
  ref: ConnectionRef,
  edit: CrossingEdit,
  types?: NodeDescriptionLookup,
): WorkflowGraph {
  if (edit === 'connect') return extendGroupsForConnection(connect(graph, ref), ref, types).graph;
  if (edit === 'disconnect') return disconnect(graph, ref);
  const withNode: WorkflowGraph = {
    ...graph,
    nodes: [
      ...graph.nodes,
      {
        id: PLACEHOLDER,
        name: PLACEHOLDER,
        // unknown type: only the structural rules apply to the node being inserted
        type: '',
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
    ],
  };
  return insertNodeOnConnection(withNode, ref, PLACEHOLDER);
}

/**
 * Would this edit leave a group invalid (after any auto-extend)? null = allowed.
 * `connect`: ref is the new connection; `disconnect`: ref is removed; `insert`: a node is put on ref.
 * A group that was already invalid before the edit never blocks it.
 */
export function crossingEditError(
  graph: WorkflowGraph,
  ref: ConnectionRef,
  edit: CrossingEdit,
  types?: NodeDescriptionLookup,
): CrossingEditError | null {
  const touched = new Set(
    [groupOfId(graph, idOfName(graph, ref.target)), groupOfId(graph, idOfName(graph, ref.source))]
      .filter((g): g is WorkflowNodeGroup => g !== undefined)
      .map((g) => g.id),
  );
  if (!touched.size) return null;
  const next = afterEdit(graph, ref, edit, types);
  for (const id of touched) {
    const before = graph.nodeGroups.find((g) => g.id === id) as WorkflowNodeGroup;
    const after = next.nodeGroups.find((g) => g.id === id);
    if (!after || groupProblems(graph, before, types).length) continue;
    const problem = groupProblems(next, after, types)[0];
    if (problem) return { message: blockedEditMessage(problem.code, before.name), groupId: id };
  }
  return null;
}

export interface GroupExtension {
  graph: WorkflowGraph;
  /** names of the groups that took in a node (info toast "'<name>' extended") */
  extended: string[];
}

/**
 * Auto-extend (n8n getAutoExtendCandidate): `graph` already holds the new connection `ref`; when it
 * leaves exactly one endpoint outside a group and the group stays valid, that node joins the group.
 * Only a connection that would otherwise break the group extends it: a valid group stays as it is.
 */
export function extendGroupsForConnection(
  graph: WorkflowGraph,
  ref: ConnectionRef,
  types?: NodeDescriptionLookup,
): GroupExtension {
  const sourceId = idOfName(graph, ref.source);
  const targetId = idOfName(graph, ref.target);
  if (!sourceId || !targetId) return { graph, extended: [] };
  const sourceGroup = groupOfId(graph, sourceId);
  const targetGroup = groupOfId(graph, targetId);
  if (Boolean(sourceGroup) === Boolean(targetGroup)) return { graph, extended: [] };
  const group = (sourceGroup ?? targetGroup) as WorkflowNodeGroup;
  const outsideId = sourceGroup ? targetId : sourceId;
  if (!groupProblems(graph, group, types).length) return { graph, extended: [] };

  // the outside node joins with its own AI sub-nodes, none of which may be in a group
  const joining = expandSelectionWithSubNodes(definitionOf(graph), [outsideId]);
  if (joining.some((id) => groupOfId(graph, id))) return { graph, extended: [] };
  const extended: WorkflowNodeGroup = { ...group, nodeIds: [...group.nodeIds, ...joining] };
  if (groupProblems(graph, extended, types).length) return { graph, extended: [] };
  return {
    graph: withGroup(graph, group.id, () => extended),
    extended: [group.name],
  };
}

/** Ids of the groups holding at least one of the named nodes, in group order. */
export function groupsOfNodes(graph: WorkflowGraph, nodeNames: readonly string[]): string[] {
  const names = new Set(nodeNames);
  const ids = new Set(graph.nodes.filter((n) => names.has(n.name)).map((n) => n.id));
  return graph.nodeGroups.filter((g) => g.nodeIds.some((id) => ids.has(id))).map((g) => g.id);
}
