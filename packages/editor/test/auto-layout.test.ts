/**
 * P3-03 tidy up (L1): the pure layout. Sizes are passed in (jsdom has no layout engine).
 * Every graph is checked for no overlap, unchanged connections, kept sibling order (execution
 * order follows sortByPosition), an unchanged start node and integer positions.
 */
import {
  type Connections,
  type StickyNote,
  sortByPosition,
  type WorkflowNode,
  type WorkflowNodeGroup,
} from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import {
  type AutoLayoutInput,
  type AutoLayoutResult,
  type LayoutSize,
  layoutWorkflow,
} from '../src/lib/auto-layout';
import { COLLAPSED_GROUP_HEIGHT, COLLAPSED_GROUP_WIDTH, groupFrame } from '../src/lib/group-layout-push';

const NODE: LayoutSize = { width: 220, height: 64 };
const SUB: LayoutSize = { width: 120, height: 120 };
const AGENT: LayoutSize = { width: 276, height: 130 };

const node = (name: string, x: number, y: number, type = 'core.set'): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters: {},
});

/** connections from [source, target, outputIndex?, type?] tuples */
function link(...edges: Array<[string, string, number?, string?]>): Connections {
  const out: Connections = {};
  for (const [source, target, output = 0, type = 'main'] of edges) {
    const byType = (out[source] ??= {}) as Record<
      string,
      Array<Array<{ node: string; type: string; index: number }> | null>
    >;
    const list = (byType[type] ??= []);
    while (list.length <= output) list.push([]);
    list[output]!.push({ node: target, type, index: 0 });
  }
  return out;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const boxOf = (position: [number, number], size: LayoutSize): Box => ({
  x: position[0],
  y: position[1],
  ...size,
});

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

function apply(nodes: WorkflowNode[], result: AutoLayoutResult): WorkflowNode[] {
  return nodes.map((n) => (result.positions[n.name] ? { ...n, position: result.positions[n.name]! } : n));
}

function sizeOf(input: AutoLayoutInput, name: string): LayoutSize {
  return input.sizes?.[name] ?? input.defaultSize ?? NODE;
}

function expectNoOverlap(input: AutoLayoutInput, nodes: WorkflowNode[], names = nodes.map((n) => n.name)) {
  const boxes = names.map((name) => ({
    name,
    box: boxOf(nodes.find((n) => n.name === name)!.position, sizeOf(input, name)),
  }));
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(boxes[i]!.box, boxes[j]!.box)) overlaps.push(`${boxes[i]!.name} / ${boxes[j]!.name}`);
    }
  }
  expect(overlaps).toEqual([]);
}

/** for every node, its main children in execution order (sortByPosition, as the engine runs them) */
function childOrder(nodes: WorkflowNode[], connections: Connections): Record<string, string[]> {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const order: Record<string, string[]> = {};
  for (const [source, types] of Object.entries(connections)) {
    const kids = new Set<string>();
    for (const list of types.main ?? []) for (const c of list ?? []) kids.add(c.node);
    if (kids.size > 1)
      order[source] = sortByPosition([...kids].map((k) => byName.get(k)!)).map((n) => n.name);
  }
  return order;
}

function startNode(
  nodes: WorkflowNode[],
  connections: Connections,
  triggers: string[] = [],
): string | undefined {
  const t = nodes.filter((n) => triggers.includes(n.name));
  if (t.length) return sortByPosition(t)[0]?.name;
  const targets = new Set<string>();
  for (const types of Object.values(connections))
    for (const list of types.main ?? []) for (const c of list ?? []) targets.add(c.node);
  const subNodes = new Set(
    Object.entries(connections)
      .filter(
        ([, types]) => !types.main?.some((l) => l?.length) && Object.keys(types).some((k) => k !== 'main'),
      )
      .map(([s]) => s),
  );
  return sortByPosition(nodes.filter((n) => !targets.has(n.name) && !subNodes.has(n.name)))[0]?.name;
}

