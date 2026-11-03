/**
 * Maps the workflow model to React Flow nodes and edges. Pure, so the editor canvas, the
 * read-only execution canvas and the version preview share it.
 */
import {
  type DirtyReason,
  evaluateSimple,
  type Item,
  type NodeTypeDescription,
  type RunData,
  resolveNodeParameters,
  type StickyNote,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import type { Edge, Node } from '@xyflow/react';
import type { DoctorIssue } from '../../lib/doctor';
import {
  type Box,
  collapsedCard,
  computeGroupPush,
  DEFAULT_NODE_SIZE,
  groupFrame,
  type Offset,
} from '../../lib/group-layout-push';
import { deriveNodePorts, handleId, type NodePorts } from '../../lib/ports';
import {
  type ConnectionRef,
  connectionId,
  listConnections,
  type WorkflowGraph,
} from '../../lib/workflow-ops';
import { type NodeRunStatus, nodeRunStatus } from '../../stores/run-store';

export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  description?: NodeTypeDescription;
  ports: NodePorts;
  subtitle?: string;
  status: NodeRunStatus;
  pinned: boolean;
  /** output item count of the last run, per main output index */
  outputCounts: number[];
  issues: DoctorIssue[];
  /** output handle ids that have at least one cable */
  connectedOutputs: string[];
  connectedInputs: string[];
  readOnly: boolean;
  /** P3-06: the node's run data is stale (badge, L6) */
  dirty?: DirtyReason;
}

export interface StickyNodeData extends Record<string, unknown> {
  sticky: StickyNote;
  readOnly: boolean;
}

/** a canvas group (P3-04): the frame around its members, or one card when collapsed */
export interface GroupNodeData extends Record<string, unknown> {
  group: WorkflowNodeGroup;
  collapsed: boolean;
  /** member nodes (sticky notes not counted) */
  memberCount: number;
  /** the description shows (pinned in this browser; GroupNode also hides it below zoom 0.66) */
  descriptionPinned: boolean;
  readOnly: boolean;
}

export interface CableData extends Record<string, unknown> {
  ref: ConnectionRef;
  count?: number;
  kind: 'main' | 'ai';
  category?: 'error';
  hovered: boolean;
  readOnly: boolean;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, 'workflowNode'>;
export type StickyFlowNode = Node<StickyNodeData, 'sticky'>;
export type GroupFlowNode = Node<GroupNodeData, 'nodeGroup'>;
export type FlowNode = WorkflowFlowNode | StickyFlowNode | GroupFlowNode;

/** React Flow id of a group's frame or card */
export const groupFlowId = (groupId: string) => `group:${groupId}`;
/** handles of a collapsed card: the members' outside cables attach here */
export const GROUP_IN_HANDLE = 'group-in';
export const GROUP_OUT_HANDLE = 'group-out';
/** the class of the part of a group a drag starts from (title bar, collapsed card) */
export const GROUP_DRAG_HANDLE = 'wf-group-drag';
export type CableEdge = Edge<CableData, 'cable'>;

export interface FlowInput extends WorkflowGraph {
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  runData: RunData;
  runningNodes: string[];
  selectedNodes: string[];
  selectedStickies: string[];
  selectedEdges?: string[];
  hoveredEdge?: string | null;
  issues?: Map<string, DoctorIssue[]>;
  measured?: Map<string, { width: number; height: number }>;
  readOnly: boolean;
  /** P3-06: stale nodes by name */
  dirtyNodes?: Record<string, DirtyReason>;
  /** P3-04: expanded group ids (every other group shows collapsed); none when absent */
  expandedGroups?: ReadonlySet<string>;
  /** P3-04: group ids whose description is pinned in this browser */
  pinnedGroupDescriptions?: ReadonlySet<string>;
}

interface GroupLayout {
  group: WorkflowNodeGroup;
  collapsed: boolean;
  pinned: boolean;
  frame: Box;
  card: Box;
  memberCount: number;
}

/**
 * Frames, cards and the view-only push offsets of the groups. Offsets move display positions
 * only; the graph (and so the save body) keeps the stored positions.
 */
function layoutGroups(input: FlowInput): {
  groups: GroupLayout[];
  groupOf: Map<string, string>;
  offsetOf: (id: string) => Offset | undefined;
  groupOffset: (groupId: string) => Offset | undefined;
} {
  const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
  const stickyById = new Map(input.stickyNotes.map((s) => [s.id, s]));
  const sizeOf = (id: string, fallback: { width: number; height: number }) =>
    input.measured?.get(id) ?? fallback;
  const groupOf = new Map<string, string>();
  const groups: GroupLayout[] = [];
  for (const group of input.nodeGroups) {
    const boxes: Box[] = [];
    let memberCount = 0;
    for (const id of group.nodeIds) {
      if (groupOf.has(id)) continue;
      const node = nodeById.get(id);
      const sticky = stickyById.get(id);
      if (node) {
        memberCount++;
        boxes.push({ x: node.position[0], y: node.position[1], ...sizeOf(id, DEFAULT_NODE_SIZE) });
      } else if (sticky) {
        const size = sizeOf(`sticky:${id}`, { width: sticky.width, height: sticky.height });
        boxes.push({ x: sticky.position[0], y: sticky.position[1], ...size });
      } else continue;
      groupOf.set(id, group.id);
    }
    if (!memberCount) continue;
    const collapsed = !input.expandedGroups?.has(group.id);
    const pinned =
      Boolean(group.description?.trim()) && Boolean(input.pinnedGroupDescriptions?.has(group.id));
    const frame = groupFrame(boxes);
    groups.push({ group, collapsed, pinned, frame, card: collapsedCard(frame, pinned), memberCount });
  }
  const loose = input.nodes
    .filter((n) => !groupOf.has(n.id))
    .map((n) => ({
      id: n.id,
      box: { x: n.position[0], y: n.position[1], ...sizeOf(n.id, DEFAULT_NODE_SIZE) },
    }));
  const push = groups.some((g) => !g.collapsed)
    ? computeGroupPush(
        groups.map((g) => ({
          id: g.group.id,
          expanded: !g.collapsed,
          box: g.collapsed ? g.card : g.frame,
          chip: g.card,
        })),
        loose,
      )
    : { groups: new Map<string, Offset>(), nodes: new Map<string, Offset>() };
  const groupOffset = (groupId: string) => push.groups.get(groupId);
  const offsetOf = (id: string) => {
    const groupId = groupOf.get(id);
    return groupId ? push.groups.get(groupId) : push.nodes.get(id);
  };
  return { groups, groupOf, offsetOf, groupOffset };
}

const moved = (x: number, y: number, offset?: Offset) => ({
  x: x + (offset?.x ?? 0),
  y: y + (offset?.y ?? 0),
});

const subtitleCache = new WeakMap<WorkflowNode, string | undefined>();

export function nodeSubtitle(
  node: WorkflowNode,
  description: NodeTypeDescription | undefined,
): string | undefined {
  if (!description?.subtitle) return undefined;
  if (subtitleCache.has(node)) return subtitleCache.get(node);
  let subtitle: string | undefined;
  try {
    const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
      nodeVersion: node.typeVersion,
    });
    const value = evaluateSimple(
      description.subtitle,
      { $parameter: params },
      { timeoutMs: 20, maxSteps: 20_000 },
    );
    subtitle = value === undefined || value === null || value === '' ? undefined : String(value);
  } catch {
    subtitle = undefined;
  }
  subtitleCache.set(node, subtitle);
  return subtitle;
}

