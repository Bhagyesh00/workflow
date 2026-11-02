import { createInitialState, WorkflowExecute } from '@workflow/core';
import { type Item, Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, node, nodeTypes, runWorkflow, testServices } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));

/** Set node that copies `field` of `$(from).item` into `orig` and keeps the other fields */
const read = (name: string, from: string, field: string, position: [number, number]) =>
  node(
    name,
    'core.set',
    {
      assignments: {
        assignments: [{ id: '1', name: 'orig', value: `={{ $('${from}').item.json.${field} }}`, type: 'string' }],
      },
      includeOtherFields: true,
    },
    position,
  );

describe('R35 Loop Over Items pairs every batch and the done output with pre-loop items', () => {
  it('resolves $("Trigger").item in all three batches and after the done output', async () => {
    const run = await runWorkflow(
      [
        node('Trigger', 'core.manualTrigger'),
        node('Loop', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
        read('Body', 'Trigger', 'name', [400, 100]),
        read('After', 'Trigger', 'name', [400, -100]),
      ],
      connect(['Trigger', 'Loop'], ['Loop', 'After', 0], ['Loop', 'Body', 1], ['Body', 'Loop']),
      items({ name: 'A' }, { name: 'B' }, { name: 'C' }),
    );
    expect(run.error?.message).toBeUndefined();
    expect(run.status).toBe('success');
    expect(run.runData.Body.map((task) => task.data?.main?.[0]?.map((i) => i.json.orig))).toEqual([
      ['A'],
      ['B'],
      ['C'],
    ]);
    expect(run.json('After').map((json) => [json.name, json.orig])).toEqual([
      ['A', 'A'],
      ['B', 'B'],
      ['C', 'C'],
    ]);
  });

  it('pairs through a node before the loop and a body that reorders each batch', async () => {
    const run = await runWorkflow(
      [
        node('Trigger', 'core.manualTrigger'),
        node(
          'Before',
          'core.set',
          { assignments: { assignments: [{ id: '1', name: 'tag', value: '={{ "t" + $json.n }}', type: 'string' }] } },
          [200, 0],
        ),
        node('Loop', 'core.splitInBatches', { batchSize: 2 }, [400, 0]),
        node(
          'Sort',
          'core.sort',
          { sortFieldsUi: { sortField: [{ fieldName: 'n', order: 'descending' }] } },
          [600, 100],
        ),
        read('Body', 'Before', 'tag', [800, 100]),
        read('After', 'Before', 'tag', [600, -100]),
      ],
      connect(
        ['Trigger', 'Before'],
        ['Before', 'Loop'],
        ['Loop', 'After', 0],
        ['Loop', 'Sort', 1],
        ['Sort', 'Body'],
        ['Body', 'Loop'],
      ),
      items({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }),
    );
    expect(run.error?.message).toBeUndefined();
    expect(run.runData.Body.map((task) => task.data?.main?.[0]?.map((i) => [i.json.n, i.json.orig]))).toEqual([
      [
        [2, 't2'],
        [1, 't1'],
      ],
      [
        [4, 't4'],
        [3, 't3'],
      ],
      [[5, 't5']],
    ]);
    // done items keep the body's order and still pair back to the item that produced them
    expect(run.json('After').map((json) => [json.n, json.orig])).toEqual([
      [2, 't2'],
      [1, 't1'],
      [4, 't4'],
      [3, 't3'],
      [5, 't5'],
    ]);
  });

  it('pairs an inner loop with the outer loop input on every outer round', async () => {
    const run = await runWorkflow(
      [
        node('Trigger', 'core.manualTrigger'),
        node('Outer', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
        node(
          'Split',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: 'return [{json:{i:1}},{json:{i:2}}]' },
          [400, 100],
        ),
        node('Inner', 'core.splitInBatches', { batchSize: 1 }, [600, 100]),
        read('InnerBody', 'Trigger', 'name', [800, 200]),
        read('InnerDone', 'Trigger', 'name', [800, 0]),
        read('After', 'Trigger', 'name', [400, -100]),
      ],
      connect(
        ['Trigger', 'Outer'],
        ['Outer', 'After', 0],
        ['Outer', 'Split', 1],
        ['Split', 'Inner'],
        ['Inner', 'InnerDone', 0],
        ['Inner', 'InnerBody', 1],
        ['InnerBody', 'Inner'],
        ['InnerDone', 'Outer'],
      ),
      items({ name: 'A' }, { name: 'B' }),
    );
    expect(run.error?.message).toBeUndefined();
    expect(run.runData.InnerBody.map((task) => task.data?.main?.[0]?.[0]?.json.orig)).toEqual(['A', 'A', 'B', 'B']);
    expect(run.runData.InnerDone.map((task) => task.data?.main?.[0]?.map((i) => i.json.orig))).toEqual([
      ['A', 'A'],
      ['B', 'B'],
    ]);
    expect(run.json('After').map((json) => json.orig)).toEqual(['A', 'A', 'B', 'B']);
  });
});

describe('R35 Loop Over Items as the start node', () => {
  const loopWorkflow = () =>
    new Workflow(
      {
        name: 'test',
        nodes: [
          node('Trigger', 'core.manualTrigger'),
          node('Loop', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
          read('Body', 'Trigger', 'name', [400, 100]),
          read('After', 'Trigger', 'name', [400, -100]),
        ],
        connections: connect(['Trigger', 'Loop'], ['Loop', 'After', 0], ['Loop', 'Body', 1], ['Body', 'Loop']),
      },
      nodeTypes,
    );

  it('takes its input and source from the run data of the node before it', async () => {
    const first = await new WorkflowExecute(loopWorkflow(), testServices()).run({
      triggerItems: items({ name: 'A' }, { name: 'B' }, { name: 'C' }),
    });
    const state = createInitialState();
    state.resultData.runData.Trigger = first.state.resultData.runData.Trigger;

    const result = await new WorkflowExecute(loopWorkflow(), testServices(), state).run({ startNode: 'Loop' });
    const runData = result.state.resultData.runData;
    expect(result.state.resultData.error?.message).toBeUndefined();
    expect(runData.Loop[0].source).toEqual([{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }]);
    expect(runData.Body.map((task) => task.data?.main?.[0]?.map((i) => i.json.orig))).toEqual([['A'], ['B'], ['C']]);
    expect(runData.After[0].data?.main?.[0]?.map((i) => [i.json.name, i.json.orig])).toEqual([
      ['A', 'A'],
      ['B', 'B'],
      ['C', 'C'],
    ]);
  });

  it('marks the items of later runs as unpaired when the first run had no source', async () => {
    const workflow = new Workflow(
      {
        name: 'test',
        nodes: [
          node('Loop', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
          read('Probe', 'Body', 'name', [400, 100]),
          node('Body', 'core.noOp', {}, [600, 100]),
        ],
        connections: connect(['Loop', 'Probe', 1], ['Probe', 'Body'], ['Body', 'Loop']),
      },
      nodeTypes,
    );
    workflow.nodes.Probe.onError = 'continueRegularOutput';
    const result = await new WorkflowExecute(workflow, testServices()).run({
      startNode: 'Loop',
      triggerItems: items({ name: 'A' }, { name: 'B' }, { name: 'C' }),
    });
    const runData = result.state.resultData.runData;
    expect(runData.Loop[0].source).toEqual([]);
    expect(runData.Loop.map((task) => task.data?.main?.[1]?.map((i) => i.pairedItem))).toEqual([
      [{ item: 0 }],
      [{ item: 1, input: 1 }],
      [{ item: 2, input: 1 }],
      [],
    ]);
    // items of runs 2 and 3 must not resolve against the loop-back input (the previous round's Body)
    for (const task of runData.Probe) {
      expect(task.data?.main?.[0]?.[0]?.json.orig).toBeUndefined();
      expect(task.data?.main?.[0]?.[0]?.json.error).toMatch(/not an ancestor/);
    }
  });
});
