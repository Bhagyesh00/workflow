/**
 * P3-04 canvas groups (L4): pure group operations, the crossing-edit guard with auto-extend,
 * group-aware graph ops (delete, copy/paste, insert), the push layout and the per-browser view state.
 */
import type { Connections, NodeDescriptionLookup, WorkflowNode, WorkflowNodeGroup } from '@workflow/workflow';
import { beforeEach, describe, expect, it } from 'vitest';
import { demoNodeTypes } from '../src/demo/fixtures';
import {
  COLLAPSED_GROUP_WIDTH,
  computeGroupPush,
  DESCRIPTION_MIN_ZOOM,
  GROUP_HEADER,
  GROUP_PADDING,
  groupFrame,
  PUSH_GAP,
  showsGroupDescription,
} from '../src/lib/group-layout-push';
import {
  isGroupDescriptionPinned,
  isGroupExpanded,
  setGroupDescriptionPinned,
  setGroupsExpanded,
} from '../src/lib/group-view';
import {
  blockedEditMessage,
  consumeGroupRenameRequest,
  crossingEditError,
  extendGroupsForConnection,
  groupNodes,
  moveNodeGroup,
  renameNodeGroup,
  setNodeGroupDescription,
  ungroupNodes,
} from '../src/lib/node-groups';
import {
  type ConnectionRef,
  connect,
  EMPTY_GRAPH,
  extractSubgraph,
  insertNodeOnConnection,
  parseClipboard,
  pasteSubgraph,
  removeNodes,
  removeStickies,
  uniqueGroupName,
  type WorkflowGraph,
} from '../src/lib/workflow-ops';
import { useWorkflowStore } from '../src/stores/workflow-store';

const types: NodeDescriptionLookup = (type) => demoNodeTypes.find((d) => d.name === type);

const node = (id: string, name: string, x: number, type = 'core.set', y = 0): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});

const main = (target: string) => [{ node: target, type: 'main' as const, index: 0 }];

const ref = (source: string, target: string, type: 'main' | 'ai_languageModel' = 'main'): ConnectionRef => ({
  source,
  sourceType: type,
  sourceIndex: 0,
  target,
  targetType: type,
  targetIndex: 0,
});

/** S -> A -> B -> C -> X, Y and Z loose, group G = A, B, C */
function chain(extra: Partial<WorkflowGraph> = {}): WorkflowGraph {
  const connections: Connections = {
    S: { main: [main('A')] },
    A: { main: [main('B')] },
    B: { main: [main('C')] },
    C: { main: [main('X')] },
  };
  return {
    ...EMPTY_GRAPH,
    nodes: [
      node('s', 'S', 0),
      node('a', 'A', 200),
      node('b', 'B', 400),
      node('c', 'C', 600),
      node('x', 'X', 800),
      node('y', 'Y', 400, 'core.set', 400),
      node('z', 'Z', 800, 'core.set', 400),
    ],
    connections,
    nodeGroups: [{ id: 'g', name: 'G', nodeIds: ['a', 'b', 'c'] }],
    ...extra,
  };
}

const group = (graph: WorkflowGraph, id = 'g') => graph.nodeGroups.find((g) => g.id === id);

