/**
 * React Flow surface shared by the editor, execution view and version preview. The workflow
 * model stays the source of truth; React Flow changes are translated back into model updates.
 */
import type { NodeTypeDescription, RunData } from '@workflow/workflow';
import {
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type EdgeChange,
  type EdgeTypes,
  type FinalConnectionState,
  MiniMap,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DoctorIssue } from '../../lib/doctor';
import { canConnect, deriveNodePorts, parseHandleId } from '../../lib/ports';
import {
  type ConnectionRef,
  connectionId,
  listConnections,
  type WorkflowGraph,
} from '../../lib/workflow-ops';
import type { Selection } from '../../stores/workflow-store';
import { type CanvasActions, CanvasActionsContext } from './actions';
import { CanvasEdge } from './CanvasEdge';
import { CanvasNode } from './CanvasNode';
import { buildFlowElements, type CableEdge, type FlowNode } from './flow-elements';
import { StickyNode } from './StickyNode';

const nodeTypes: NodeTypes = { workflowNode: CanvasNode, sticky: StickyNode };
const edgeTypes: EdgeTypes = { cable: CanvasEdge };

export interface FlowCanvasProps {
  graph: WorkflowGraph;
  descriptions: { get(type: string): NodeTypeDescription | undefined };
  runData: RunData;
  runningNodes: string[];
  selection: Selection;
  issues?: Map<string, DoctorIssue[]>;
  readOnly: boolean;
  actions: CanvasActions;
  /** changes whenever a different workflow is loaded: triggers fit-to-view */
  fitKey?: number | string;
  onSelectionChange?: (selection: Partial<Selection>) => void;
  onMove?: (positions: Record<string, [number, number]>, stickies: Record<string, [number, number]>) => void;
  onDragStart?: () => void;
  onConnect?: (ref: ConnectionRef) => void;
  /** a cable was dropped on empty canvas */
  onConnectToEmpty?: (from: { nodeName: string; handleId: string }, position: [number, number]) => void;
  onPaneDoubleClick?: (position: [number, number]) => void;
  minimap?: boolean;
  children?: ReactNode;
}

