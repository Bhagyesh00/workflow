/**
 * Pure, immutable operations on the editable part of a workflow. The zustand store wraps these
 * with history and selection; tests exercise them directly. Inputs are never mutated.
 */
import {
  type Connection,
  type Connections,
  type ConnectionType,
  type GraphConnectionRef,
  type Item,
  listConnections,
  type NodeConnections,
  renameNodeInDefinition,
  type StickyNote,
  validateSelectionForGrouping,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { newId } from './ids';

// moved to `@workflow/workflow` (workflow-lint.ts) in Phase 5 S4; the editor keeps its names
export { getAncestors, getMainParents } from '@workflow/workflow';
export { listConnections };

/** one cable as a flat record (`GraphConnectionRef` of `@workflow/workflow`) */
export type ConnectionRef = GraphConnectionRef;

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  connections: Connections;
  pinData: Record<string, Item[]>;
  stickyNotes: StickyNote[];
  /** canvas groups (P3-04); members are node ids */
  nodeGroups: WorkflowNodeGroup[];
}

export type ParameterPath = Array<string | number>;

export const EMPTY_GRAPH: WorkflowGraph = {
  nodes: [],
  connections: {},
  pinData: {},
  stickyNotes: [],
  nodeGroups: [],
};

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** `Edit Fields` -> `Edit Fields1` -> `Edit Fields2` ... (first free suffix) */
export function uniqueNodeName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const trimmed = base.trim() || 'Node';
  if (!names.has(trimmed)) return trimmed;
  const stem = trimmed.replace(/\d+$/, '');
  let i = 1;
  while (names.has(`${stem}${i}`)) i++;
  return `${stem}${i}`;
}

/** `Group` -> `Group 2` -> `Group 3` ... (first free number; group names are unique) */
export function uniqueGroupName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const trimmed = base.trim() || 'Group';
  if (!names.has(trimmed)) return trimmed;
  const stem = trimmed.replace(/ \d+$/, '') || trimmed;
  let i = 2;
  while (names.has(`${stem} ${i}`)) i++;
  return `${stem} ${i}`;
}

export function getNode(graph: WorkflowGraph, name: string): WorkflowNode | undefined {
  return graph.nodes.find((n) => n.name === name);
}

/** Give every node an id and a unique name (imported JSON may have neither). */
export function normalizeNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  const ids = new Set<string>();
  return nodes.map((n) => {
    const id = n.id && !ids.has(n.id) ? n.id : newId();
    ids.add(id);
    const position: [number, number] = Array.isArray(n.position) ? [n.position[0], n.position[1]] : [0, 0];
    return { ...n, id, position, parameters: n.parameters ?? {} };
  });
}

// ---------------------------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------------------------

export function addNode(
  graph: WorkflowGraph,
  node: WorkflowNode,
): { graph: WorkflowGraph; node: WorkflowNode } {
  const added: WorkflowNode = {
    ...node,
    id: node.id && !graph.nodes.some((n) => n.id === node.id) ? node.id : newId(),
    name: uniqueNodeName(
      node.name,
      graph.nodes.map((n) => n.name),
    ),
  };
  return { graph: { ...graph, nodes: [...graph.nodes, added] }, node: added };
}

function removeFromConnections(connections: Connections, names: Set<string>): Connections {
  const result: Connections = {};
  for (const [source, byType] of Object.entries(connections)) {
    if (names.has(source)) continue;
    const kept: NodeConnections = {};
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      kept[type] = (outputs ?? []).map((dests) => (dests ?? []).filter((d) => !names.has(d.node)));
    }
    result[source] = kept;
  }
  return result;
}

/** the group without the `removed` ids, or null when no node of `nodeIds` is left in it */
function shrinkGroup(
  group: WorkflowNodeGroup,
  removed: Set<string>,
  nodeIds: Set<string>,
): WorkflowNodeGroup | null {
  const left = group.nodeIds.filter((id) => !removed.has(id));
  if (!left.some((id) => nodeIds.has(id))) return null;
  return left.length === group.nodeIds.length ? group : { ...group, nodeIds: left };
}