// ---------------------------------------------------------------------------------------------
describe('group operations', () => {
  it('groups the named nodes with default names Group, Group 2 and asks for an inline rename', () => {
    const base = chain({ nodeGroups: [] });
    const first = groupNodes(base, ['A', 'B'], types);
    expect(first.problems).toEqual([]);
    expect(first.groupId).toBeTruthy();
    expect(group(first.graph, first.groupId!)).toMatchObject({ name: 'Group', nodeIds: ['a', 'b'] });
    expect(consumeGroupRenameRequest(first.groupId!)).toBe(true);
    expect(consumeGroupRenameRequest(first.groupId!)).toBe(false);

    const second = groupNodes(first.graph, ['X'], types);
    expect(group(second.graph, second.groupId!)?.name).toBe('Group 2');
    expect(base.nodeGroups).toEqual([]);
  });

  it('refuses a selection the rules block and leaves the graph unchanged', () => {
    const base = chain({ nodeGroups: [] });
    const withTrigger = {
      ...base,
      nodes: base.nodes.map((n) => (n.name === 'S' ? { ...n, type: 'core.manualTrigger' } : n)),
    };
    const result = groupNodes(withTrigger, ['S', 'A'], types);
    expect(result.groupId).toBeNull();
    expect(result.problems[0].code).toBe('trigger');
    expect(result.graph).toBe(withTrigger);
    expect(groupNodes(base, ['A', 'C'], types).problems.map((p) => p.code)).toContain('disconnected');
  });

  it('takes the AI sub-nodes of a selected agent along', () => {
    const graph: WorkflowGraph = {
      ...EMPTY_GRAPH,
      nodes: [node('ag', 'Agent', 0, 'ai.agent'), node('m', 'Model', 0, 'ai.lmChatDemo', 200)],
      connections: { Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] } },
    };
    const result = groupNodes(graph, ['Agent'], types);
    expect(group(result.graph, result.groupId!)?.nodeIds).toEqual(['ag', 'm']);
  });

  it('ungroups, renames (unique, trimmed, empty ignored) and moves every member', () => {
    const base = chain({
      nodeGroups: [
        { id: 'g', name: 'G', nodeIds: ['a', 'b', 'c'] },
        { id: 'h', name: 'Other', nodeIds: ['x'] },
      ],
    });
    expect(ungroupNodes(base, 'g').nodeGroups.map((g) => g.id)).toEqual(['h']);
    expect(group(renameNodeGroup(base, 'g', '  Clean up  '))?.name).toBe('Clean up');
    expect(group(renameNodeGroup(base, 'g', 'Other'))?.name).toBe('Other 2');
    expect(renameNodeGroup(base, 'g', '   ')).toBe(base);
    expect(renameNodeGroup(base, 'g', 'G')).toBe(base);

    const moved = moveNodeGroup(base, 'g', 15.4, -20);
    expect(moved.nodes.find((n) => n.id === 'a')?.position).toEqual([215, -20]);
    expect(moved.nodes.find((n) => n.id === 'c')?.position).toEqual([615, -20]);
    expect(moved.nodes.find((n) => n.id === 's')?.position).toEqual([0, 0]);
  });

  it('sets, trims, caps and clears the description', () => {
    const base = chain();
    expect(group(setNodeGroupDescription(base, 'g', '  Cleans leads  '))?.description).toBe('Cleans leads');
    expect(group(setNodeGroupDescription(base, 'g', 'x'.repeat(200)))?.description).toHaveLength(145);
    const cleared = setNodeGroupDescription(setNodeGroupDescription(base, 'g', 'text'), 'g', '  ');
    expect(group(cleared)).not.toHaveProperty('description');
  });

  it('names a group uniquely', () => {
    expect(uniqueGroupName('Group', [])).toBe('Group');
    expect(uniqueGroupName('Group', ['Group'])).toBe('Group 2');
    expect(uniqueGroupName('Group 2', ['Group', 'Group 2'])).toBe('Group 3');
    expect(uniqueGroupName('  ', [])).toBe('Group');
  });
});

