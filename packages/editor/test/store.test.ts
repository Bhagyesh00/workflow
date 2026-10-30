import type { WorkflowNode } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  connectionId,
  disconnect,
  EMPTY_GRAPH,
  extractSubgraph,
  getAncestors,
  insertNodeOnConnection,
  listConnections,
  normalizeNodes,
  parseClipboard,
  pasteSubgraph,
  RenameError,
  removeNodes,
  renameNode,
  setIn,
  setNodeParameter,
  uniqueNodeName,
  type WorkflowGraph,
} from '../src/lib/workflow-ops';
import { useWorkflowStore } from '../src/stores/workflow-store';

const node = (name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type: 'core.set',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
  ...extra,
});

const main = (source: string, target: string, sourceIndex = 0, targetIndex = 0) => ({
  source,
  sourceType: 'main' as const,
  sourceIndex,
  target,
  targetType: 'main' as const,
  targetIndex,
});

function chain(): WorkflowGraph {
  let g: WorkflowGraph = { ...EMPTY_GRAPH, nodes: [node('A'), node('B'), node('C')] };
  g = connect(g, main('A', 'B'));
  g = connect(g, main('B', 'C'));
  return { ...g, pinData: { B: [{ json: { x: 1 } }] } };
}

describe('names', () => {
  it('appends the first free number', () => {
    expect(uniqueNodeName('Edit Fields', [])).toBe('Edit Fields');
    expect(uniqueNodeName('Edit Fields', ['Edit Fields'])).toBe('Edit Fields1');
    expect(uniqueNodeName('Edit Fields', ['Edit Fields', 'Edit Fields1'])).toBe('Edit Fields2');
    expect(uniqueNodeName('Edit Fields1', ['Edit Fields1'])).toBe('Edit Fields2');
  });

  it('addNode makes names unique and assigns ids', () => {
    const g1 = addNode(EMPTY_GRAPH, node('Code'));
    const g2 = addNode(g1.graph, { ...node('Code'), id: g1.node.id });
    expect(g2.node.name).toBe('Code1');
    expect(g2.node.id).not.toBe(g1.node.id);
    expect(g2.graph.nodes).toHaveLength(2);
  });

  it('normalizeNodes repairs missing and duplicate ids', () => {
    const nodes = normalizeNodes([{ ...node('A'), id: '' }, node('B'), { ...node('C'), id: 'id-B' }]);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(3);
  });
});

describe('graph operations', () => {
  it('removeNodes drops the node, its cables and its pinned data', () => {
    const g = removeNodes(chain(), ['B']);
    expect(g.nodes.map((n) => n.name)).toEqual(['A', 'C']);
    expect(listConnections(g.connections)).toEqual([]);
    expect(g.pinData.B).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const g = chain();
    const before = JSON.stringify(g);
    removeNodes(g, ['A']);
    renameNode(g, 'A', 'Start');
    setNodeParameter(g, 'A', ['x'], 1);
    expect(JSON.stringify(g)).toBe(before);
  });

  it('connect is idempotent and disconnect removes exactly one cable', () => {
    let g = connect(chain(), main('A', 'B'));
    expect(listConnections(g.connections)).toHaveLength(2);
    g = connect(g, main('A', 'C'));
    g = disconnect(g, main('A', 'B'));
    expect(listConnections(g.connections).map(connectionId)).toEqual([
      connectionId(main('A', 'C')),
      connectionId(main('B', 'C')),
    ]);
  });

  it('rename updates connections, pinned data and expressions', () => {
    let g = chain();
    g = setNodeParameter(g, 'C', ['value'], "={{ $('B').item.json.x }}");
    g = setNodeParameter(g, 'C', ['legacy'], '={{ $node["B"].json.x }}');
    g = renameNode(g, 'B', 'Middle');
    expect(g.nodes.map((n) => n.name)).toEqual(['A', 'Middle', 'C']);
    expect(listConnections(g.connections).map((c) => `${c.source}>${c.target}`)).toEqual([
      'A>Middle',
      'Middle>C',
    ]);
    expect(g.pinData.Middle).toHaveLength(1);
    const c = g.nodes.find((n) => n.name === 'C')!;
    expect(c.parameters.value).toBe("={{ $('Middle').item.json.x }}");
    expect(c.parameters.legacy).toBe('={{ $node["Middle"].json.x }}');
  });

  it('rename refuses empty and duplicate names', () => {
    expect(() => renameNode(chain(), 'A', 'B')).toThrow(RenameError);
    expect(() => renameNode(chain(), 'A', '  ')).toThrow(RenameError);
  });

  it('setIn writes nested paths immutably and removes on undefined', () => {
    const value = { options: { timeout: 1 }, list: [{ a: 1 }, { a: 2 }] };
    expect(setIn(value, ['options', 'retries'], 3)).toEqual({
      options: { timeout: 1, retries: 3 },
      list: value.list,
    });
    expect(setIn(value, ['list', 0], undefined)).toEqual({ ...value, list: [{ a: 2 }] });
    expect(setIn(value, ['options', 'timeout'], undefined)).toEqual({ ...value, options: {} });
    expect(() => setIn({}, ['__proto__', 'x'], 1)).toThrow();
  });

  it('insertNodeOnConnection rewires source -> new -> target', () => {
    let g = { ...chain(), nodes: [...chain().nodes, node('New')] };
    g = insertNodeOnConnection(g, main('A', 'B'), 'New');
    expect(
      listConnections(g.connections)
        .map((c) => `${c.source}>${c.target}`)
        .sort(),
    ).toEqual(['A>New', 'B>C', 'New>B']);
  });

  it('getAncestors walks main connections only', () => {
    let g = chain();
    g = connect(g, {
      source: 'C',
      sourceType: 'ai_tool',
      sourceIndex: 0,
      target: 'A',
      targetType: 'ai_tool',
      targetIndex: 0,
    });
    expect(getAncestors(g.connections, 'C')).toEqual(['B', 'A']);
  });
});

