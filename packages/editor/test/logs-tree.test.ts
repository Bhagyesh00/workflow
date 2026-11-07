import type { Connections, RunData, TaskData } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { buildLogsTree, formatTokens, ownTokens, totalTokens, visibleRows } from '../src/lib/logs-tree';

const connections: Connections = {
  Trigger: { main: [[{ node: 'Agent', type: 'main', index: 0 }]] },
  Model: { ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] },
  Search: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
  Calc: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
  Agent: { main: [[{ node: 'Reply', type: 'main', index: 0 }]] },
};

function main(start: number, executionTime: number, extra: Partial<TaskData> = {}): TaskData {
  return {
    startTime: start,
    executionTime,
    executionStatus: 'success',
    data: { main: [[{ json: { ok: true } }]] },
    source: [{ previousNode: 'Trigger' }],
    ...extra,
  };
}

function sub(start: number, type: 'ai_languageModel' | 'ai_tool', json: object, parent = 'Agent'): TaskData {
  return {
    startTime: start,
    executionTime: 0,
    executionStatus: 'success',
    inputOverride: { [type]: [[{ json: { q: 1 } }]] },
    data: { [type]: [[{ json }]] },
    source: [{ previousNode: parent }],
  };
}

const usage = (inputTokens: number, outputTokens: number) => ({ tokenUsage: { inputTokens, outputTokens } });

describe('buildLogsTree', () => {
  it('nests two tool calls and one model run under the agent run, in time order', () => {
    const runData: RunData = {
      Reply: [main(1500, 5)],
      Search: [sub(1100, 'ai_tool', { result: 'a' })],
      Trigger: [main(1000, 1)],
      Agent: [main(1001, 400)],
      Model: [sub(1050, 'ai_languageModel', usage(10, 20)), sub(1200, 'ai_languageModel', usage(2, 10))],
      Calc: [sub(1150, 'ai_tool', { result: 3 })],
    };
    const tree = buildLogsTree(runData, connections);
    expect(tree.map((n) => n.node)).toEqual(['Trigger', 'Agent', 'Reply']);
    const agent = tree[1] as (typeof tree)[number];
    expect(agent.children.map((c) => `${c.node}#${c.runIndex}:${c.type}`)).toEqual([
      'Model#0:ai_languageModel',
      'Search#0:ai_tool',
      'Calc#0:ai_tool',
      'Model#1:ai_languageModel',
    ]);
    expect(agent.type).toBe('main');
    expect(agent.duration).toBe(400);
  });

  it('puts each sub-node run under the agent run that started before it (two agent runs)', () => {
    const runData: RunData = {
      Agent: [main(1000, 200), main(2000, 200)],
      Model: [
        sub(1100, 'ai_languageModel', usage(1, 1)),
        sub(2100, 'ai_languageModel', usage(5, 6)),
        sub(2150, 'ai_languageModel', usage(7, 8)),
      ],
    };
    const [first, second] = buildLogsTree(runData, connections);
    expect(first?.runIndex).toBe(0);
    expect(first?.children.map((c) => c.runIndex)).toEqual([0]);
    expect(second?.runIndex).toBe(1);
    expect(second?.children.map((c) => c.runIndex)).toEqual([1, 2]);
    expect(first?.tokens).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(second?.tokens).toEqual({ inputTokens: 12, outputTokens: 14 });
  });

  it('sums tokens up the tree and writes them as "12 + 30 tokens"', () => {
    const runData: RunData = {
      Agent: [main(1000, 300)],
      Model: [sub(1100, 'ai_languageModel', usage(5, 10)), sub(1200, 'ai_languageModel', usage(7, 20))],
      Search: [sub(1150, 'ai_tool', { result: 'no usage here' })],
    };
    const [agent] = buildLogsTree(runData, connections);
    expect(agent?.tokens).toEqual({ inputTokens: 12, outputTokens: 30 });
    expect(formatTokens(agent?.tokens)).toBe('12 + 30 tokens');
    expect(agent?.children.find((c) => c.node === 'Search')?.tokens).toBeUndefined();
    expect(formatTokens(undefined)).toBe('');
    expect(totalTokens(buildLogsTree(runData, connections))).toEqual({ inputTokens: 12, outputTokens: 30 });
  });

  it('marks a run with an error as error and keeps the others', () => {
    const runData: RunData = {
      Agent: [main(1000, 50, { error: { name: 'Error', message: 'boom' }, executionStatus: 'success' })],
      Reply: [main(2000, 1, { executionStatus: 'running' })],
    };
    const tree = buildLogsTree(runData, connections);
    expect(tree[0]?.status).toBe('error');
    expect(tree[1]?.status).toBe('running');
  });

  it('shows a sub-node run whose parent has no run as a top-level row', () => {
    const tree = buildLogsTree({ Model: [sub(10, 'ai_languageModel', usage(1, 2))] }, connections);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.node).toBe('Model');
  });

  it('nests a sub-node under a sub-node (model under an agent tool under an agent)', () => {
    const nested: Connections = {
      ...connections,
      ToolAgent: { ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] },
      InnerModel: { ai_languageModel: [[{ node: 'ToolAgent', type: 'ai_languageModel', index: 0 }]] },
    };
    const runData: RunData = {
      Agent: [main(1000, 500)],
      ToolAgent: [sub(1100, 'ai_tool', { r: 1 })],
      InnerModel: [sub(1090, 'ai_languageModel', usage(3, 4))],
    };
    const [agent] = buildLogsTree(runData, nested);
    // the inner model ran (1090) before the tool call was logged (1100): it falls to the first run
    expect(agent?.children.map((c) => c.node)).toEqual(['ToolAgent']);
    expect(agent?.children[0]?.children.map((c) => c.node)).toEqual(['InnerModel']);
    expect(agent?.tokens).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it('reads tokens only from numbers', () => {
    expect(
      ownTokens(sub(1, 'ai_languageModel', { tokenUsage: { inputTokens: 'x', outputTokens: -3 } })),
    ).toBe(undefined);
    expect(ownTokens(sub(1, 'ai_languageModel', usage(4, 0)))).toEqual({ inputTokens: 4, outputTokens: 0 });
  });
});

describe('visibleRows', () => {
  it('hides the children of a collapsed node and reports depth and parent', () => {
    const runData: RunData = {
      Agent: [main(1000, 300)],
      Model: [sub(1100, 'ai_languageModel', usage(1, 1))],
    };
    const tree = buildLogsTree(runData, connections);
    const open = visibleRows(tree, new Set());
    expect(open.map((r) => [r.node.node, r.depth, r.parent?.node ?? null])).toEqual([
      ['Agent', 0, null],
      ['Model', 1, 'Agent'],
    ]);
    expect(visibleRows(tree, new Set(['Agent#0'])).map((r) => r.node.node)).toEqual(['Agent']);
  });
});
