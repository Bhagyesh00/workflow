import { describe, expect, it } from 'vitest';
import {
  type Connections,
  type ConnectionType,
  type Item,
  planPartialRun,
  type RunData,
  type TaskData,
  type WorkflowDefinition,
  type WorkflowNode,
  WorkflowOperationError,
} from '../src';

const n = (
  name: string,
  type = 'core.set',
  position: [number, number] = [0, 0],
  extra: Partial<WorkflowNode> = {},
): WorkflowNode => ({ id: `id-${name}`, name, type, typeVersion: 1, position, parameters: {}, ...extra });

/** [from, to, output = 0, input = 0, type = main] */
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

const items = (...values: string[]): Item[] => values.map((v) => ({ json: { v } }));
const task = (outputs: Item[][], extra: Partial<TaskData> = {}): TaskData => ({
  startTime: 1,
  executionTime: 1,
  executionStatus: 'success',
  data: { main: outputs },
  source: [],
  ...extra,
});
const ok = (...values: string[]) => [task([items(...(values.length ? values : ['x']))])];

const def = (nodes: WorkflowNode[], connections: Connections): WorkflowDefinition => ({
  name: 'wf',
  nodes,
  connections,
});

// T -> A -> B -> C
const line = def(
  [
    n('T', 'core.manualTrigger'),
    n('A', 'core.set', [200, 0]),
    n('B', 'core.set', [400, 0]),
    n('C', 'core.set', [600, 0]),
  ],
  wire(['T', 'A'], ['A', 'B'], ['B', 'C']),
);
const lineRun: RunData = { T: ok(), A: ok(), B: ok(), C: ok() };