/** the checks every layout must pass; returns the laid-out nodes */
function check(
  input: AutoLayoutInput,
  options: { hidden?: string[] } = {},
): { result: AutoLayoutResult; nodes: WorkflowNode[] } {
  const connectionsBefore = structuredClone(input.connections);
  const nodesBefore = structuredClone(input.nodes);
  const result = layoutWorkflow(input);
  // the input is never mutated
  expect(input.connections).toEqual(connectionsBefore);
  expect(input.nodes).toEqual(nodesBefore);
  const nodes = apply(input.nodes, result);
  for (const [name, [x, y]] of Object.entries(result.positions)) {
    expect(Number.isInteger(x) && Number.isInteger(y), name).toBe(true);
  }
  // members of a collapsed group are not shown: they may sit under other nodes
  expectNoOverlap(
    input,
    nodes,
    nodes.map((n) => n.name).filter((n) => !options.hidden?.includes(n)),
  );
  expect(childOrder(nodes, input.connections)).toEqual(childOrder(input.nodes, input.connections));
  expect(startNode(nodes, input.connections, input.triggers)).toBe(
    startNode(input.nodes, input.connections, input.triggers),
  );
  return { result, nodes };
}

const topLeft = (nodes: WorkflowNode[]) => [
  Math.min(...nodes.map((n) => n.position[0])),
  Math.min(...nodes.map((n) => n.position[1])),
];

/** small seeded PRNG so the random DAG is the same on every run */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------------------------