/** does the group form one valid section (structure only: node types are not needed here)? */
function groupIsValid(graph: WorkflowGraph, group: WorkflowNodeGroup): boolean {
  const definition: WorkflowDefinition = {
    name: '',
    nodes: graph.nodes,
    connections: graph.connections,
    stickyNotes: graph.stickyNotes,
    nodeGroups: graph.nodeGroups.filter((g) => g.id !== group.id),
  };
  return validateSelectionForGrouping(definition, group.nodeIds).length === 0;
}

/**
 * Remove nodes with their cables and pinned data. Groups lose the removed members; a group left
 * without a node is removed, and a valid group the removal breaks (split in two, for example) is
 * dissolved with its nodes kept, so a saved group always passes the server's checks.
 */
export function removeNodes(graph: WorkflowGraph, names: string[]): WorkflowGraph {
  if (!names.length) return graph;
  const set = new Set(names);
  const pinData = { ...graph.pinData };
  for (const name of names) delete pinData[name];
  const removedIds = new Set(graph.nodes.filter((n) => set.has(n.name)).map((n) => n.id));
  const next: WorkflowGraph = {
    ...graph,
    nodes: graph.nodes.filter((n) => !set.has(n.name)),
    connections: removeFromConnections(graph.connections, set),
    pinData,
  };
  if (!graph.nodeGroups.length || !removedIds.size) return next;
  const nodeIds = new Set(next.nodes.map((n) => n.id));
  const nodeGroups: WorkflowNodeGroup[] = [];
  for (const group of graph.nodeGroups) {
    const shrunk = shrinkGroup(group, removedIds, nodeIds);
    if (!shrunk) continue;
    if (shrunk !== group && groupIsValid(graph, group) && !groupIsValid(next, shrunk)) continue;
    nodeGroups.push(shrunk);
  }
  return { ...next, nodeGroups };
}

export function updateNode(
  graph: WorkflowGraph,
  name: string,
  patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.name !== name) return n;
      const next: WorkflowNode = { ...n, ...patch };
      // undefined means "unset": keep the stored JSON minimal
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete (next as unknown as Record<string, unknown>)[key];
      }
      return next;
    }),
  };
}

export class RenameError extends Error {}

/** Rename a node; connections, pinned data and `$('Old')` references follow. */
export function renameNode(graph: WorkflowGraph, oldName: string, newName: string): WorkflowGraph {
  const name = newName.trim();
  if (!name) throw new RenameError('Name cannot be empty');
  if (name === oldName) return graph;
  if (graph.nodes.some((n) => n.name === name))
    throw new RenameError(`A node named "${name}" already exists`);
  if (!graph.nodes.some((n) => n.name === oldName)) throw new RenameError(`Node "${oldName}" does not exist`);
  const renamed = renameNodeInDefinition(
    { name: '', nodes: graph.nodes, connections: graph.connections, pinData: graph.pinData },
    oldName,
    name,
  );
  return { ...graph, nodes: renamed.nodes, connections: renamed.connections, pinData: renamed.pinData ?? {} };
}

export function moveNodes(graph: WorkflowGraph, positions: Record<string, [number, number]>): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (positions[n.name] ? { ...n, position: positions[n.name] } : n)),
  };
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

/** Immutable set by path; `undefined` removes the key (or array element). */
export function setIn(target: unknown, path: ParameterPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (head === '__proto__' || head === 'constructor' || head === 'prototype') {
    throw new Error(`Invalid parameter key "${String(head)}"`);
  }
  if (typeof head === 'number') {
    const list = Array.isArray(target) ? [...target] : [];
    if (rest.length === 0 && value === undefined) {
      list.splice(head, 1);
      return list;
    }
    list[head] = setIn(list[head], rest, value);
    return list;
  }
  const obj: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as object) } : {};
  if (rest.length === 0 && value === undefined) {
    delete obj[head];
    return obj;
  }
  obj[head] = setIn(obj[head], rest, value);
  return obj;
}