export const edgeId = connectionId;

function outputCounts(runData: RunData, pinData: Record<string, Item[]>, name: string): number[] {
  const runs = runData[name];
  if (runs?.length) {
    const main = runs[runs.length - 1].data?.main ?? [];
    return main.map((items) => items?.length ?? 0);
  }
  if (pinData[name]) return [pinData[name].length];
  return [];
}

export function buildFlowElements(input: FlowInput): { nodes: FlowNode[]; edges: CableEdge[] } {
  const selectedNodes = new Set(input.selectedNodes);
  const selectedStickies = new Set(input.selectedStickies);
  const selectedEdges = new Set(input.selectedEdges ?? []);
  const connections = listConnections(input.connections);
  const byName = new Map(input.nodes.map((n) => [n.name, n]));
  const connectedOutputs = new Map<string, string[]>();
  const connectedInputs = new Map<string, string[]>();
  for (const c of connections) {
    connectedOutputs.set(c.source, [
      ...(connectedOutputs.get(c.source) ?? []),
      handleId('out', c.sourceType, c.sourceIndex),
    ]);
    connectedInputs.set(c.target, [
      ...(connectedInputs.get(c.target) ?? []),
      handleId('in', c.targetType, c.targetIndex),
    ]);
  }

  const layout = layoutGroups(input);
  const collapsedGroupOf = new Map<string, string>();
  for (const g of layout.groups) {
    if (!g.collapsed) continue;
    for (const id of g.group.nodeIds)
      if (layout.groupOf.get(id) === g.group.id) collapsedGroupOf.set(id, g.group.id);
  }
  /** a member of a collapsed group stays mounted (its measured size keeps the frame right) but is not shown */
  const hiddenMember = { opacity: 0, pointerEvents: 'none' as const };

  const groupNodes: GroupFlowNode[] = layout.groups.map((g) => {
    const box = g.collapsed ? g.card : g.frame;
    return {
      id: groupFlowId(g.group.id),
      type: 'nodeGroup',
      position: moved(box.x, box.y, layout.groupOffset(g.group.id)),
      width: box.width,
      height: box.height,
      // an expanded frame sits behind sticky notes and nodes; a collapsed card stands in for its members
      zIndex: g.collapsed ? 1 : -2,
      selectable: false,
      connectable: false,
      draggable: !input.readOnly,
      dragHandle: `.${GROUP_DRAG_HANDLE}`,
      ariaLabel: g.collapsed
        ? `Group ${g.group.name}, collapsed, ${g.memberCount === 1 ? '1 node' : `${g.memberCount} nodes`}`
        : `Group ${g.group.name}`,
      // the frame's empty area lets clicks and box selection through; its title bar takes them
      // (set both ways: React Flow turns pointer events off for a node that cannot be dragged or selected)
      style: { pointerEvents: g.collapsed ? 'all' : 'none' },
      data: {
        group: g.group,
        collapsed: g.collapsed,
        memberCount: g.memberCount,
        descriptionPinned: g.pinned,
        readOnly: input.readOnly,
      },
      measured: { width: box.width, height: box.height },
    };
  });

  const stickyNodes: StickyFlowNode[] = input.stickyNotes.map((sticky) => ({
    id: `sticky:${sticky.id}`,
    type: 'sticky',
    position: moved(sticky.position[0], sticky.position[1], layout.offsetOf(sticky.id)),
    width: sticky.width,
    height: sticky.height,
    zIndex: -1,
    selected: selectedStickies.has(sticky.id),
    draggable: !input.readOnly && !collapsedGroupOf.has(sticky.id),
    ...(collapsedGroupOf.has(sticky.id) ? { style: hiddenMember, selectable: false } : {}),
    data: { sticky, readOnly: input.readOnly },
    measured: input.measured?.get(`sticky:${sticky.id}`) ?? { width: sticky.width, height: sticky.height },
  }));

  const workflowNodes: WorkflowFlowNode[] = input.nodes.map((node) => {
    const description = input.descriptions.get(node.type);
    const hidden = collapsedGroupOf.has(node.id);
    return {
      id: node.id,
      type: 'workflowNode',
      position: moved(node.position[0], node.position[1], layout.offsetOf(node.id)),
      selected: selectedNodes.has(node.name),
      draggable: !input.readOnly && !hidden,
      connectable: !input.readOnly && !hidden,
      ...(hidden ? { style: hiddenMember, selectable: false, focusable: false } : {}),
      data: {
        node,
        description,
        ports: deriveNodePorts(node, description),
        subtitle: nodeSubtitle(node, description),
        status: nodeRunStatus({ runData: input.runData, runningNodes: input.runningNodes }, node.name),
        pinned: Boolean(input.pinData[node.name]),
        outputCounts: outputCounts(input.runData, input.pinData, node.name),
        issues: input.issues?.get(node.name) ?? [],
        connectedOutputs: connectedOutputs.get(node.name) ?? [],
        connectedInputs: connectedInputs.get(node.name) ?? [],
        readOnly: input.readOnly,
        ...(input.dirtyNodes?.[node.name] ? { dirty: input.dirtyNodes[node.name] } : {}),
      },
      measured: input.measured?.get(node.id),
    };
  });

  const edges: CableEdge[] = [];
  for (const ref of connections) {
    const source = byName.get(ref.source);
    const target = byName.get(ref.target);
    if (!source || !target) continue;
    const id = edgeId(ref);
    // a collapsed card takes its members' outside cables; cables inside it are not shown
    const sourceGroup = collapsedGroupOf.get(source.id);
    const targetGroup = collapsedGroupOf.get(target.id);
    const insideCard = sourceGroup !== undefined && sourceGroup === targetGroup;
    const sourcePorts = deriveNodePorts(source, input.descriptions.get(source.type));
    const port = sourcePorts.outputs.find((p) => p.type === ref.sourceType && p.index === ref.sourceIndex);
    const count =
      ref.sourceType === 'main'
        ? outputCounts(input.runData, input.pinData, ref.source)[ref.sourceIndex]
        : undefined;
    edges.push({
      id,
      type: 'cable',
      source: sourceGroup ? groupFlowId(sourceGroup) : source.id,
      target: targetGroup ? groupFlowId(targetGroup) : target.id,
      sourceHandle: sourceGroup ? GROUP_OUT_HANDLE : handleId('out', ref.sourceType, ref.sourceIndex),
      targetHandle: targetGroup ? GROUP_IN_HANDLE : handleId('in', ref.targetType, ref.targetIndex),
      ...(insideCard ? { hidden: true } : {}),
      selected: selectedEdges.has(id),
      data: {
        ref,
        count,
        kind: ref.sourceType === 'main' ? 'main' : 'ai',
        category: port?.category,
        hovered: input.hoveredEdge === id,
        readOnly: input.readOnly,
      },
    });
  }
  return { nodes: [...groupNodes, ...stickyNodes, ...workflowNodes], edges };
}
