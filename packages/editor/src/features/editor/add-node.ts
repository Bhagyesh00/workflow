/**
 * Add a node from a node type description, as the node panel and the command bar do (P3-01):
 * where it goes and what it connects to follow the creator context (an output plus, a sub-node
 * input, a cable) or, without one, the single selected node (the new node extends the chain).
 * The new node is selected and its details view opens. While ui.replaceTarget is set (P3-11) the
 * picked node replaces that node instead (lib/replace-node.ts), as one undo step.
 */
import type { NodeParameters, NodeTypeDescription } from '@workflow/workflow';
import { createNodeFromDescription } from '../../lib/node-catalog';
import { deriveNodePorts, isTriggerDescription } from '../../lib/ports';
import { replaceNode } from '../../lib/replace-node';
import { type ConnectionRef, getNode } from '../../lib/workflow-ops';
import { type CreatorContext, toast, useUiStore } from '../../stores/ui-store';
import { graphOf, useWorkflowStore } from '../../stores/workflow-store';

const NODE_SPACING_X = 300;

export interface AddNodeContext {
  /** React Flow instance (only screenToFlowPosition is used) */
  flow: { screenToFlowPosition(point: { x: number; y: number }): { x: number; y: number } };
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  /** where the panel was opened from; default: none (the selection decides) */
  creator?: CreatorContext;
  /** preset parameters (an operation action of the catalog entry) */
  parameters?: NodeParameters;
  /** open the new node's details view (default true) */
  openNdv?: boolean;
}

/** Nudge a position down until it does not sit on an existing node. */
export function freePosition(position: [number, number]): [number, number] {
  const nodes = useWorkflowStore.getState().nodes;
  const p: [number, number] = [position[0], position[1]];
  for (
    let i = 0;
    i < 20 && nodes.some((n) => Math.abs(n.position[0] - p[0]) < 120 && Math.abs(n.position[1] - p[1]) < 60);
    i++
  ) {
    p[1] += 110;
  }
  return p;
}

/** Returns the added (or replacing) node's name, or null when nothing was added. */
export function addNodeFromDescription(description: NodeTypeDescription, ctx: AddNodeContext): string | null {
  const ui = useUiStore.getState();
  const s = useWorkflowStore.getState();
  if (s.readOnly) return null;
  const parameters = ctx.parameters;

  if (ui.replaceTarget) return replaceWith(description, ui.replaceTarget, ctx);

  const creator = ctx.creator ?? {};
  const incoming = deriveNodePorts(createNodeFromDescription(description, [0, 0], parameters), description);
  const acceptsMain = incoming.inputs.some((p) => p.type === 'main');
  let position = creator.position;
  let from: Omit<ConnectionRef, 'target'> | undefined = creator.connectFrom
    ? { ...creator.connectFrom, targetType: creator.connectFrom.sourceType, targetIndex: 0 }
    : undefined;
  let to: Omit<ConnectionRef, 'source'> | undefined;

  if (creator.connectTo) {
    const target = getNode(s, creator.connectTo.target);
    to = { ...creator.connectTo, sourceType: creator.connectTo.targetType, sourceIndex: 0 };
    position ??= target
      ? [target.position[0] + creator.connectTo.targetIndex * 100 - 20, target.position[1] + 200]
      : undefined;
  } else if (creator.connectFrom) {
    const source = getNode(s, creator.connectFrom.source);
    position ??= source
      ? [source.position[0] + NODE_SPACING_X, source.position[1] + creator.connectFrom.sourceIndex * 110]
      : undefined;
  } else if (creator.insertOn) {
    const a = getNode(s, creator.insertOn.source);
    const b = getNode(s, creator.insertOn.target);
    position ??=
      a && b ? [(a.position[0] + b.position[0]) / 2, (a.position[1] + b.position[1]) / 2 + 90] : undefined;
  } else if (s.selection.nodes.length === 1 && acceptsMain && !isTriggerDescription(description)) {
    // add after the selected node, like extending a chain
    const source = getNode(s, s.selection.nodes[0]);
    const sourcePorts = source ? deriveNodePorts(source, ctx.descriptions.get(source.type)) : undefined;
    if (source && sourcePorts?.outputs.some((p) => p.type === 'main')) {
      position ??= [source.position[0] + NODE_SPACING_X, source.position[1]];
      from = { source: source.name, sourceType: 'main', sourceIndex: 0, targetType: 'main', targetIndex: 0 };
    }
  }
  if (!position) {
    const c = ctx.flow.screenToFlowPosition({ x: window.innerWidth / 2 - 180, y: window.innerHeight / 2 });
    position = [c.x - 110, c.y - 32];
  }
  const node = createNodeFromDescription(description, freePosition(position), parameters);
  const added =
    creator.insertOn && acceptsMain
      ? s.insertOnConnection(creator.insertOn, node)
      : s.addNode(node, { from: from && acceptsMain ? from : undefined, to });
  // a refused edit (group guard) adds nothing
  if (!getNode(useWorkflowStore.getState(), added.name)) return null;
  useWorkflowStore.getState().select({ nodes: [added.name], stickies: [], edges: [] });
  ui.setSidePanel(null);
  if (ctx.openNdv !== false) ui.openNdv(added.name);
  return added.name;
}

function replaceWith(description: NodeTypeDescription, oldName: string, ctx: AddNodeContext): string | null {
  const ui = useUiStore.getState();
  const store = useWorkflowStore.getState();
  const old = getNode(store, oldName);
  if (!old) {
    ui.setSidePanel(null);
    return null;
  }
  const node = createNodeFromDescription(description, old.position, ctx.parameters);
  const result = replaceNode(graphOf(store), oldName, node, ctx.descriptions, store.nodeTypeLookup);
  if ('error' in result) {
    toast.error(`Could not replace ${oldName}`, result.error);
    return null;
  }
  store.applyGraph(result.graph, { nodes: [result.nodeName], stickies: [], edges: [] });
  ui.setSidePanel(null);
  return result.nodeName;
}