export function getIn(target: unknown, path: ParameterPath): unknown {
  let cur = target;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function setNodeParameter(
  graph: WorkflowGraph,
  nodeName: string,
  path: ParameterPath,
  value: unknown,
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.name === nodeName
        ? { ...n, parameters: setIn(n.parameters, path, value) as WorkflowNode['parameters'] }
        : n,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------------------------

export function connect(graph: WorkflowGraph, ref: ConnectionRef): WorkflowGraph {
  const byType = graph.connections[ref.source] ?? {};
  const outputs = [...(byType[ref.sourceType] ?? [])];
  while (outputs.length <= ref.sourceIndex) outputs.push([]);
  const existing = outputs[ref.sourceIndex] ?? [];
  if (
    existing.some((d) => d.node === ref.target && d.index === ref.targetIndex && d.type === ref.targetType)
  ) {
    return graph;
  }
  outputs[ref.sourceIndex] = [
    ...existing,
    { node: ref.target, type: ref.targetType, index: ref.targetIndex },
  ];
  return {
    ...graph,
    connections: { ...graph.connections, [ref.source]: { ...byType, [ref.sourceType]: outputs } },
  };
}

export function disconnect(graph: WorkflowGraph, ref: ConnectionRef): WorkflowGraph {
  const byType = graph.connections[ref.source];
  const outputs = byType?.[ref.sourceType];
  if (!outputs?.[ref.sourceIndex]) return graph;
  const nextOutputs = outputs.map((dests, i) =>
    i === ref.sourceIndex
      ? (dests ?? []).filter(
          (d) => !(d.node === ref.target && d.index === ref.targetIndex && d.type === ref.targetType),
        )
      : dests,
  );
  return {
    ...graph,
    connections: { ...graph.connections, [ref.source]: { ...byType, [ref.sourceType]: nextOutputs } },
  };
}

/** Stable id of a connection (used for canvas edges and edge selection). */
export function connectionId(ref: ConnectionRef): string {
  return [ref.source, ref.sourceType, ref.sourceIndex, ref.target, ref.targetType, ref.targetIndex].join(
    '\u0000',
  );
}

/**
 * Replace the cable `ref` with `source -> node -> target` (node uses main input/output 0). A node
 * put on a cable between two members of one group joins that group.
 */
export function insertNodeOnConnection(
  graph: WorkflowGraph,
  ref: ConnectionRef,
  nodeName: string,
): WorkflowGraph {
  let next = disconnect(graph, ref);
  const idOf = (name: string) => graph.nodes.find((n) => n.name === name)?.id;
  const [sourceId, targetId, insertedId] = [idOf(ref.source), idOf(ref.target), idOf(nodeName)];
  const inside = graph.nodeGroups.find(
    (g) => sourceId && targetId && g.nodeIds.includes(sourceId) && g.nodeIds.includes(targetId),
  );
  if (inside && insertedId && !graph.nodeGroups.some((g) => g.nodeIds.includes(insertedId))) {
    next = {
      ...next,
      nodeGroups: graph.nodeGroups.map((g) =>
        g.id === inside.id ? { ...g, nodeIds: [...g.nodeIds, insertedId] } : g,
      ),
    };
  }
  next = connect(next, { ...ref, target: nodeName, targetIndex: 0, targetType: ref.sourceType });
  next = connect(next, {
    source: nodeName,
    sourceType: ref.targetType,
    sourceIndex: 0,
    target: ref.target,
    targetType: ref.targetType,
    targetIndex: ref.targetIndex,
  });
  return next;
}

// ---------------------------------------------------------------------------------------------
// Sticky notes and pinned data
// ---------------------------------------------------------------------------------------------

export function addSticky(
  graph: WorkflowGraph,
  sticky: Omit<StickyNote, 'id'> & { id?: string },
): WorkflowGraph {
  return { ...graph, stickyNotes: [...graph.stickyNotes, { ...sticky, id: sticky.id ?? newId() }] };
}

export function updateSticky(
  graph: WorkflowGraph,
  id: string,
  patch: Partial<Omit<StickyNote, 'id'>>,
): WorkflowGraph {
  return { ...graph, stickyNotes: graph.stickyNotes.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeStickies(graph: WorkflowGraph, ids: string[]): WorkflowGraph {
  const set = new Set(ids);
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const nodeGroups = graph.nodeGroups.some((g) => g.nodeIds.some((id) => set.has(id)))
    ? graph.nodeGroups.flatMap((g) => shrinkGroup(g, set, nodeIds) ?? [])
    : graph.nodeGroups;
  return { ...graph, stickyNotes: graph.stickyNotes.filter((s) => !set.has(s.id)), nodeGroups };
}

export function setPinData(graph: WorkflowGraph, nodeName: string, items: Item[] | null): WorkflowGraph {
  const pinData = { ...graph.pinData };
  if (items) pinData[nodeName] = items;
  else delete pinData[nodeName];
  return { ...graph, pinData };
}

// ---------------------------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------------------------

export interface ClipboardPayload {
  kind: 'workflow-clipboard';
  nodes: WorkflowNode[];
  connections: Connections;
  pinData?: Record<string, Item[]>;
  stickyNotes?: StickyNote[];
  /** groups whose every member node is in the payload (P3-04) */
  nodeGroups?: WorkflowNodeGroup[];
}

/** Selected nodes plus the connections between them (their pinned data and whole groups too). */
export function extractSubgraph(
  graph: WorkflowGraph,
  names: string[],
  stickyIds: string[] = [],
): ClipboardPayload {
  const set = new Set(names);
  const nodes = graph.nodes.filter((n) => set.has(n.name));
  const connections: Connections = {};
  for (const c of listConnections(graph.connections)) {
    if (!set.has(c.source) || !set.has(c.target)) continue;
    Object.assign(connections, connect({ ...EMPTY_GRAPH, connections }, c).connections);
  }
  const pinData = Object.fromEntries(Object.entries(graph.pinData).filter(([k]) => set.has(k)));
  const stickies = new Set(stickyIds);
  const copied = new Set([...nodes.map((n) => n.id), ...stickies]);
  const allNodeIds = new Set(graph.nodes.map((n) => n.id));
  const nodeGroups = graph.nodeGroups
    .filter((g) => {
      const members = g.nodeIds.filter((id) => allNodeIds.has(id));
      return members.length > 0 && members.every((id) => copied.has(id));
    })
    .map((g) => ({ ...g, nodeIds: g.nodeIds.filter((id) => copied.has(id)) }));
  return {
    kind: 'workflow-clipboard',
    nodes,
    connections,
    pinData,
    stickyNotes: graph.stickyNotes.filter((s) => stickies.has(s.id)),
    nodeGroups,
  };
}

function isNodeGroup(value: unknown): value is WorkflowNodeGroup {
  if (!value || typeof value !== 'object') return false;
  const g = value as Partial<WorkflowNodeGroup>;
  return (
    typeof g.id === 'string' &&
    typeof g.name === 'string' &&
    Array.isArray(g.nodeIds) &&
    g.nodeIds.every((id) => typeof id === 'string') &&
    (g.description === undefined || typeof g.description === 'string')
  );
}

/** Accepts our clipboard JSON or a bare `{ nodes, connections }` workflow export. */
export function parseClipboard(text: string): ClipboardPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const value = data as Partial<ClipboardPayload>;
  if (!Array.isArray(value.nodes)) return null;
  const nodes = value.nodes.filter(
    (n): n is WorkflowNode =>
      Boolean(n) && typeof n === 'object' && typeof n.name === 'string' && typeof n.type === 'string',
  );
  if (!nodes.length && !Array.isArray(value.stickyNotes)) return null;
  return {
    kind: 'workflow-clipboard',
    nodes: nodes.map((n) => ({
      ...n,
      typeVersion: typeof n.typeVersion === 'number' ? n.typeVersion : 1,
      parameters: n.parameters && typeof n.parameters === 'object' ? n.parameters : {},
      position: Array.isArray(n.position) ? [Number(n.position[0]) || 0, Number(n.position[1]) || 0] : [0, 0],
    })),
    connections: value.connections && typeof value.connections === 'object' ? value.connections : {},
    pinData: value.pinData && typeof value.pinData === 'object' ? value.pinData : {},
    stickyNotes: Array.isArray(value.stickyNotes) ? value.stickyNotes : [],
    nodeGroups: Array.isArray(value.nodeGroups) ? value.nodeGroups.filter(isNodeGroup) : [],
  };
}

/** Copies of a workflow must not share webhook paths: every node that has a webhookId gets a new one. */
export function withFreshWebhookIds<T extends { webhookId?: string }>(nodes: T[]): T[] {
  return nodes.map((n) => (n.webhookId ? { ...n, webhookId: newId() } : n));
}

/**
 * Paste a clipboard payload: nodes get fresh ids, names that clash are made unique (and every
 * reference inside the pasted nodes follows), positions are shifted by `offset`.
 */
export function pasteSubgraph(
  graph: WorkflowGraph,
  payload: ClipboardPayload,
  offset: [number, number] = [40, 40],
): { graph: WorkflowGraph; names: string[]; stickyIds: string[] } {
  const known = new Set(payload.nodes.map((n) => n.name));
  // keep only connections inside the pasted set
  const internal: Connections = {};
  let clip = { ...EMPTY_GRAPH, nodes: payload.nodes, connections: internal, pinData: payload.pinData ?? {} };
  for (const c of listConnections(payload.connections)) {
    if (known.has(c.source) && known.has(c.target)) clip = connect(clip, c);
  }

  // two-phase rename (old -> placeholder -> final) so chains like A->A1, A1->A2 cannot collide
  const taken = new Set(graph.nodes.map((n) => n.name));
  const finalNames = payload.nodes.map((n) => {
    const name = uniqueNodeName(n.name, taken);
    taken.add(name);
    return name;
  });
  let definition: WorkflowDefinition = {
    name: '',
    nodes: clip.nodes,
    connections: clip.connections,
    pinData: clip.pinData,
  };
  payload.nodes.forEach((n, i) => {
    definition = renameNodeInDefinition(definition, n.name, `\u0001paste${i}\u0001`);
  });
  payload.nodes.forEach((_, i) => {
    definition = renameNodeInDefinition(definition, `\u0001paste${i}\u0001`, finalNames[i]);
  });

  const nodes = definition.nodes.map((n) => ({
    ...n,
    id: newId(),
    webhookId: n.webhookId ? newId() : undefined,
    position: [n.position[0] + offset[0], n.position[1] + offset[1]] as [number, number],
  }));
  for (const n of nodes) if (n.webhookId === undefined) delete n.webhookId;

  const stickies = (payload.stickyNotes ?? []).map((s) => ({
    ...s,
    id: newId(),
    position: [s.position[0] + offset[0], s.position[1] + offset[1]] as [number, number],
  }));

  // a group comes along only when all its members did; it gets a new id and a unique name
  const newIds = new Map<string, string>();
  payload.nodes.forEach((n, i) => {
    if (n.id) newIds.set(n.id, nodes[i].id);
  });
  (payload.stickyNotes ?? []).forEach((s, i) => {
    newIds.set(s.id, stickies[i].id);
  });
  const groupNames = graph.nodeGroups.map((g) => g.name);
  const pastedGroups: WorkflowNodeGroup[] = [];
  for (const g of payload.nodeGroups ?? []) {
    if (!g.nodeIds.length || !g.nodeIds.every((id) => newIds.has(id))) continue;
    const name = uniqueGroupName(g.name, groupNames);
    groupNames.push(name);
    pastedGroups.push({ ...g, id: newId(), name, nodeIds: g.nodeIds.map((id) => newIds.get(id) as string) });
  }

  return {
    graph: {
      nodes: [...graph.nodes, ...nodes],
      connections: { ...graph.connections, ...definition.connections },
      pinData: { ...graph.pinData, ...(definition.pinData ?? {}) },
      stickyNotes: [...graph.stickyNotes, ...stickies],
      nodeGroups: [...graph.nodeGroups, ...pastedGroups],
    },
    names: finalNames,
    stickyIds: stickies.map((s) => s.id),
  };
}