describe('layoutWorkflow: shapes', () => {
  it('a scrambled chain becomes one row, left to right, anchored at the old top-left', () => {
    const nodes = [
      node('T', 500, 300, 'core.manualTrigger'),
      node('A', 40, 0),
      node('B', 900, 600),
      node('C', 100, 900),
    ];
    const input: AutoLayoutInput = {
      nodes,
      connections: link(['T', 'A'], ['A', 'B'], ['B', 'C']),
      triggers: ['T'],
    };
    const { nodes: out } = check(input);
    const pos = (n: string) => out.find((x) => x.name === n)!.position;
    expect(pos('T')[1]).toBe(pos('A')[1]);
    expect(pos('A')[1]).toBe(pos('C')[1]);
    expect(pos('T')[0]).toBeLessThan(pos('A')[0]);
    expect(pos('A')[0]).toBeLessThan(pos('B')[0]);
    expect(pos('B')[0]).toBeLessThan(pos('C')[0]);
    expect(topLeft(out)).toEqual(topLeft(nodes));
  });

  it('fan-out keeps the children in their old vertical order', () => {
    const nodes = [
      node('T', 0, 200, 'core.manualTrigger'),
      node('B', 400, 0),
      node('C', 300, 150),
      node('A', 500, 420),
      node('D', 350, 600),
    ];
    const input: AutoLayoutInput = {
      nodes,
      connections: link(['T', 'A'], ['T', 'B'], ['T', 'C'], ['T', 'D']),
      triggers: ['T'],
    };
    const { nodes: out } = check(input);
    const ys = ['B', 'C', 'A', 'D'].map((n) => out.find((x) => x.name === n)!.position[1]);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('IF with two outputs into a Merge', () => {
    const nodes = [
      node('T', 0, 0, 'core.manualTrigger'),
      node('IF', 300, 0, 'core.if'),
      node('True', 600, -100),
      node('False', 600, 120),
      node('Merge', 900, 0, 'core.merge'),
      node('End', 1200, 0),
    ];
    const input: AutoLayoutInput = {
      nodes,
      connections: link(
        ['T', 'IF'],
        ['IF', 'True', 0],
        ['IF', 'False', 1],
        ['True', 'Merge'],
        ['False', 'Merge'],
        ['Merge', 'End'],
      ),
      triggers: ['T'],
      sizes: { IF: { width: 220, height: 88 } },
    };
    const { nodes: out } = check(input);
    const pos = (n: string) => out.find((x) => x.name === n)!.position;
    expect(pos('True')[1]).toBeLessThan(pos('False')[1]);
    expect(pos('Merge')[0]).toBeGreaterThan(pos('True')[0]);
  });

  it('an IF whose second output skips ahead to the Merge keeps its order', () => {
    const nodes = [
      node('T', 0, 0, 'core.manualTrigger'),
      node('IF', 300, 0, 'core.if'),
      node('Work', 600, 300),
      node('Merge', 900, 0, 'core.merge'),
    ];
    // IF's children: Merge (y 0) runs before Work (y 300)
    check({
      nodes,
      connections: link(['T', 'IF'], ['IF', 'Work', 0], ['IF', 'Merge', 1], ['Work', 'Merge']),
      triggers: ['T'],
    });
  });

  it('a disconnected pair is stacked in the old order', () => {
    const nodes = [
      node('Lower', 0, 800, 'core.manualTrigger'),
      node('L2', 300, 800),
      node('Upper', 600, 0, 'core.scheduleTrigger'),
      node('U2', 900, 0),
    ];
    const input: AutoLayoutInput = {
      nodes,
      connections: link(['Lower', 'L2'], ['Upper', 'U2']),
      triggers: ['Lower', 'Upper'],
    };
    const { nodes: out } = check(input);
    const pos = (n: string) => out.find((x) => x.name === n)!.position;
    expect(pos('Upper')[1] + NODE.height).toBeLessThan(pos('Lower')[1]);
    expect(pos('Upper')[0]).toBe(pos('Lower')[0]);
    expect(topLeft(out)).toEqual(topLeft(nodes));
  });

  it('an agent with 3 sub-nodes: one row under the parent, in input order', () => {
    const nodes = [
      node('T', 0, 0, 'core.manualTrigger'),
      node('Agent', 300, 0, 'ai.agent'),
      node('Out', 700, 0),
      node('Tool', 200, 300, 'ai.tool'),
      node('Model', 500, 300, 'ai.model'),
      node('Memory', 350, 600, 'ai.memory'),
    ];
    const input: AutoLayoutInput = {
      nodes,
      connections: link(
        ['T', 'Agent'],
        ['Agent', 'Out'],
        ['Model', 'Agent', 0, 'ai_languageModel'],
        ['Memory', 'Agent', 0, 'ai_memory'],
        ['Tool', 'Agent', 0, 'ai_tool'],
      ),
      triggers: ['T'],
      sizes: { Agent: AGENT, Tool: SUB, Model: SUB, Memory: SUB },
      aiInputs: { Agent: ['ai_languageModel', 'ai_memory', 'ai_tool'] },
    };
    const { nodes: out } = check(input);
    const pos = (n: string) => out.find((x) => x.name === n)!.position;
    const row = ['Model', 'Memory', 'Tool'].map(pos);
    expect(new Set(row.map((p) => p[1])).size).toBe(1);
    expect(row[0]![1]).toBeGreaterThanOrEqual(pos('Agent')[1] + AGENT.height);
    expect(row[0]![0]).toBeLessThan(row[1]![0]);
    expect(row[1]![0]).toBeLessThan(row[2]![0]);
    // the row hangs under the agent: its middle sits under the agent's middle
    const rowMid = (row[0]![0] + row[2]![0] + SUB.width) / 2;
    expect(Math.abs(rowMid - (pos('Agent')[0] + AGENT.width / 2))).toBeLessThanOrEqual(1);
    // main flow stays on one line through the agent
    expect(pos('T')[1] + NODE.height / 2).toBe(pos('Agent')[1] + AGENT.height / 2);
    expect(pos('Out')[1]).toBe(pos('T')[1]);
  });

  it('a loop back to an earlier node is laid out without overlap', () => {
    const nodes = [
      node('T', 0, 0, 'core.manualTrigger'),
      node('Loop', 300, 0, 'core.splitInBatches'),
      node('Work', 600, 200),
      node('Done', 600, -200),
    ];
    const { nodes: out } = check({
      nodes,
      connections: link(['T', 'Loop'], ['Loop', 'Done', 0], ['Loop', 'Work', 1], ['Work', 'Loop']),
      triggers: ['T'],
    });
    const pos = (n: string) => out.find((x) => x.name === n)!.position;
    expect(pos('Loop')[0]).toBeLessThan(pos('Work')[0]);
  });

  it('a 50-node random DAG', () => {
    const rnd = prng(42);
    const nodes: WorkflowNode[] = [];
    const edges: Array<[string, string, number?]> = [];
    for (let i = 0; i < 50; i++) {
      nodes.push(
        node(
          `N${i}`,
          Math.round(rnd() * 3000),
          Math.round(rnd() * 2000),
          i === 0 ? 'core.manualTrigger' : 'core.set',
        ),
      );
      if (i === 0) continue;
      const parents = 1 + Math.floor(rnd() * 2);
      for (let p = 0; p < parents; p++) {
        const from = Math.floor(rnd() * i);
        if (!edges.some(([s, t]) => s === `N${from}` && t === `N${i}`))
          edges.push([`N${from}`, `N${i}`, Math.floor(rnd() * 2)]);
      }
    }
    const sizes: Record<string, LayoutSize> = {};
    for (const [i, n] of nodes.entries()) if (i % 7 === 3) sizes[n.name] = { width: 220, height: 112 };
    check({ nodes, connections: link(...edges), triggers: ['N0'], sizes });
  });
});

describe('layoutWorkflow: groups', () => {
  const chain = () => [
    node('T', 0, 0, 'core.manualTrigger'),
    node('A', 600, 400),
    node('B', 300, 900),
    node('C', 1200, 100),
    node('D', 1500, 0),
  ];
  const group: WorkflowNodeGroup = { id: 'g', name: 'G', nodeIds: ['id-A', 'id-B', 'id-C'] };
  const connections = link(['T', 'A'], ['A', 'B'], ['B', 'C'], ['C', 'D']);

  it('a group of 3 in a chain is laid out as one box: no other node enters its frame', () => {
    const input: AutoLayoutInput = { nodes: chain(), connections, nodeGroups: [group], triggers: ['T'] };
    const { nodes: out } = check(input);
    const box = (n: string) => boxOf(out.find((x) => x.name === n)!.position, NODE);
    const frame = groupFrame(['A', 'B', 'C'].map(box));
    expect(intersects(frame, box('T'))).toBe(false);
    expect(intersects(frame, box('D'))).toBe(false);
    // the members are a row inside the frame, on the line of the chain
    expect(box('A').y).toBe(box('B').y);
    expect(box('A').x).toBeLessThan(box('B').x);
    expect(box('T').y).toBe(box('A').y);
    expect(box('D').y).toBe(box('C').y);
  });

  it('a collapsed group takes the size of its card', () => {
    const input: AutoLayoutInput = {
      nodes: chain(),
      connections,
      nodeGroups: [group],
      triggers: ['T'],
      collapsedGroups: { g: { width: COLLAPSED_GROUP_WIDTH, height: COLLAPSED_GROUP_HEIGHT } },
    };
    const { nodes: out } = check(input, { hidden: ['A', 'B', 'C'] });
    const box = (n: string) => boxOf(out.find((x) => x.name === n)!.position, NODE);
    const frame = groupFrame(['A', 'B', 'C'].map(box));
    const card = { x: frame.x, y: frame.y, width: COLLAPSED_GROUP_WIDTH, height: COLLAPSED_GROUP_HEIGHT };
    expect(intersects(card, box('T'))).toBe(false);
    expect(intersects(card, box('D'))).toBe(false);
    expect(box('T').x + NODE.width).toBeLessThan(card.x);
    expect(box('D').x).toBeGreaterThan(card.x + card.width);
  });

  it('a partial selection treats the selected members one by one and leaves the rest', () => {
    const nodes = chain();
    const input: AutoLayoutInput = {
      nodes,
      connections,
      nodeGroups: [group],
      triggers: ['T'],
      target: { nodes: ['T', 'A', 'B'] },
    };
    const { result, nodes: out } = check(input);
    expect(Object.keys(result.positions).sort()).toEqual(['A', 'B', 'T']);
    expect(out.find((n) => n.name === 'C')!.position).toEqual([1200, 100]);
    expect(out.find((n) => n.name === 'D')!.position).toEqual([1500, 0]);
    expect(topLeft(out.filter((n) => ['T', 'A', 'B'].includes(n.name)))).toEqual([0, 0]);
  });

  it('a sticky inside the group travels with it', () => {
    const sticky: StickyNote = { id: 's1', content: 'note', position: [580, 380], width: 260, height: 104 };
    const input: AutoLayoutInput = {
      nodes: chain(),
      connections,
      stickyNotes: [sticky],
      nodeGroups: [{ ...group, nodeIds: [...group.nodeIds, 's1'] }],
      triggers: ['T'],
    };
    const { result, nodes: out } = check(input);
    const a = out.find((n) => n.name === 'A')!.position;
    expect(result.stickyPositions.s1).toEqual([a[0] - 20, a[1] - 20]);
  });
});

describe('layoutWorkflow: selection, stickies, idempotence', () => {
  const nodes = () => [
    node('T', 0, 0, 'core.manualTrigger'),
    node('A', 700, 300),
    node('B', 260, 500),
    node('C', 900, 50),
    node('Far', 2000, 2000),
  ];
  const connections = link(['T', 'A'], ['A', 'B'], ['A', 'C'], ['C', 'Far']);

  it('a selection moves only the selected nodes and keeps its top-left', () => {
    const input: AutoLayoutInput = {
      nodes: nodes(),
      connections,
      triggers: ['T'],
      target: { nodes: ['A', 'B', 'C'] },
    };
    const { result, nodes: out } = check(input);
    expect(Object.keys(result.positions).sort()).toEqual(['A', 'B', 'C']);
    expect(out.find((n) => n.name === 'T')!.position).toEqual([0, 0]);
    expect(out.find((n) => n.name === 'Far')!.position).toEqual([2000, 2000]);
    expect(topLeft(out.filter((n) => ['A', 'B', 'C'].includes(n.name)))).toEqual([260, 50]);
  });

  it('a sticky covering a node moves with it; other stickies stay', () => {
    const covering: StickyNote = { id: 'cover', content: '', position: [680, 280], width: 260, height: 104 };
    const lonely: StickyNote = { id: 'lonely', content: '', position: [-600, -600], width: 200, height: 100 };
    const input: AutoLayoutInput = {
      nodes: nodes(),
      connections,
      triggers: ['T'],
      stickyNotes: [covering, lonely],
    };
    const { result, nodes: out } = check(input);
    const a = out.find((n) => n.name === 'A')!.position;
    expect(result.stickyPositions.cover).toEqual([a[0] - 20, a[1] - 20]);
    expect(result.stickyPositions.lonely).toBeUndefined();
  });

  it('a sticky covering selected and unselected nodes stays when only some are tidied', () => {
    const wide: StickyNote = { id: 'wide', content: '', position: [-20, -20], width: 1200, height: 200 };
    const input: AutoLayoutInput = {
      nodes: nodes(),
      connections,
      triggers: ['T'],
      stickyNotes: [wide],
      target: { nodes: ['A', 'B', 'C'], stickies: ['wide'] },
    };
    expect(check(input).result.stickyPositions.wide).toBeUndefined();
  });

  it('is idempotent: a second run changes nothing', () => {
    const graphs: AutoLayoutInput[] = [
      { nodes: nodes(), connections, triggers: ['T'] },
      {
        nodes: [
          node('T', 0, 0, 'core.manualTrigger'),
          node('IF', 300, 0),
          node('X', 600, -100),
          node('Y', 600, 120),
          node('M', 900, 0),
        ],
        connections: link(['T', 'IF'], ['IF', 'X', 0], ['IF', 'Y', 1], ['X', 'M'], ['Y', 'M']),
        triggers: ['T'],
      },
    ];
    for (const input of graphs) {
      const first = apply(input.nodes, layoutWorkflow(input));
      const second = apply(first, layoutWorkflow({ ...input, nodes: first }));
      expect(second.map((n) => n.position)).toEqual(first.map((n) => n.position));
    }
  });

  it('an empty workflow lays out nothing', () => {
    expect(layoutWorkflow({ nodes: [], connections: {} })).toEqual({ positions: {}, stickyPositions: {} });
  });
});