// ---------------------------------------------------------------------------------------------
describe('crossing-edit guard', () => {
  it('blocks a second entry node', () => {
    const graph = chain({
      nodes: chain().nodes.map((n) => (n.name === 'S' ? { ...n, type: 'core.manualTrigger' } : n)),
    });
    const error = crossingEditError(graph, ref('S', 'B'), 'connect', types);
    expect(error).toEqual({ groupId: 'g', message: blockedEditMessage('multiple_entry', 'G') });
    expect(error?.message).toBe('"G" can take input on one node only. Ungroup it to make this change.');
  });

  it('blocks a second exit node when the outside node cannot join', () => {
    const graph = chain();
    const fed = connect(graph, ref('S', 'Y'));
    const error = crossingEditError(fed, ref('B', 'Y'), 'connect', types);
    expect(error?.message).toBe(blockedEditMessage('multiple_exit', 'G'));
  });

  it('blocks input to a node other than the first', () => {
    const graph = chain({
      nodes: chain().nodes.map((n) => (n.name === 'S' ? { ...n, type: 'core.manualTrigger' } : n)),
      connections: { A: { main: [main('B')] }, B: { main: [main('C')] } },
    });
    expect(crossingEditError(graph, ref('S', 'B'), 'connect', types)?.message).toBe(
      blockedEditMessage('input_to_non_first', 'G'),
    );
  });

  it('blocks output from a node other than the last', () => {
    const graph = chain({
      connections: { A: { main: [main('B')] }, B: { main: [main('C')] }, S: { main: [main('X')] } },
    });
    expect(crossingEditError(graph, ref('B', 'X'), 'connect', types)?.message).toBe(
      blockedEditMessage('output_from_non_last', 'G'),
    );
  });

  it('blocks a non-main connection across the border', () => {
    const graph: WorkflowGraph = {
      ...EMPTY_GRAPH,
      nodes: [
        node('ag', 'Agent', 0, 'ai.agent'),
        node('n', 'Next', 200),
        node('m', 'Model', 0, 'ai.lmChatDemo', 200),
      ],
      connections: { Agent: { main: [main('Next')] } },
      nodeGroups: [
        { id: 'g', name: 'G', nodeIds: ['ag', 'n'] },
        { id: 'h', name: 'H', nodeIds: ['m'] },
      ],
    };
    expect(
      crossingEditError(graph, ref('Model', 'Agent', 'ai_languageModel'), 'connect', types)?.message,
    ).toBe(blockedEditMessage('non_main_boundary', 'G'));
  });

  it('blocks a disconnect that splits the group with the generic message', () => {
    expect(crossingEditError(chain(), ref('A', 'B'), 'disconnect', types)).toEqual({
      groupId: 'g',
      message: blockedEditMessage('generic', 'G'),
    });
  });

  it('has one message per reason', () => {
    const codes = [
      'multiple_entry',
      'multiple_exit',
      'input_to_non_first',
      'output_from_non_last',
      'no_path_first_to_last',
      'non_main_boundary',
      'generic',
    ] as const;
    const texts = codes.map((c) => blockedEditMessage(c, 'G'));
    expect(new Set(texts).size).toBe(codes.length);
    expect(blockedEditMessage('disconnected', 'G')).toBe(blockedEditMessage('generic', 'G'));
  });

  it('allows edits that keep groups valid, edits outside groups and inserts', () => {
    const graph = chain();
    expect(crossingEditError(graph, ref('C', 'Z'), 'connect', types)).toBeNull();
    expect(crossingEditError(graph, ref('Y', 'Z'), 'connect', types)).toBeNull();
    expect(crossingEditError(graph, ref('S', 'A'), 'disconnect', types)).toBeNull();
    expect(crossingEditError(graph, ref('A', 'B'), 'insert', types)).toBeNull();
    expect(crossingEditError(graph, ref('S', 'A'), 'insert', types)).toBeNull();
  });

  it('never blocks an edit on a group that was already invalid', () => {
    const graph = chain({ connections: { S: { main: [main('A'), main('B')] }, A: { main: [main('B')] } } });
    expect(crossingEditError(graph, ref('S', 'C'), 'connect', types)).toBeNull();
  });

  it('auto-extends: a new branch off a group node pulls the outside node in', () => {
    const graph = chain();
    expect(crossingEditError(graph, ref('B', 'Y'), 'connect', types)).toBeNull();
    const extension = extendGroupsForConnection(connect(graph, ref('B', 'Y')), ref('B', 'Y'), types);
    expect(extension.extended).toEqual(['G']);
    expect(group(extension.graph)?.nodeIds).toEqual(['a', 'b', 'c', 'y']);
  });

  it('does not extend when the group is valid without it or the node is in another group', () => {
    const graph = chain();
    const plain = connect(graph, ref('C', 'Z'));
    expect(extendGroupsForConnection(plain, ref('C', 'Z'), types)).toEqual({ graph: plain, extended: [] });
    const taken = { ...graph, nodeGroups: [...graph.nodeGroups, { id: 'h', name: 'H', nodeIds: ['y'] }] };
    const next = connect(taken, ref('B', 'Y'));
    expect(extendGroupsForConnection(next, ref('B', 'Y'), types).extended).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('group-aware graph ops', () => {
  it('removeNodes drops member ids and empty groups', () => {
    const graph = chain({
      nodeGroups: [
        { id: 'g', name: 'G', nodeIds: ['a', 'b', 'c'] },
        { id: 'h', name: 'H', nodeIds: ['x'] },
      ],
    });
    const next = removeNodes(graph, ['C', 'X']);
    expect(next.nodeGroups).toEqual([{ id: 'g', name: 'G', nodeIds: ['a', 'b'] }]);
  });

  it('removeNodes dissolves a group the removal split in two', () => {
    expect(removeNodes(chain(), ['B']).nodeGroups).toEqual([]);
  });

  it('removeStickies drops sticky members', () => {
    const graph = chain({
      stickyNotes: [{ id: 'st', content: '', position: [0, 0], width: 10, height: 10 }],
      nodeGroups: [{ id: 'g', name: 'G', nodeIds: ['a', 'b', 'c', 'st'] }],
    });
    expect(group(removeStickies(graph, ['st']))?.nodeIds).toEqual(['a', 'b', 'c']);
  });

  it('copy carries a group only when every member is selected; paste gives a new id and unique name', () => {
    const graph = chain();
    expect(extractSubgraph(graph, ['A', 'B']).nodeGroups).toEqual([]);
    const payload = extractSubgraph(graph, ['A', 'B', 'C']);
    expect(payload.nodeGroups).toEqual([{ id: 'g', name: 'G', nodeIds: ['a', 'b', 'c'] }]);

    const parsed = parseClipboard(JSON.stringify(payload));
    expect(parsed?.nodeGroups).toHaveLength(1);

    const pasted = pasteSubgraph(graph, parsed!);
    expect(pasted.graph.nodeGroups).toHaveLength(2);
    const copy = pasted.graph.nodeGroups[1];
    expect(copy.id).not.toBe('g');
    expect(copy.name).toBe('G 2');
    const newIds = pasted.graph.nodes.filter((n) => pasted.names.includes(n.name)).map((n) => n.id);
    expect(copy.nodeIds).toEqual(newIds);
  });

  it('parseClipboard drops malformed groups', () => {
    const text = JSON.stringify({
      nodes: [node('a', 'A', 0)],
      connections: {},
      nodeGroups: [
        { id: 1, name: 'x' },
        { id: 'ok', name: 'Ok', nodeIds: ['a'] },
      ],
    });
    expect(parseClipboard(text)?.nodeGroups).toEqual([{ id: 'ok', name: 'Ok', nodeIds: ['a'] }]);
  });

  it('a node inserted on a cable inside a group joins it; on the border it stays outside', () => {
    const base = chain();
    const withNew = { ...base, nodes: [...base.nodes, node('n', 'New', 300)] };
    expect(group(insertNodeOnConnection(withNew, ref('A', 'B'), 'New'))?.nodeIds).toEqual([
      'a',
      'b',
      'c',
      'n',
    ]);
    expect(group(insertNodeOnConnection(withNew, ref('S', 'A'), 'New'))?.nodeIds).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('push layout', () => {
  const box = (x: number, y: number, width = 100, height = 100) => ({ x, y, width, height });

  it('frames members with padding and a header band', () => {
    expect(groupFrame([box(0, 0), box(300, 50)])).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_HEADER,
      width: 400 + 2 * GROUP_PADDING,
      height: 150 + GROUP_HEADER + GROUP_PADDING,
    });
  });

  it('pushes the right lane clear of an expanded frame, all by the same amount', () => {
    const frame = box(0, 0, 800, 300);
    const chip = box(0, 0, COLLAPSED_GROUP_WIDTH, 64);
    const push = computeGroupPush(
      [{ id: 'g', expanded: true, box: frame, chip }],
      [
        { id: 'over', box: box(600, 100) },
        { id: 'far', box: box(1200, 100) },
        { id: 'left', box: box(-400, 100) },
      ],
    );
    const dx = 800 + PUSH_GAP - 600;
    expect(push.nodes.get('over')).toEqual({ x: dx, y: 0 });
    expect(push.nodes.get('far')).toEqual({ x: dx, y: 0 });
    expect(push.nodes.get('left')).toBeUndefined();
  });

  it('pushes the lane below down, leaves collapsed groups alone and cascades', () => {
    const chip = box(0, 0, COLLAPSED_GROUP_WIDTH, 64);
    const down = computeGroupPush(
      [{ id: 'g', expanded: true, box: box(0, 0, 300, 400), chip }],
      [{ id: 'below', box: box(100, 350) }],
    );
    expect(down.nodes.get('below')).toEqual({ x: 0, y: 400 + PUSH_GAP - 350 });

    const collapsed = computeGroupPush(
      [{ id: 'g', expanded: false, box: chip, chip }],
      [{ id: 'n', box: box(100, 30) }],
    );
    expect(collapsed.nodes.size).toBe(0);

    // h (expanded first) pushes n down; g then pushes h right and n moves along with h
    const cascade = computeGroupPush(
      [
        { id: 'h', expanded: true, box: box(500, 0, 300, 200), chip: box(500, 0, COLLAPSED_GROUP_WIDTH, 64) },
        { id: 'g', expanded: true, box: box(0, 0, 600, 200), chip },
      ],
      [{ id: 'n', box: box(550, 150) }],
    );
    const dx = 600 + PUSH_GAP - 500;
    expect(cascade.groups.get('h')).toEqual({ x: dx, y: 0 });
    expect(cascade.nodes.get('n')).toEqual({ x: dx, y: 200 + PUSH_GAP - 150 });
    expect(cascade.groups.has('g')).toBe(false);
  });

  it('shows a description only when pinned, present and at zoom 0.66 or more', () => {
    expect(showsGroupDescription('Cleans leads', true, 1)).toBe(true);
    expect(showsGroupDescription('Cleans leads', true, DESCRIPTION_MIN_ZOOM - 0.01)).toBe(false);
    expect(showsGroupDescription('Cleans leads', false, 1)).toBe(false);
    expect(showsGroupDescription(undefined, true, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('group view state (this browser, per workflow)', () => {
  const groups: WorkflowNodeGroup[] = [
    { id: 'g1', name: 'One', nodeIds: [], description: 'About one' },
    { id: 'g2', name: 'Two', nodeIds: [] },
  ];
  const open = (id: string) =>
    useWorkflowStore.setState((s) => ({ meta: { ...s.meta, id }, nodeGroups: groups }));

  beforeEach(() => {
    window.localStorage.clear();
    open('w1');
  });

  it('collapses every group until expanded, per workflow, and survives a reload of the store', () => {
    expect(isGroupExpanded('g1')).toBe(false);
    setGroupsExpanded(['g1'], true);
    expect(isGroupExpanded('g1')).toBe(true);
    expect(window.localStorage.getItem('workflow.groupView')).toContain('w1');
    open('w2');
    expect(isGroupExpanded('g1')).toBe(false);
    setGroupsExpanded('all', true);
    expect([isGroupExpanded('g1'), isGroupExpanded('g2')]).toEqual([true, true]);
    open('w1');
    setGroupsExpanded('all', false);
    expect(isGroupExpanded('g1')).toBe(false);
  });

  it('pins a description only for a group that has one', () => {
    setGroupDescriptionPinned('g1', true);
    setGroupDescriptionPinned('g2', true);
    expect(isGroupDescriptionPinned('g1')).toBe(true);
    expect(isGroupDescriptionPinned('g2')).toBe(false);
    setGroupDescriptionPinned('g1', false);
    expect(isGroupDescriptionPinned('g1')).toBe(false);
  });

  it('works without storage', () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('blocked');
    };
    try {
      setGroupsExpanded(['g2'], true);
      expect(isGroupExpanded('g2')).toBe(true);
    } finally {
      window.localStorage.setItem = original;
    }
  });
});
