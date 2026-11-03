/**
 * Replace a node (P3-11, as n8n useCanvasOperations replaceNode): the new node takes the old one's
 * position and the connections its type accepts (others are dropped), stays in the old node's group,
 * and the old node is removed. Refused (graph unchanged) when validateWorkflowNodeGroups on the
 * result is not empty. Other nodes' $('Old') references are not rewritten (as n8n).
 *
 * features/editor/add-node.ts calls it while ui.replaceTarget is set and applies the result as one
 * undo step.
 */
import {
  type Connection,
  type Connections,
  type ConnectionType,
  type NodeConnections,
  type NodeDescriptionLookup,
  type NodeTypeDescription,
  validateWorkflowNodeGroups,
  type WorkflowNode,
} from '@workflow/workflow';
import { newId } from './ids';
import { blockedEditMessage } from './node-groups';
import { deriveNodePorts } from './ports';
import { uniqueNodeName, type WorkflowGraph } from './workflow-ops';

export type ReplaceNodeResult =
  | { graph: WorkflowGraph /** the new node's final name */; nodeName: string }
  /** the group's blocked message; nothing changes */
  | { error: string };

export function replaceNode(
  graph: WorkflowGraph,
  oldName: string,
  replacement: WorkflowNode,
  descriptions: { get(type: string): NodeTypeDescription | undefined },
  types?: NodeDescriptionLookup,
): ReplaceNodeResult {
  const old = graph.nodes.find((n) => n.name === oldName);
  if (!old) return { error: `There is no node named "${oldName}".` };

  const others = graph.nodes.filter((n) => n.name !== oldName);
  const taken = new Set(others.map((n) => n.id));
  const added: WorkflowNode = {
    ...replacement,
    id: replacement.id && replacement.id !== old.id && !taken.has(replacement.id) ? replacement.id : newId(),
    name: uniqueNodeName(
      replacement.name,
      others.map((n) => n.name),
    ),
    position: [old.position[0], old.position[1]],
  };
  const ports = deriveNodePorts(added, descriptions.get(added.type));
  const accepts = (
    list: Array<{ type: ConnectionType; index: number }>,
    type: ConnectionType,
    index: number,
  ) => list.some((p) => p.type === type && p.index === index);

  const connections: Connections = {};
  for (const [source, byType] of Object.entries(graph.connections)) {
    // the old node's own outputs move to the new node, when it has that output
    const from = source === oldName ? added.name : source;
    const kept: NodeConnections = {};
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      kept[type] = (outputs ?? []).map((dests, outIndex) => {
        if (source === oldName && !accepts(ports.outputs, type, outIndex)) return [];
        return (dests ?? []).flatMap((d): Connection[] => {
          if (d.node === oldName) {
            // a cable into the old node stays when the new node has that input
            return accepts(ports.inputs, d.type, d.index) ? [{ ...d, node: added.name }] : [];
          }
          return d.node === added.name ? [] : [d];
        });
      });
    }
    connections[from] = kept;
  }

  const nodes = graph.nodes.map((n) => (n.name === oldName ? added : n));
  const pinData = { ...graph.pinData };
  delete pinData[oldName];
  const result: WorkflowGraph = {
    ...graph,
    nodes,
    connections,
    pinData,
    nodeGroups: graph.nodeGroups.map((g) =>
      g.nodeIds.includes(old.id)
        ? { ...g, nodeIds: g.nodeIds.map((id) => (id === old.id ? added.id : id)) }
        : g,
    ),
  };

  if (result.nodeGroups.length) {
    const lookup: NodeDescriptionLookup = (type, version) =>
      types?.(type, version) ?? descriptions.get(type) ?? ({ group: [] } as unknown as NodeTypeDescription);
    const problem = validateWorkflowNodeGroups(
      {
        name: '',
        nodes: result.nodes,
        connections: result.connections,
        stickyNotes: result.stickyNotes,
        nodeGroups: result.nodeGroups,
      },
      lookup,
    )[0];
    if (problem) {
      const group = result.nodeGroups.find((g) => g.id === problem.groupId);
      return { error: blockedEditMessage(problem.code, group?.name ?? '') };
    }
  }
  return { graph: result, nodeName: added.name };
}
