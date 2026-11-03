/**
 * Canvas group operations (P3-04) on the editor graph: create, ungroup, rename, move, describe,
 * and the guard that blocks edits crossing a group border (with n8n's auto-extend).
 * The workflow store calls these; each returns a new graph and never mutates its input.
 *
 * C0 STUB: lane L4 writes the bodies (rules come from @workflow/workflow node-grouping.ts, L4a).
 * `groupsOfNodes` is real C0 code.
 */
import type { GroupingProblem, NodeDescriptionLookup } from '@workflow/workflow';
import type { ConnectionRef, WorkflowGraph } from './workflow-ops';

export interface GroupNodesResult {
  graph: WorkflowGraph;
  /** the new group, or null when `problems` blocked it */
  groupId: string | null;
  /** [] when the group was created */
  problems: GroupingProblem[];
}

/** Group the named nodes (default names "Group", "Group 2", ...). */
export function groupNodes(
  _graph: WorkflowGraph,
  _nodeNames: readonly string[],
  _types?: NodeDescriptionLookup,
): GroupNodesResult {
  throw new Error('not implemented (L4)');
}

/** Remove the group; its nodes stay where they are. */
export function ungroupNodes(_graph: WorkflowGraph, _groupId: string): WorkflowGraph {
  throw new Error('not implemented (L4)');
}

export function renameNodeGroup(_graph: WorkflowGraph, _groupId: string, _name: string): WorkflowGraph {
  throw new Error('not implemented (L4)');
}

/** Move every member of the group by (dx, dy). */
export function moveNodeGroup(
  _graph: WorkflowGraph,
  _groupId: string,
  _dx: number,
  _dy: number,
): WorkflowGraph {
  throw new Error('not implemented (L4)');
}

/** Set or clear (empty text) the group description; normalizeGroupDescription applies. */
export function setNodeGroupDescription(
  _graph: WorkflowGraph,
  _groupId: string,
  _text: string,
): WorkflowGraph {
  throw new Error('not implemented (L4)');
}

/** which edit the store is about to make with `ref` */
export type CrossingEdit = 'connect' | 'disconnect' | 'insert';

export interface CrossingEditError {
  /** n8n's blocked-edit message for the reason (toast text) */
  message: string;
  /** the group the edit would break (the toast's "Ungroup" action) */
  groupId: string;
}

/**
 * Would this edit leave a group invalid (after any auto-extend)? null = allowed.
 * `connect`: ref is the new connection; `disconnect`: ref is removed; `insert`: a node is put on ref.
 */
export function crossingEditError(
  _graph: WorkflowGraph,
  _ref: ConnectionRef,
  _edit: CrossingEdit,
  _types?: NodeDescriptionLookup,
): CrossingEditError | null {
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
 */
export function extendGroupsForConnection(
  graph: WorkflowGraph,
  _ref: ConnectionRef,
  _types?: NodeDescriptionLookup,
): GroupExtension {
  return { graph, extended: [] };
}

/** Ids of the groups holding at least one of the named nodes, in group order. */
export function groupsOfNodes(graph: WorkflowGraph, nodeNames: readonly string[]): string[] {
  const names = new Set(nodeNames);
  const ids = new Set(graph.nodes.filter((n) => names.has(n.name)).map((n) => n.id));
  return graph.nodeGroups.filter((g) => g.nodeIds.some((id) => ids.has(id))).map((g) => g.id);
}