describe('planPartialRun', () => {
  it('line A-B-C with B dirty: starts at B, keeps the trigger and A', () => {
    const plan = planPartialRun(line, {
      root: 'T',
      destination: 'C',
      runData: lineRun,
      dirtyNodeNames: ['B'],
    });
    expect(plan.startNodes).toEqual(['B']);
    expect(Object.keys(plan.runData).sort()).toEqual(['A', 'T']);
    expect(plan.subgraph.sort()).toEqual(['A', 'B', 'C', 'T']);
    expect(plan.root).toBe('T');
    expect(plan.destination).toBe('C');
  });

  it('unchanged workflow: only the destination runs again, the trigger is not rerun', () => {
    const plan = planPartialRun(line, { root: 'T', destination: 'C', runData: lineRun });
    expect(plan.startNodes).toEqual(['C']);
    expect(Object.keys(plan.runData).sort()).toEqual(['A', 'B', 'T']);
  });

  it('drops run data outside the subgraph and copies the task lists', () => {
    const plan = planPartialRun(line, { root: 'T', destination: 'B', runData: { ...lineRun, Gone: ok() } });
    expect(Object.keys(plan.runData).sort()).toEqual(['A', 'T']);
    expect(plan.runData.A).not.toBe(lineRun.A);
    expect(plan.runData.A[0]).toBe(lineRun.A[0]);
  });

  it('diamond with Merge: the dirty branch and the Merge start, the other branch is reused', () => {
    const diamond = def(
      [
        n('T', 'core.manualTrigger'),
        n('X', 'core.set', [200, -100]),
        n('Y', 'core.set', [200, 100]),
        n('M', 'core.merge', [400, 0]),
        n('D', 'core.set', [600, 0]),
      ],
      wire(['T', 'X'], ['T', 'Y'], ['X', 'M', 0, 0], ['Y', 'M', 0, 1], ['M', 'D']),
    );
    const plan = planPartialRun(diamond, {
      root: 'T',
      destination: 'D',
      runData: { T: ok(), X: ok(), Y: ok(), M: ok(), D: ok() },
      dirtyNodeNames: ['X'],
    });
    expect(plan.startNodes).toEqual(['X', 'M']);
    expect(Object.keys(plan.runData).sort()).toEqual(['T', 'Y']);
  });

  it('IF with two outputs: a branch whose output was empty is not followed', () => {
    const branching = def(
      [
        n('T', 'core.manualTrigger'),
        n('IF', 'core.if', [200, 0]),
        n('Yes', 'core.set', [400, -100]),
        n('No', 'core.set', [400, 100]),
        n('After', 'core.set', [600, 0]),
      ],
      wire(['T', 'IF'], ['IF', 'Yes', 0], ['IF', 'No', 1], ['Yes', 'After'], ['No', 'After']),
    );
    const runData: RunData = { T: ok(), IF: [task([items('a'), []])], Yes: ok(), After: ok() };
    const plan = planPartialRun(branching, {
      root: 'T',
      destination: 'After',
      runData,
      dirtyNodeNames: ['Yes'],
    });
    expect(plan.startNodes).toEqual(['Yes']);
    expect(Object.keys(plan.runData).sort()).toEqual(['IF', 'T']);
  });

  it('Loop whose done output is empty starts again at the Loop', () => {
    const loop = def(
      [
        n('T', 'core.manualTrigger'),
        n('L', 'core.splitInBatches', [200, 0]),
        n('Body', 'core.set', [400, 100]),
        n('After', 'core.set', [400, -100]),
      ],
      wire(['T', 'L'], ['L', 'After', 0], ['L', 'Body', 1], ['Body', 'L']),
    );
    // an earlier step run stopped inside the loop body: the Loop never emitted on "done"
    const runData: RunData = { T: ok(), L: [task([[], items('1')])], Body: ok() };
    const plan = planPartialRun(loop, { root: 'T', destination: 'After', runData });
    expect(plan.startNodes).toEqual(['L']);
    expect(Object.keys(plan.runData)).toEqual(['T']);

    // a finished loop: done has items, only the node after it runs
    const done: RunData = {
      T: ok(),
      L: [task([[], items('1')]), task([items('1'), []])],
      Body: ok(),
      After: ok(),
    };
    const next = planPartialRun(loop, { root: 'T', destination: 'After', runData: done });
    expect(next.startNodes).toEqual(['After']);
    expect(Object.keys(next.runData).sort()).toEqual(['Body', 'L', 'T']);
  });

  it('a start node inside a cycle is replaced by the cycle entry', () => {
    const cycle = def(
      [
        n('T', 'core.manualTrigger'),
        n('A', 'core.set', [200, 0]),
        n('B', 'core.set', [400, 0]),
        n('D', 'core.set', [600, 0]),
      ],
      wire(['T', 'A'], ['A', 'B'], ['B', 'A'], ['B', 'D']),
    );
    const runData: RunData = {
      T: ok(),
      A: ok(),
      B: [task([], { executionStatus: 'error', error: { name: 'Error', message: 'boom' }, data: undefined })],
    };
    const plan = planPartialRun(cycle, { root: 'T', destination: 'D', runData });
    expect(plan.startNodes).toEqual(['A']);
    expect(Object.keys(plan.runData)).toEqual(['T']);
  });

  it('a pinned parent counts as having data and its pin is kept', () => {
    const pinned = def(
      [n('T', 'core.manualTrigger'), n('P', 'core.set', [200, 0]), n('C', 'core.set', [400, 0])],
      wire(['T', 'P'], ['P', 'C']),
    );
    const plan = planPartialRun(pinned, {
      root: 'T',
      destination: 'C',
      runData: { T: ok() },
      pinData: { P: items('pin'), Elsewhere: items('x') },
    });
    expect(plan.startNodes).toEqual(['C']);
    expect(plan.pinData).toEqual({ P: items('pin') });
  });

  it('a disabled node in the middle is walked through with its pass-through data', () => {
    const middle = def(
      [
        n('T', 'core.manualTrigger'),
        n('Off', 'core.set', [200, 0], { disabled: true }),
        n('C', 'core.set', [400, 0]),
      ],
      wire(['T', 'Off'], ['Off', 'C']),
    );
    const plan = planPartialRun(middle, {
      root: 'T',
      destination: 'C',
      runData: { T: ok(), Off: ok(), C: ok() },
    });
    expect(plan.startNodes).toEqual(['C']);
    expect(() => planPartialRun(middle, { root: 'T', destination: 'Off', runData: { T: ok() } })).toThrow(
      'Cannot execute a disabled node',
    );
  });

  it('no enabled trigger: falls back to the closest parent with run data, else asks for a trigger', () => {
    const off = def(
      [
        n('T', 'core.manualTrigger', [0, 0], { disabled: true }),
        n('A', 'core.set', [200, 0]),
        n('B', 'core.set', [400, 0]),
      ],
      wire(['T', 'A'], ['A', 'B']),
    );
    const plan = planPartialRun(off, { root: 'T', destination: 'B', runData: { A: ok() } });
    expect(plan.root).toBe('A');
    expect(plan.startNodes).toEqual(['B']);
    expect(Object.keys(plan.runData)).toEqual(['A']);

    let error: unknown;
    try {
      planPartialRun(off, { destination: 'B', runData: {} });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WorkflowOperationError);
    expect((error as Error).message).toBe("Connect a trigger and make sure it's enabled to run this node");
  });

  it('picks a trigger upstream of the destination when no root is given', () => {
    const two = def(
      [
        n('Other', 'core.manualTrigger', [0, -200]),
        n('T', 'core.manualTrigger'),
        n('A', 'core.set', [200, 0]),
      ],
      wire(['T', 'A']),
    );
    const plan = planPartialRun(two, { root: 'Other', destination: 'A', runData: { T: ok(), A: ok() } });
    expect(plan.root).toBe('T');
    expect(plan.startNodes).toEqual(['A']);
  });

  it('a dirty sub-node reruns its root node and drops the sub-node data of cleaned nodes', () => {
    const ai = def(
      [
        n('T', 'core.manualTrigger'),
        n('Agent', 'ai.agent', [200, 0]),
        n('Model', 'ai.model', [200, 200]),
        n('Out', 'core.set', [400, 0]),
      ],
      wire(['T', 'Agent'], ['Agent', 'Out'], ['Model', 'Agent', 0, 0, 'ai_languageModel']),
    );
    const runData: RunData = { T: ok(), Agent: ok(), Model: ok(), Out: ok() };
    const plan = planPartialRun(ai, { root: 'T', destination: 'Out', runData, dirtyNodeNames: ['Model'] });
    expect(plan.startNodes).toEqual(['Agent']);
    expect(Object.keys(plan.runData)).toEqual(['T']);
    expect(plan.subgraph.sort()).toEqual(['Agent', 'Model', 'Out', 'T']);

    const agentDirty = planPartialRun(ai, {
      root: 'T',
      destination: 'Out',
      runData,
      dirtyNodeNames: ['Agent'],
    });
    expect(agentDirty.startNodes).toEqual(['Agent']);
    expect(Object.keys(agentDirty.runData)).toEqual(['T']);
  });

  it('the trigger itself as destination or dirty: the trigger is the start node', () => {
    expect(planPartialRun(line, { root: 'T', destination: 'T', runData: lineRun }).startNodes).toEqual(['T']);
    const plan = planPartialRun(line, {
      root: 'T',
      destination: 'C',
      runData: lineRun,
      dirtyNodeNames: ['T'],
    });
    expect(plan.startNodes).toEqual(['T']);
    expect(plan.runData).toEqual({});
  });

  it('rejects an unknown destination', () => {
    expect(() => planPartialRun(line, { destination: 'Nope', runData: lineRun })).toThrow(
      'Destination node "Nope" does not exist',
    );
  });
});
