import { describe, expect, it } from 'vitest';
import {
  type Connections,
  type ConnectionType,
  type DirtyReason,
  dirtyNodesFromDiff,
  type RunData,
  type TaskData,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src';

const n = (name: string, type = 'core.set', extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: `id-${name}`,
  name,
  type,
  typeVersion: 1,
  position: [0, 0],
  parameters: { value: name },
  ...extra,
});

type Wire = [string, string, number?, number?, ConnectionType?];
function wire(...wires: Wire[]): Connections {
  const c: Connections = {};
  for (const [from, to, output = 0, input = 0, type = 'main'] of wires) {
    const outputs = ((c[from] ??= {})[type] ??= []);
    while (outputs.length <= output) outputs.push([]);
    outputs[output]!.push({ node: to, type, index: input });
  }
  return c;
}

const task: TaskData = {
  startTime: 1,
  executionTime: 1,
  executionStatus: 'success',
  source: [],
  data: { main: [[]] },
};
const ran = (...names: string[]): RunData => Object.fromEntries(names.map((name) => [name, [task]]));

// T -> A -> B -> C; Model -ai-> Agent; T -> Agent
const base: WorkflowDefinition = {
  name: 'wf',
  nodes: [
    n('T', 'core.manualTrigger'),
    n('A'),
    n('B'),
    n('C'),
    n('Agent', 'ai.agent'),
    n('Model', 'ai.model'),
  ],
  connections: wire(
    ['T', 'A'],
    ['A', 'B'],
    ['B', 'C'],
    ['T', 'Agent'],
    ['Model', 'Agent', 0, 0, 'ai_languageModel'],
  ),
};
const runData = ran('T', 'A', 'B', 'C', 'Agent', 'Model');

function edit(change: (d: WorkflowDefinition) => void, from = base): WorkflowDefinition {
  const next = structuredClone(from);
  change(next);
  return next;
}
const node = (d: WorkflowDefinition, name: string) => d.nodes.find((x) => x.name === name)!;
const dirty = (current: WorkflowDefinition, before = base, data = runData) =>
  dirtyNodesFromDiff(before, current, data);

const rows: Array<[string, WorkflowDefinition, Record<string, DirtyReason>]> = [
  ['nothing changed (undo): no', structuredClone(base), {}],
  [
    '(a) parameter change: yes',
    edit((d) => {
      node(d, 'B').parameters = { value: 'changed' };
    }),
    { B: 'parameters' },
  ],
  [
    '(a) credentials and settings count',
    edit((d) => {
      node(d, 'A').credentials = { api: { id: '1', name: 'Key' } };
      node(d, 'B').retryOnFail = true;
    }),
    { A: 'parameters', B: 'parameters' },
  ],
  [
    'moves, renames, notes and colour: no',
    edit((d) => {
      const b = node(d, 'B');
      b.position = [500, 500];
      b.notes = 'note';
      b.notesInFlow = true;
      b.color = '#ff0000';
      b.name = 'Renamed';
      d.connections = wire(
        ['T', 'A'],
        ['A', 'Renamed'],
        ['Renamed', 'C'],
        ['T', 'Agent'],
        ['Model', 'Agent', 0, 0, 'ai_languageModel'],
      );
    }),
    {},
  ],
  [
    '(b) added connection into the node: yes',
    edit((d) => {
      d.connections.A.main![0]!.push({ node: 'C', type: 'main', index: 0 });
    }),
    { C: 'connections' },
  ],
  [
    '(c) node inserted in front: yes (the new node has no run data)',
    edit((d) => {
      d.nodes.push(n('N'));
      d.connections.A.main = [[{ node: 'N', type: 'main', index: 0 }]];
      d.connections.N = { main: [[{ node: 'B', type: 'main', index: 0 }]] };
    }),
    { B: 'connections' },
  ],
  [
    '(d) removed connection alone: no',
    edit((d) => {
      d.connections.A.main = [[]];
    }),
    {},
  ],
  [
    '(d) removed connection whose source node was removed: yes',
    edit((d) => {
      d.nodes = d.nodes.filter((x) => x.name !== 'A');
      delete d.connections.A;
      d.connections.T.main = [[{ node: 'Agent', type: 'main', index: 0 }]];
    }),
    { B: 'connections' },
  ],
  [
    '(e) disable parent: the parent only, not its child',
    edit((d) => {
      node(d, 'A').disabled = true;
    }),
    { A: 'parameters' },
  ],
  [
    '(e) toggled sub-node marks the node it feeds',
    edit((d) => {
      node(d, 'Model').disabled = true;
    }),
    { Model: 'parameters', Agent: 'connections' },
  ],
  [
    '(f) parent pin added: the child',
    edit((d) => {
      d.pinData = { A: [{ json: { pinned: true } }] };
    }),
    { B: 'pinned' },
  ],
  [
    '(g) dirty sub-node marks its parent upstream',
    edit((d) => {
      node(d, 'Model').parameters = { model: 'other' };
    }),
    { Model: 'parameters', Agent: 'upstream' },
  ],
];

describe('dirtyNodesFromDiff', () => {
  it.each(rows)('%s', (_label, current, expected) => {
    expect(dirty(current)).toEqual(expected);
  });

  it('(e) enable parent: the child is dirty too', () => {
    const before = edit((d) => {
      node(d, 'A').disabled = true;
    });
    expect(dirty(base, before)).toEqual({ A: 'parameters', B: 'connections' });
  });

  it('(f) own pin removed after the run: the node itself', () => {
    const before = edit((d) => {
      d.pinData = { A: [{ json: { pinned: true } }] };
    });
    expect(dirty(base, before)).toEqual({ A: 'pinned', B: 'pinned' });
  });

  it('(g) a changed sub-node without run data still marks its parent', () => {
    const current = edit((d) => {
      node(d, 'Model').parameters = { model: 'other' };
    });
    expect(dirty(current, base, ran('T', 'A', 'B', 'C', 'Agent'))).toEqual({ Agent: 'upstream' });
  });

  it('(h) a dirty node inside a loop marks the loop entry', () => {
    const loop: WorkflowDefinition = {
      name: 'loop',
      nodes: [n('T', 'core.manualTrigger'), n('L', 'core.splitInBatches'), n('Body'), n('After')],
      connections: wire(['T', 'L'], ['L', 'After', 0], ['L', 'Body', 1], ['Body', 'L']),
    };
    const current = edit((d) => {
      node(d, 'Body').parameters = { value: 'changed' };
    }, loop);
    expect(dirtyNodesFromDiff(loop, current, ran('T', 'L', 'Body', 'After'))).toEqual({
      Body: 'parameters',
      L: 'upstream',
    });
  });

  it('only nodes with run data can be dirty, keyed by their current names', () => {
    const current = edit((d) => {
      node(d, 'B').parameters = { value: 'changed' };
      node(d, 'C').parameters = { value: 'changed' };
      node(d, 'C').name = 'C2';
      d.connections.B.main = [[{ node: 'C2', type: 'main', index: 0 }]];
    });
    expect(dirty(current, base, ran('T', 'A', 'C'))).toEqual({ C2: 'parameters' });
  });
});