export function FlowCanvas({
  graph,
  descriptions,
  runData,
  runningNodes,
  selection,
  issues,
  readOnly,
  actions,
  fitKey,
  onSelectionChange,
  onMove,
  onDragStart,
  onConnect,
  onConnectToEmpty,
  minimap = true,
  children,
}: FlowCanvasProps) {
  const flow = useReactFlow<FlowNode, CableEdge>();
  const measured = useRef(new Map<string, { width: number; height: number }>());
  const [measureTick, setMeasureTick] = useState(0);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const portsOf = useCallback(
    (name: string) => {
      const node = graph.nodes.find((n) => n.name === name);
      return node ? deriveNodePorts(node, descriptions.get(node.type)) : undefined;
    },
    [graph.nodes, descriptions],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: measureTick invalidates the memo when node sizes are measured
  const { nodes, edges } = useMemo(
    () =>
      buildFlowElements({
        ...graph,
        descriptions,
        runData,
        runningNodes,
        selectedNodes: selection.nodes,
        selectedStickies: selection.stickies,
        selectedEdges: selection.edges,
        hoveredEdge,
        issues,
        measured: measured.current,
        readOnly,
      }),
    [graph, descriptions, runData, runningNodes, selection, hoveredEdge, issues, readOnly, measureTick],
  );

  useEffect(() => {
    if (fitKey === undefined) return;
    const timer = setTimeout(() => void flow.fitView({ padding: 0.25, maxZoom: 1.1, duration: 0 }), 30);
    return () => clearTimeout(timer);
  }, [fitKey, flow]);

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      let measuredChanged = false;
      const positions: Record<string, [number, number]> = {};
      const stickyPositions: Record<string, [number, number]> = {};
      let selectionChanged = false;
      const selectedNodes = new Set(selection.nodes);
      const selectedStickies = new Set(selection.stickies);
      for (const change of changes) {
        if (change.type === 'dimensions' && change.dimensions) {
          const prev = measured.current.get(change.id);
          if (!prev || prev.width !== change.dimensions.width || prev.height !== change.dimensions.height) {
            measured.current.set(change.id, change.dimensions);
            measuredChanged = true;
          }
        } else if (change.type === 'position' && change.position && !readOnly) {
          const p: [number, number] = [Math.round(change.position.x), Math.round(change.position.y)];
          if (change.id.startsWith('sticky:')) stickyPositions[change.id.slice(7)] = p;
          else {
            const node = byId.get(change.id);
            if (node) positions[node.name] = p;
          }
        } else if (change.type === 'select') {
          selectionChanged = true;
          if (change.id.startsWith('sticky:')) {
            const id = change.id.slice(7);
            if (change.selected) selectedStickies.add(id);
            else selectedStickies.delete(id);
          } else {
            const node = byId.get(change.id);
            if (!node) continue;
            if (change.selected) selectedNodes.add(node.name);
            else selectedNodes.delete(node.name);
          }
        }
      }
      if (measuredChanged) setMeasureTick((t) => t + 1);
      if (Object.keys(positions).length || Object.keys(stickyPositions).length)
        onMove?.(positions, stickyPositions);
      if (selectionChanged)
        onSelectionChange?.({ nodes: [...selectedNodes], stickies: [...selectedStickies] });
    },
    [byId, onMove, onSelectionChange, readOnly, selection.nodes, selection.stickies],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CableEdge>[]) => {
      const selected = new Set(selection.edges);
      let changed = false;
      for (const change of changes) {
        if (change.type !== 'select') continue;
        changed = true;
        if (change.selected) selected.add(change.id);
        else selected.delete(change.id);
      }
      if (changed) onSelectionChange?.({ edges: [...selected] });
    },
    [onSelectionChange, selection.edges],
  );

  const toRef = useCallback(
    (connection: Connection | CableEdge): ConnectionRef | null => {
      const source = byId.get(connection.source);
      const target = byId.get(connection.target);
      const from = parseHandleId(connection.sourceHandle);
      const to = parseHandleId(connection.targetHandle);
      if (!source || !target || !from || !to) return null;
      return {
        source: source.name,
        sourceType: from.type,
        sourceIndex: from.index,
        target: target.name,
        targetType: to.type,
        targetIndex: to.index,
      };
    },
    [byId],
  );

  const isValidConnection = useCallback(
    (connection: Connection | CableEdge) => {
      const source = byId.get(connection.source);
      const target = byId.get(connection.target);
      if (!source || !target) return false;
      return canConnect(
        {
          source: source.name,
          target: target.name,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
        },
        graph.connections,
        portsOf,
      );
    },
    [byId, graph.connections, portsOf],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (readOnly || !isValidConnection(connection)) return;
      const ref = toRef(connection);
      if (ref) onConnect?.(ref);
    },
    [isValidConnection, onConnect, readOnly, toRef],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly || !onConnectToEmpty || state.isValid || state.toNode) return;
      const fromNode = state.fromNode ? byId.get(state.fromNode.id) : undefined;
      const handleId = state.fromHandle?.id;
      if (!fromNode || !handleId?.startsWith('out:')) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : (event as MouseEvent);
      const position = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
      onConnectToEmpty({ nodeName: fromNode.name, handleId }, [position.x, position.y - 32]);
    },
    [byId, flow, onConnectToEmpty, readOnly],
  );

  // keep hover state valid when edges disappear
  useEffect(() => {
    if (hoveredEdge && !listConnections(graph.connections).some((c) => connectionId(c) === hoveredEdge)) {
      setHoveredEdge(null);
    }
  }, [graph.connections, hoveredEdge]);

  return (
    <CanvasActionsContext.Provider value={actions}>
      <ReactFlow<FlowNode, CableEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={() => onDragStart?.()}
        onSelectionDragStart={() => onDragStart?.()}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'workflowNode') actions.openNdv(node.data.node.name);
        }}
        onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
        onEdgeMouseLeave={() => setHoveredEdge(null)}
        onPaneClick={() => onSelectionChange?.({ nodes: [], stickies: [], edges: [] })}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        panOnScroll
        zoomOnDoubleClick={false}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable
        minZoom={0.15}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        connectionRadius={28}
        defaultEdgeOptions={{ type: 'cable' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.6} color="var(--wf-grid)" />
        <Controls
          position="bottom-left"
          showInteractive={false}
          fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
        />
        {minimap && (
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeBorderRadius={6}
            nodeColor={(n) =>
              n.type === 'sticky' ? 'color-mix(in oklab, #f2c94c 45%, transparent)' : 'var(--wf-line-strong)'
            }
            ariaLabel="Mini map"
          />
        )}
        {children}
      </ReactFlow>
    </CanvasActionsContext.Provider>
  );
}
