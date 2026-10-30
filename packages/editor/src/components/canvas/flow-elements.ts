/**
 * Maps the workflow model to React Flow nodes and edges. Pure, so the editor canvas, the
 * read-only execution canvas and the version preview share it.
 */
import {
  evaluateSimple,
  type Item,
  type NodeTypeDescription,
  type RunData,
  resolveNodeParameters,
  type StickyNote,
  type WorkflowNode,
} from '@workflow/workflow';
import type { Edge, Node } from '@xyflow/react';
import type { DoctorIssue } from '../../lib/doctor';
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
}

export interface StickyNodeData extends Record<string, unknown> {
  sticky: StickyNote;
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
export type FlowNode = WorkflowFlowNode | StickyFlowNode;
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
}

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

  const stickyNodes: StickyFlowNode[] = input.stickyNotes.map((sticky) => ({
    id: `sticky:${sticky.id}`,
    type: 'sticky',
    position: { x: sticky.position[0], y: sticky.position[1] },
    width: sticky.width,
    height: sticky.height,
    zIndex: -1,
    selected: selectedStickies.has(sticky.id),
    draggable: !input.readOnly,
    data: { sticky, readOnly: input.readOnly },
    measured: input.measured?.get(`sticky:${sticky.id}`) ?? { width: sticky.width, height: sticky.height },
  }));

  const workflowNodes: WorkflowFlowNode[] = input.nodes.map((node) => {
    const description = input.descriptions.get(node.type);
    return {
      id: node.id,
      type: 'workflowNode',
      position: { x: node.position[0], y: node.position[1] },
      selected: selectedNodes.has(node.name),
      draggable: !input.readOnly,
      connectable: !input.readOnly,
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
    const sourcePorts = deriveNodePorts(source, input.descriptions.get(source.type));
    const port = sourcePorts.outputs.find((p) => p.type === ref.sourceType && p.index === ref.sourceIndex);
    const count =
      ref.sourceType === 'main'
        ? outputCounts(input.runData, input.pinData, ref.source)[ref.sourceIndex]
        : undefined;
    edges.push({
      id,
      type: 'cable',
      source: source.id,
      target: target.id,
      sourceHandle: handleId('out', ref.sourceType, ref.sourceIndex),
      targetHandle: handleId('in', ref.targetType, ref.targetIndex),
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
  return { nodes: [...stickyNodes, ...workflowNodes], edges };
}
