import { describe, expect, it } from 'vitest';
import {
  type ExpressionDataContext,
  ExpressionError,
  ExpressionEvaluator,
  type Item,
  type RunData,
  resolvePairedItem,
  type SourceData,
  type TaskData,
} from '../src';

const task = (source: TaskData['source'], main: Item[][]): TaskData => ({
  startTime: 0,
  executionTime: 0,
  executionStatus: 'success',
  source,
  data: { main },
});

const trigger: SourceData = { previousNode: 'T', previousNodeOutput: 0, previousNodeRun: 0 };
const names = ['A', 'B', 'C'];

/**
 * T -> Loop -> Body -> Loop, as the second loop run leaves it: Loop run 1 got Body run 0 as input and
 * emits T's item 1 again, which only `sourceOverwrite` can point at.
 */
function loopRunData(paired: Item['pairedItem']): RunData {
  return {
    T: [task([], [names.map((name) => ({ json: { name } }))])],
    Loop: [
      task([trigger], [[], [{ json: { name: 'A' }, pairedItem: { item: 0 } }]]),
      task([{ previousNode: 'Body', previousNodeRun: 0 }], [[], [{ json: { name: 'B' }, pairedItem: paired }]]),
    ],
    Body: [task([{ previousNode: 'Loop', previousNodeOutput: 1, previousNodeRun: 0 }], [[{ json: { orig: 'A' } }]])],
  };
}

const bodyInput: SourceData = { previousNode: 'Loop', previousNodeOutput: 1, previousNodeRun: 1 };

function ctx(runData: RunData): ExpressionDataContext {
  const n = (name: string) => ({
    id: name,
    name,
    type: 't',
    typeVersion: 1,
    position: [0, 0] as [number, number],
    parameters: {},
  });
  return {
    workflow: { name: 'x', active: false, nodes: { T: n('T'), Loop: n('Loop'), Body: n('Body') } },
    runData,
    activeNodeName: 'Body',
    connectionInputData: runData.Loop[1].data!.main![1]!,
    itemIndex: 0,
    runIndex: 1,
    mode: 'manual',
    executionId: 'ex1',
    timezone: 'UTC',
    executeData: { node: 'Body', data: {}, source: { main: [bodyInput] } },
  };
}

describe('R35 paired items carry the source they refer to', () => {
  it('follows sourceOverwrite instead of the task source', () => {
    const runData = loopRunData({ item: 1, sourceOverwrite: trigger });
    expect(resolvePairedItem(runData, 'T', bodyInput, 0).json.name).toBe('B');
    expect(new ExpressionEvaluator().evaluate('={{ $("T").item.json.name }}', ctx(runData))).toBe('B');
  });

  it('follows sourceOverwrite in a list of paired items', () => {
    const runData = loopRunData([{ item: 2, sourceOverwrite: trigger }]);
    expect(resolvePairedItem(runData, 'T', bodyInput, 0).json.name).toBe('C');
  });

  it('still resolves against the task source without an overwrite', () => {
    // item 0 of Body run 0 is the loop's input on run 1, so it pairs back to Loop run 0 item 0, then T item 0
    const runData = loopRunData({ item: 0 });
    runData.Body[0].data!.main![0]![0].pairedItem = { item: 0 };
    expect(resolvePairedItem(runData, 'T', bodyInput, 0).json.name).toBe('A');
  });
});

describe('A5 paired item walk stays bounded on submitted run data', () => {
  const twoInputs = [
    { item: 0, input: 0 },
    { item: 0, input: 1 },
  ];

  it('stops quickly on cyclic run data with two branches per step', () => {
    // a partial run can submit A whose source is A twice: without memo this is 2^500 tries
    const runData: RunData = {
      A: [task([{ previousNode: 'A' }, { previousNode: 'A' }], [[{ json: {}, pairedItem: twoInputs }]])],
    };
    expect(() => resolvePairedItem(runData, 'Trigger', { previousNode: 'A' }, 0)).toThrow(ExpressionError);
  });

  it('stops quickly on a long chain of diamonds that never reaches the target', () => {
    // N0 <- N1 <- ... <- N60, each item pairing twice to the node before: 2^60 paths without memo
    const runData: RunData = { N0: [task([], [[{ json: {} }]])] };
    for (let i = 1; i <= 60; i++) {
      const prev = { previousNode: `N${i - 1}` };
      runData[`N${i}`] = [task([prev, prev], [[{ json: {}, pairedItem: twoInputs }]])];
    }
    expect(() => resolvePairedItem(runData, 'Trigger', { previousNode: 'N60' }, 0)).toThrow(ExpressionError);
  });

  it('still finds the target when only the second branch to the same node reaches it', () => {
    // X item 0 pairs to M item 0 (dead end) and M item 1 (pairs to T item 2)
    const runData: RunData = {
      T: [task([], [names.map((name) => ({ json: { name } }))])],
      M: [task([trigger], [[{ json: {}, pairedItem: [] }, { json: {}, pairedItem: { item: 2 } }]])],
      X: [
        task(
          [{ previousNode: 'M' }],
          [
            [
              {
                json: {},
                pairedItem: [
                  { item: 0, input: 0 },
                  { item: 1, input: 0 },
                ],
              },
            ],
          ],
        ),
      ],
    };
    // M item 0 has no pairedItem, and M has 2 items for T's 3, so that branch throws
    expect(resolvePairedItem(runData, 'T', { previousNode: 'X' }, 0).json.name).toBe('C');
  });

  it('still finds the target through a node already tried on another run', () => {
    // X pairs to M run 0 (dead end through the cycle) and then M run 1 (reaches T)
    const runData: RunData = {
      T: [task([], [names.map((name) => ({ json: { name } }))])],
      M: [
        task([{ previousNode: 'X' }], [[{ json: {}, pairedItem: { item: 0 } }]]),
        task([trigger], [[{ json: {}, pairedItem: { item: 1 } }]]),
      ],
      X: [
        task(
          [
            { previousNode: 'M', previousNodeRun: 0 },
            { previousNode: 'M', previousNodeRun: 1 },
          ],
          [[{ json: {}, pairedItem: twoInputs }]],
        ),
      ],
    };
    expect(resolvePairedItem(runData, 'T', { previousNode: 'X' }, 0).json.name).toBe('B');
  });
});