describe('clipboard', () => {
  it('copies internal connections and pastes with unique names and rewritten references', () => {
    let g = chain();
    g = setNodeParameter(g, 'C', ['v'], "={{ $('B').item.json.x }}");
    const clip = extractSubgraph(g, ['B', 'C']);
    expect(listConnections(clip.connections)).toEqual([main('B', 'C')]);
    const text = JSON.stringify(clip);
    const parsed = parseClipboard(text)!;
    const result = pasteSubgraph(g, parsed, [10, 20]);
    expect(result.names).toEqual(['B1', 'C1']);
    const pastedC = result.graph.nodes.find((n) => n.name === 'C1')!;
    expect(pastedC.parameters.v).toBe("={{ $('B1').item.json.x }}");
    expect(listConnections(result.graph.connections).map((c) => `${c.source}>${c.target}`)).toContain(
      'B1>C1',
    );
    expect(pastedC.position).toEqual([10, 20]);
    expect(result.graph.pinData.B1).toEqual(g.pinData.B);
    expect(new Set(result.graph.nodes.map((n) => n.id)).size).toBe(result.graph.nodes.length);
  });

  it('rejects text that is not a workflow selection', () => {
    expect(parseClipboard('hello')).toBeNull();
    expect(parseClipboard('{"foo":1}')).toBeNull();
    expect(parseClipboard('{"nodes":[{"name":"X"}]}')).toBeNull();
  });
});

describe('workflow store', () => {
  beforeEach(() => useWorkflowStore.getState().reset());

  it('tracks dirty state, undo and redo', () => {
    const s = useWorkflowStore.getState();
    s.load({ id: 'w1', name: 'Flow', nodes: [node('A')], connections: {} });
    expect(useWorkflowStore.getState().dirty).toBe(false);
    s.addNode(node('B'), {
      from: { source: 'A', sourceType: 'main', sourceIndex: 0, targetType: 'main', targetIndex: 0 },
    });
    expect(useWorkflowStore.getState().dirty).toBe(true);
    expect(listConnections(useWorkflowStore.getState().connections)).toHaveLength(1);
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['B']);
    s.undo();
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['A']);
    s.redo();
    expect(useWorkflowStore.getState().nodes.map((n) => n.name)).toEqual(['A', 'B']);
  });

  it('setParameter and rename go through history', () => {
    const s = useWorkflowStore.getState();
    s.load({ name: 'Flow', nodes: [node('A'), node('B')], connections: {} });
    s.setParameter('B', ['value'], "={{ $('A').item.json.id }}");
    s.renameNode('A', 'Start');
    expect(useWorkflowStore.getState().nodes[1].parameters.value).toBe("={{ $('Start').item.json.id }}");
    s.undo();
    expect(useWorkflowStore.getState().nodes[0].name).toBe('A');
  });

  it('deleteSelection removes nodes, stickies and selected cables', () => {
    const s = useWorkflowStore.getState();
    const g = chain();
    s.load({
      name: 'Flow',
      nodes: g.nodes,
      connections: g.connections,
      stickyNotes: [{ id: 's1', content: '', position: [0, 0], width: 100, height: 100 }],
    });
    s.select({ nodes: [], stickies: ['s1'], edges: [connectionId(main('A', 'B'))] });
    s.deleteSelection();
    const state = useWorkflowStore.getState();
    expect(state.stickyNotes).toHaveLength(0);
    expect(listConnections(state.connections).map((c) => `${c.source}>${c.target}`)).toEqual(['B>C']);
    expect(state.nodes).toHaveLength(3);
  });

  it('duplicates the selection next to the original', () => {
    const s = useWorkflowStore.getState();
    const g = chain();
    s.load({ name: 'Flow', nodes: g.nodes, connections: g.connections });
    s.select({ nodes: ['A', 'B'] });
    const names = s.duplicateSelection();
    expect(names).toEqual(['A1', 'B1']);
    expect(useWorkflowStore.getState().selection.nodes).toEqual(['A1', 'B1']);
  });

  it('read-only workflows ignore edits', () => {
    const s = useWorkflowStore.getState();
    s.load({ name: 'Flow', nodes: [node('A')], connections: {} }, { readOnly: true });
    s.removeNodes(['A']);
    s.setName('Other');
    expect(useWorkflowStore.getState().nodes).toHaveLength(1);
    expect(useWorkflowStore.getState().meta.name).toBe('Flow');
  });

  it('markSaved keeps dirty when edits happened during the save', () => {
    const s = useWorkflowStore.getState();
    s.load({ id: 'w1', name: 'Flow', nodes: [node('A')], connections: {} });
    s.setName('Renamed');
    const revision = useWorkflowStore.getState().revision;
    s.setName('Renamed again');
    s.markSaved({ id: 'w1', versionId: 'v2' }, revision);
    expect(useWorkflowStore.getState().dirty).toBe(true);
    s.markSaved({ id: 'w1', versionId: 'v3' }, useWorkflowStore.getState().revision);
    expect(useWorkflowStore.getState().dirty).toBe(false);
    expect(useWorkflowStore.getState().meta.versionId).toBe('v3');
  });
});
