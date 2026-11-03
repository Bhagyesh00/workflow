/**
 * Tidy up (P3-03, as n8n): lay out the whole workflow, or the selected nodes, left to right with
 * dagre (lib/auto-layout.ts), as one undo step (store.applyGraph), then fit the view (or
 * the selection's bounds). Connections never change.
 *
 * Sizes come from the canvas: each node's measured box, and the card of every collapsed group.
 * Triggers and the AI input order come from the node descriptions. A selection of fewer than 2
 * nodes tidies the whole canvas. Read-only workflows are never changed.
 */
import type { ReactFlowInstance } from '@xyflow/react';
import { groupFlowId } from '../../components/canvas/flow-elements';
import {
  type AutoLayoutInput,
  LAYOUT_DEFAULT_SIZE,
  type LayoutSize,
  layoutWorkflow,
} from '../../lib/auto-layout';
import { collapsedCard } from '../../lib/group-layout-push';
import { isGroupDescriptionPinned, isGroupExpanded } from '../../lib/group-view';
import { deriveNodePorts, isTriggerDescription } from '../../lib/ports';
import { graphOf, useWorkflowStore } from '../../stores/workflow-store';

/** a selection of 2+ nodes (and the stickies that ride along); omitted = the whole canvas */
export interface TidyUpTarget {
  nodes: string[];
  stickies?: string[];
}

const FIT = { padding: 0.25, maxZoom: 1.1, duration: 200 } as const;

export function tidyUp(flow: ReactFlowInstance, target?: TidyUpTarget): void {
  const store = useWorkflowStore.getState();
  if (store.readOnly || !store.nodes.length) return;

  const known = new Set(store.nodes.map((n) => n.name));
  const selected = target ? [...new Set(target.nodes.filter((name) => known.has(name)))] : [];
  const scope = selected.length >= 2 ? { nodes: selected, stickies: target?.stickies ?? [] } : undefined;

  const measuredSize = (flowId: string): LayoutSize | undefined => {
    const n = flow.getNode(flowId);
    const width = n?.measured?.width ?? n?.width;
    const height = n?.measured?.height ?? n?.height;
    return width && height ? { width, height } : undefined;
  };

  const sizes: Record<string, LayoutSize> = {};
  const triggers: string[] = [];
  const aiInputs: Record<string, string[]> = {};
  for (const node of store.nodes) {
    const size = measuredSize(node.id);
    if (size) sizes[node.name] = size;
    const description = store.nodeTypeLookup?.(node.type, node.typeVersion);
    if (!description) continue;
    if (isTriggerDescription(description)) triggers.push(node.name);
    const ai = deriveNodePorts(node, description)
      .inputs.map((p) => p.type)
      .filter((type, i, all) => type !== 'main' && all.indexOf(type) === i);
    if (ai.length) aiInputs[node.name] = ai;
  }

  const collapsedGroups: Record<string, LayoutSize> = {};
  for (const group of store.nodeGroups) {
    if (isGroupExpanded(group.id)) continue;
    const card = collapsedCard({ x: 0, y: 0, width: 0, height: 0 }, isGroupDescriptionPinned(group.id));
    collapsedGroups[group.id] = measuredSize(groupFlowId(group.id)) ?? {
      width: card.width,
      height: card.height,
    };
  }

  const input: AutoLayoutInput = {
    nodes: store.nodes,
    connections: store.connections,
    stickyNotes: store.stickyNotes,
    nodeGroups: store.nodeGroups,
    sizes,
    defaultSize: LAYOUT_DEFAULT_SIZE,
    target: scope,
    collapsedGroups,
    triggers,
    aiInputs,
  };
  const result = layoutWorkflow(input);

  const nodes = store.nodes.map((n) => {
    const p = result.positions[n.name];
    return p && (p[0] !== n.position[0] || p[1] !== n.position[1]) ? { ...n, position: p } : n;
  });
  const stickyNotes = store.stickyNotes.map((s) => {
    const p = result.stickyPositions[s.id];
    return p ? { ...s, position: p } : s;
  });
  const changed =
    nodes.some((n, i) => n !== store.nodes[i]) || Object.keys(result.stickyPositions).length > 0;
  if (changed) store.applyGraph({ ...graphOf(store), nodes, stickyNotes });

  if (scope) {
    const boxes = [
      ...scope.nodes.map((name) => {
        const node = nodes.find((n) => n.name === name)!;
        const size = sizes[name] ?? LAYOUT_DEFAULT_SIZE;
        return { x: node.position[0], y: node.position[1], width: size.width, height: size.height };
      }),
      ...stickyNotes
        .filter((s) => scope.stickies.includes(s.id))
        .map((s) => ({ x: s.position[0], y: s.position[1], width: s.width, height: s.height })),
    ];
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.max(...boxes.map((b) => b.y + b.height));
    // the bounds are known now: no need to wait for the canvas to show the new positions
    void flow.fitBounds(
      { x, y, width: right - x, height: bottom - y },
      { padding: FIT.padding, duration: FIT.duration },
    );
    return;
  }
  // fitView reads the canvas' own node positions: wait until it has drawn the new ones
  afterPaint(() => void flow.fitView(FIT));
}

function afterPaint(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(run));
  else setTimeout(run, 30);
}
