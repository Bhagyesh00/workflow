/**
 * P3-06 partial runs in the engine: run data of an earlier execution + destination + dirty nodes. Only the dirty
 * node and the nodes after it run again (multi-start); a Merge that also reads a reused branch gets both inputs
 * (waiting seed).
 */
import { type Item, type RunData, Workflow, type WorkflowDefinition } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { WorkflowExecute } from '../src/engine/workflow-execute';
import { connect, node, nodeTypes, services } from './helpers';

// Trigger -> A -> B -> Merge[0]; A -> Y -> Merge[1]; Merge -> C
function definition(bValue: string): WorkflowDefinition {
  return {
    name: 'partial',
    nodes: [
      node('Trigger', 'test.trigger'),
      node('A', 'test.set', [200, 0], { parameters: { field: 'a', value: 'A' } }),
      node('B', 'test.set', [400, -100], { parameters: { field: 'b', value: bValue } }),
      node('Y', 'test.set', [400, 100], { parameters: { field: 'y', value: 'Y' } }),
      node('Merge', 'test.merge', [600, 0]),
      node('C', 'test.set', [800, 0], { parameters: { field: 'c', value: 'C' } }),
    ],
    connections: connect(
      ['Trigger', 'A'],
      ['A', 'B'],
      ['A', 'Y'],
      ['B', 'Merge', 0, 0],
      ['Y', 'Merge', 0, 1],
      ['Merge', 'C'],
    ),
  };
}

function engine(def: WorkflowDefinition, started: string[] = []) {
  return new WorkflowExecute(
    new Workflow(def, nodeTypes),
    services({
      hooks: {
        nodeExecuteBefore: async (name: string) => {
          started.push(name);
        },
      },
    }),
  );
}

const json = (runData: RunData, name: string) =>
  (runData[name]?.at(-1)?.data?.main?.[0] as Item[] | undefined)?.map((i) => i.json);

describe('partial run with dirty nodes', () => {
  it('reruns the dirty node and the nodes after it once; the trigger and A are reused; Merge gets both inputs', async () => {
    const first = await engine(definition('old')).run({ triggerItems: [{ json: { n: 1 } }] });
    expect(first.status).toBe('success');
    const earlier = first.state.resultData.runData;
    expect(json(earlier, 'C')).toEqual([
      { n: 1, a: 'A', b: 'old', c: 'C' },
      { n: 1, a: 'A', y: 'Y', c: 'C' },
    ]);

    const started: string[] = [];
    const result = await engine(definition('new'), started).run({
      startNode: 'Trigger',
      destinationNode: 'C',
      runData: earlier,
      dirtyNodeNames: ['B'],
    });
    expect(result.status).toBe('success');
    expect(started).toEqual(['B', 'Merge', 'C']);
    const runData = result.state.resultData.runData;
    // reused tasks are the very same records
    expect(runData.Trigger).toHaveLength(1);
    expect(runData.Trigger[0]).toBe(earlier.Trigger[0]);
    expect(runData.A[0]).toBe(earlier.A[0]);
    expect(runData.Y[0]).toBe(earlier.Y[0]);
    expect(runData.B).toHaveLength(1);
    expect(runData.Merge).toHaveLength(1);
    expect(runData.C).toHaveLength(1);
    expect(json(runData, 'Merge')).toEqual([
      { n: 1, a: 'A', b: 'new' },
      { n: 1, a: 'A', y: 'Y' },
    ]);
    expect(runData.Merge[0].source).toEqual([
      { previousNode: 'B', previousNodeOutput: 0, previousNodeRun: 0 },
      { previousNode: 'Y', previousNodeOutput: 0, previousNodeRun: 0 },
    ]);
    expect(result.state.executionData.waitingExecution).toEqual({});
  });

  it('with nothing dirty only the destination runs again, from its parents run data', async () => {
    const first = await engine(definition('old')).run({ triggerItems: [{ json: { n: 1 } }] });
    const started: string[] = [];
    const result = await engine(definition('old'), started).run({
      startNode: 'Trigger',
      destinationNode: 'Merge',
      runData: first.state.resultData.runData,
    });
    expect(result.status).toBe('success');
    expect(started).toEqual(['Merge']);
    // the run stops at the destination; data after it is dropped
    expect(result.state.resultData.runData.C).toBeUndefined();
    expect(json(result.state.resultData.runData, 'Merge')).toHaveLength(2);
  });

  it('a pinned parent feeds the start node its pinned items', async () => {
    const first = await engine(definition('old')).run({ triggerItems: [{ json: { n: 1 } }] });
    const started: string[] = [];
    const result = await engine(definition('old'), started).run({
      startNode: 'Trigger',
      destinationNode: 'B',
      runData: first.state.resultData.runData,
      pinData: { A: [{ json: { pinned: true } }] },
      dirtyNodeNames: ['B'],
    });
    expect(started).toEqual(['B']);
    expect(json(result.state.resultData.runData, 'B')).toEqual([{ pinned: true, b: 'old' }]);
  });

  it('a dirty trigger runs again with the given trigger items', async () => {
    const first = await engine(definition('old')).run({ triggerItems: [{ json: { n: 1 } }] });
    const started: string[] = [];
    const result = await engine(definition('old'), started).run({
      startNode: 'Trigger',
      destinationNode: 'A',
      runData: first.state.resultData.runData,
      dirtyNodeNames: ['Trigger'],
      triggerItems: [{ json: { n: 2 } }],
    });
    expect(started).toEqual(['Trigger', 'A']);
    expect(json(result.state.resultData.runData, 'A')).toEqual([{ n: 2, a: 'A' }]);
  });

  it('rejects a disabled destination', async () => {
    const def = definition('old');
    def.nodes.find((n) => n.name === 'C')!.disabled = true;
    await expect(
      engine(def).run({ startNode: 'Trigger', destinationNode: 'C', runData: {} }),
    ).rejects.toThrow('Cannot execute a disabled node');
  });
});
