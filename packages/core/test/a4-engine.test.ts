import { type Item, type NodeType, Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { NodeTypes } from '../src';
import { createInitialState, WorkflowExecute } from '../src/engine/workflow-execute';
import { connect, node, services, testNodes } from './helpers';

const hinter: NodeType = {
  description: {
    name: 'test.hinter',
    displayName: 'Hinter',
    description: '',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Hinter' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [{ displayName: 'Fail', name: 'fail', type: 'boolean', default: false }],
  },
  async execute(ctx) {
    ctx.addExecutionHints({ message: 'First hint', level: 'info' }, { message: 'Second hint' });
    ctx.addExecutionHints({ message: 'Third hint', level: 'warning' });
    if (ctx.getNodeParameter('fail', 0)) throw new Error('boom');
    return [ctx.getInputData()];
  },
};

const nodeTypes = new NodeTypes([...testNodes, hinter]);
const engine = (definition: ConstructorParameters<typeof Workflow>[0], state = createInitialState()) =>
  new WorkflowExecute(new Workflow(definition, nodeTypes), services({ nodeTypes }), state);

describe('execution hints added by a node', () => {
  it('stores every hint of the run on the task', async () => {
    const result = await engine({
      name: 'hints',
      nodes: [node('Trigger', 'test.trigger'), node('Hinter', 'test.hinter', [200, 0])],
      connections: connect(['Trigger', 'Hinter']),
    }).run();
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Hinter[0].hints).toEqual([
      { message: 'First hint', level: 'info' },
      { message: 'Second hint' },
      { message: 'Third hint', level: 'warning' },
    ]);
    expect(result.state.resultData.runData.Trigger[0].hints).toBeUndefined();
  });

  it('keeps the node hints next to the error output hint', async () => {
    const result = await engine({
      name: 'hints',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Hinter', 'test.hinter', [200, 0], { parameters: { fail: true }, onError: 'continueErrorOutput' }),
      ],
      connections: connect(['Trigger', 'Hinter']),
    }).run();
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Hinter[0].hints).toEqual([
      { message: 'First hint', level: 'info' },
      { message: 'Second hint' },
      { message: 'Third hint', level: 'warning' },
      { message: 'Node failed; items were routed to the error output', level: 'warning' },
    ]);
  });
});

describe('start node of a run whose parents already have run data', () => {
  const task = (main: Item[][]) => ({
    startTime: 0,
    executionTime: 0,
    executionStatus: 'success' as const,
    data: { main },
    source: [],
  });

  it('gets its input and a real source from the last run of each parent', async () => {
    const state = createInitialState();
    state.resultData.runData.Trigger = [
      task([[{ json: { name: 'old' } }]]),
      task([[{ json: { name: 'Ada' } }, { json: { name: 'Bob' } }]]),
    ];
    const result = await engine(
      {
        name: 'partial',
        nodes: [
          node('Trigger', 'test.trigger'),
          node('Set', 'test.set', [200, 0], {
            parameters: { field: 'orig', value: "={{ $('Trigger').item.json.name }}" },
          }),
        ],
        connections: connect(['Trigger', 'Set']),
      },
      state,
    ).run({ startNode: 'Set' });
    expect(result.status).toBe('success');
    const set = result.state.resultData.runData.Set[0];
    expect(set.source).toEqual([{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 1 }]);
    expect(set.data?.main?.[0]?.map((i) => i.json)).toEqual([
      { name: 'Ada', orig: 'Ada' },
      { name: 'Bob', orig: 'Bob' },
    ]);
  });

  it('reads the output each input is connected to and leaves inputs without parent data empty', async () => {
    const state = createInitialState();
    state.resultData.runData.IF = [task([[{ json: { side: 'true' } }], [{ json: { side: 'false' } }]])];
    const result = await engine(
      {
        name: 'partial',
        nodes: [
          node('Trigger', 'test.trigger'),
          node('IF', 'test.if', [200, 0]),
          node('Other', 'test.set', [200, 200]),
          node('Merge', 'test.merge', [400, 0]),
        ],
        connections: connect(['Trigger', 'IF'], ['Trigger', 'Other'], ['IF', 'Merge', 1, 0], ['Other', 'Merge', 0, 1]),
      },
      state,
    ).run({ startNode: 'Merge' });
    expect(result.status).toBe('success');
    const merge = result.state.resultData.runData.Merge[0];
    expect(merge.source).toEqual([{ previousNode: 'IF', previousNodeOutput: 1, previousNodeRun: 0 }, null]);
    expect(merge.data?.main?.[0]?.map((i) => i.json)).toEqual([{ side: 'false' }]);
  });

  it('keeps the trigger items and no source when no parent has run data', async () => {
    const result = await engine({
      name: 'fresh',
      nodes: [node('Trigger', 'test.trigger'), node('Set', 'test.set', [200, 0])],
      connections: connect(['Trigger', 'Set']),
    }).run({ startNode: 'Set', triggerItems: [{ json: { a: 1 } }] });
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Set[0].source).toEqual([]);
    expect(result.state.resultData.runData.Set[0].data?.main?.[0]?.map((i) => i.json.a)).toEqual([1]);
  });

  it('lets trigger items given for the run win over the run data of the parents', async () => {
    const state = createInitialState();
    state.resultData.runData.Trigger = [task([[{ json: { a: 'old' } }]])];
    const result = await engine(
      {
        name: 'explicit',
        nodes: [node('Trigger', 'test.trigger'), node('Set', 'test.set', [200, 0])],
        connections: connect(['Trigger', 'Set']),
      },
      state,
    ).run({ startNode: 'Set', triggerItems: [{ json: { a: 'given' } }] });
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Set[0].source).toEqual([]);
    expect(result.state.resultData.runData.Set[0].data?.main?.[0]?.map((i) => i.json.a)).toEqual(['given']);
  });

  it('runs a partial run from the run data it is given, and runs the start node and later nodes again', async () => {
    const result = await engine({
      name: 'partial',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Set', 'test.set', [200, 0], {
          parameters: { field: 'orig', value: "={{ $('Trigger').item.json.name }}" },
        }),
        node('After', 'test.set', [400, 0], { parameters: { field: 'after', value: 'yes' } }),
      ],
      connections: connect(['Trigger', 'Set'], ['Set', 'After']),
    }).run({
      startNode: 'Set',
      runData: {
        Trigger: [task([[{ json: { name: 'Ada' } }]])],
        Set: [task([[{ json: { stale: true } }]])],
        After: [task([[{ json: { stale: true } }]])],
        Gone: [task([[{ json: { stale: true } }]])],
      },
    });
    expect(result.status).toBe('success');
    const runData = result.state.resultData.runData;
    expect(Object.keys(runData).sort()).toEqual(['After', 'Set', 'Trigger']);
    expect(runData.Trigger).toHaveLength(1);
    expect(runData.Set.map((t) => t.data?.main?.[0]?.map((i) => i.json))).toEqual([[{ name: 'Ada', orig: 'Ada' }]]);
    expect(runData.After).toHaveLength(1);
    expect(runData.After[0].data?.main?.[0]?.[0].json.after).toBe('yes');
  });
});
