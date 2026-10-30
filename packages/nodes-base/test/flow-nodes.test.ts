import { WorkflowExecute } from '@workflow/core';
import { evaluateSimple, type FilterValue, type Item, resolvePorts, Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { IN_PROCESS_WAIT_LIMIT_MS } from '../src/nodes/core/flow.nodes';
import { connect, node, nodeTypes, runNode, runWorkflow, testServices } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));

function numberCondition(
  operation: 'gt' | 'lt' | 'equals',
  right: unknown,
  left = '={{ $json.n }}',
): FilterValue {
  return {
    combinator: 'and',
    conditions: [{ id: '1', leftValue: left, rightValue: right, operator: { type: 'number', operation } }],
  };
}

describe('If', () => {
  it('routes items to true and false outputs with paired items', async () => {
    const r = await runNode(
      'core.if',
      { conditions: numberCondition('gt', 2) },
      items({ n: 1 }, { n: 3 }, { n: 5 }),
    );
    expect(r.outputs).toEqual([[{ n: 3 }, { n: 5 }], [{ n: 1 }]]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 1 }, { item: 2 }]);
  });

  it('fails on type mismatch unless loose type validation is on', async () => {
    const strictRun = await runNode('core.if', { conditions: numberCondition('gt', 2) }, items({ n: '3' }));
    expect(strictRun.status).toBe('error');
    expect(strictRun.error?.message).toMatch(/Wrong type/);
    const looseRun = await runNode(
      'core.if',
      { conditions: numberCondition('gt', 2), looseTypeValidation: true },
      items({ n: '3' }),
    );
    expect(looseRun.outputs[0]).toEqual([{ n: '3' }]);
  });

  it('continues on fail with an error item', async () => {
    const r = await runNode(
      'core.if',
      { conditions: numberCondition('gt', 2) },
      items({ n: 'x' }, { n: 5 }),
      {
        node: { onError: 'continueRegularOutput' },
      },
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ n: 5 }]);
    expect(r.outputs[1][0]).toMatchObject({ n: 'x', error: expect.stringMatching(/Wrong type/) });
  });

  it('ignores case through the option', async () => {
    const conditions: FilterValue = {
      combinator: 'and',
      conditions: [
        {
          id: '1',
          leftValue: '={{ $json.s }}',
          rightValue: 'abc',
          operator: { type: 'string', operation: 'equals' },
        },
      ],
    };
    const r = await runNode('core.if', { conditions, options: { ignoreCase: true } }, items({ s: 'ABC' }));
    expect(r.outputs[0]).toEqual([{ s: 'ABC' }]);
  });
});

describe('Filter', () => {
  it('keeps matching items and drops the rest', async () => {
    const r = await runNode(
      'core.filter',
      { conditions: numberCondition('lt', 3) },
      items({ n: 1 }, { n: 4 }, { n: 2 }),
    );
    expect(r.outputs).toEqual([[{ n: 1 }, { n: 2 }]]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 2 }]);
  });

  it('can output discarded items on a second output', async () => {
    const params = { conditions: numberCondition('lt', 3), options: { allowFallthrough: true } };
    const r = await runNode('core.filter', params, items({ n: 1 }, { n: 4 }));
    expect(r.outputs).toEqual([[{ n: 1 }], [{ n: 4 }]]);
    const ports = resolvePorts(
      nodeTypes.get('core.filter')!.description.outputs,
      node('F', 'core.filter', params),
      (e, p) => evaluateSimple(e, { $parameter: p }),
    );
    expect(ports).toHaveLength(2);
  });

  it('reports invalid conditions', async () => {
    const r = await runNode(
      'core.filter',
      {
        conditions: {
          combinator: 'and',
          conditions: [
            { id: '1', leftValue: 1, rightValue: 1, operator: { type: 'number', operation: 'contains' } },
          ],
        },
      },
      items({}),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not available/);
  });
});

describe('Switch', () => {
  const rules = {
    values: [
      { conditions: numberCondition('lt', 10), renameOutput: true, outputKey: 'small' },
      { conditions: numberCondition('lt', 100) },
    ],
  };

  it('sends each item to the first matching rule and drops unmatched items', async () => {
    const r = await runNode('core.switch', { mode: 'rules', rules }, items({ n: 5 }, { n: 50 }, { n: 500 }));
    expect(r.outputs).toEqual([[{ n: 5 }], [{ n: 50 }]]);
  });

  it('supports an extra fallback output and send-to-all-matching', async () => {
    const r = await runNode(
      'core.switch',
      { mode: 'rules', rules, options: { fallbackOutput: 'extra', allMatchingOutputs: true } },
      items({ n: 5 }, { n: 500 }),
    );
    expect(r.outputs).toEqual([[{ n: 5 }], [{ n: 5 }], [{ n: 500 }]]);
  });

  it('can send unmatched items to an existing output', async () => {
    const r = await runNode(
      'core.switch',
      { mode: 'rules', rules, options: { fallbackOutput: 0 } },
      items({ n: 500 }),
    );
    expect(r.outputs[0]).toEqual([{ n: 500 }]);
  });

  it('declares its outputs as an expression the editor and engine can evaluate', () => {
    const description = nodeTypes.get('core.switch')!.description;
    const evaluate = (e: string, p: object) => evaluateSimple(e, { $parameter: p });
    const withFallback = resolvePorts(
      description.outputs,
      node('S', 'core.switch', {
        mode: 'rules',
        rules,
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'Other' },
      }),
      evaluate,
    );
    expect(withFallback).toEqual([
      { type: 'main', displayName: 'small' },
      { type: 'main', displayName: '1' },
      { type: 'main', displayName: 'Other' },
    ]);
    const byExpression = resolvePorts(
      description.outputs,
      node('S', 'core.switch', { mode: 'expression', numberOutputs: 3 }),
      evaluate,
    );
    expect(byExpression).toHaveLength(3);
    expect(resolvePorts(description.outputs, node('S', 'core.switch', {}), evaluate)).toEqual([]);
  });

  it('routes by an output index expression', async () => {
    const r = await runNode(
      'core.switch',
      { mode: 'expression', numberOutputs: 3, output: '={{ $json.priority === "high" ? 0 : 2 }}' },
      items({ priority: 'high' }, { priority: 'low' }),
    );
    expect(r.outputs).toEqual([[{ priority: 'high' }], [], [{ priority: 'low' }]]);
  });

  it('rejects an output index out of range', async () => {
    const r = await runNode(
      'core.switch',
      { mode: 'expression', numberOutputs: 2, output: '={{ 5 }}' },
      items({}),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not between 0 and 1/);
  });

  it('routes to the right child nodes in a workflow', async () => {
    const run = await runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('Switch', 'core.switch', { mode: 'rules', rules }, [200, 0]),
        node('Small', 'core.noOp', {}, [400, 0]),
        node('Medium', 'core.noOp', {}, [400, 200]),
      ],
      connect(['Start', 'Switch'], ['Switch', 'Small', 0], ['Switch', 'Medium', 1]),
      items({ n: 1 }, { n: 20 }),
    );
    expect(run.json('Small')).toEqual([{ n: 1 }]);
    expect(run.json('Medium')).toEqual([{ n: 20 }]);
  });
});

describe('Merge', () => {
  const twoInputs = (params: Record<string, unknown>, a: object[], b: object[]) =>
    runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node(
          'A',
          'core.set',
          { mode: 'raw', includeOtherFields: false, jsonOutput: '={{ JSON.stringify($json) }}' },
          [200, 0],
        ),
        node(
          'B',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: `return ${JSON.stringify(b)}.map(json => ({ json }))` },
          [200, 200],
        ),
        node('Merge', 'core.merge', params, [400, 100]),
      ],
      connect(['Start', 'A'], ['Start', 'B'], ['A', 'Merge', 0, 0], ['B', 'Merge', 0, 1]),
      items(...a),
    );

  it('appends inputs in order with input-aware paired items', async () => {
    const run = await twoInputs({ mode: 'append' }, [{ a: 1 }, { a: 2 }], [{ b: 1 }]);
    expect(run.json('Merge')).toEqual([{ a: 1 }, { a: 2 }, { b: 1 }]);
    expect(run.items('Merge').map((i) => i.pairedItem)).toEqual([
      { item: 0, input: 0 },
      { item: 1, input: 0 },
      { item: 0, input: 1 },
    ]);
  });

  const users = [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Bob' },
    { id: 3, name: 'Cy' },
  ];
  const orders = [
    { userId: 1, total: 10 },
    { userId: 1, total: 15 },
    { userId: 4, total: 99 },
  ];
  const join = (joinMode: string, extra: object = {}) => ({
    mode: 'combineByMatchingFields',
    fieldsToMatch: { values: [{ field1: 'id', field2: 'userId' }] },
    joinMode,
    ...extra,
  });

  it('inner join keeps matches (all matches by default)', async () => {
    const run = await twoInputs(join('inner'), users, orders);
    expect(run.json('Merge')).toEqual([
      { id: 1, name: 'Ada', userId: 1, total: 10 },
      { id: 1, name: 'Ada', userId: 1, total: 15 },
    ]);
    expect(run.items('Merge')[0].pairedItem).toEqual([
      { item: 0, input: 0 },
      { item: 0, input: 1 },
    ]);
  });

  it('inner join can keep only first matches or only one side', async () => {
    const first = await twoInputs(join('inner', { options: { multipleMatches: 'first' } }), users, orders);
    expect(first.json('Merge')).toHaveLength(1);
    const input1 = await twoInputs(join('inner', { outputDataFrom: 'input1' }), users, orders);
    expect(input1.json('Merge')).toEqual([{ id: 1, name: 'Ada' }]);
    const input2 = await twoInputs(join('inner', { outputDataFrom: 'input2' }), users, orders);
    expect(input2.json('Merge')).toEqual([
      { userId: 1, total: 10 },
      { userId: 1, total: 15 },
    ]);
  });

  it('left, right, outer and anti joins', async () => {
    const left = await twoInputs(join('left'), users, orders);
    expect(left.json('Merge').map((j) => j.name)).toEqual(['Ada', 'Ada', 'Bob', 'Cy']);
    const right = await twoInputs(join('right'), users, orders);
    expect(right.json('Merge')).toEqual([
      { id: 1, name: 'Ada', userId: 1, total: 10 },
      { id: 1, name: 'Ada', userId: 1, total: 15 },
      { userId: 4, total: 99 },
    ]);
    const outer = await twoInputs(join('outer'), users, orders);
    expect(outer.json('Merge')).toHaveLength(5);
    const antiLeft = await twoInputs(join('antiLeft'), users, orders);
    expect(antiLeft.json('Merge')).toEqual([
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Cy' },
    ]);
    const antiRight = await twoInputs(join('antiRight'), users, orders);
    expect(antiRight.json('Merge')).toEqual([{ userId: 4, total: 99 }]);
  });

  it('fuzzy compare matches 1 and "1", clash handling adds suffixes', async () => {
    const run = await twoInputs(
      join('inner', { options: { fuzzyCompare: true, clashHandling: 'addSuffix' } }),
      [{ id: '1', v: 'a' }],
      [{ userId: 1, v: 'b' }],
    );
    expect(run.json('Merge')).toEqual([{ id: '1', v_1: 'a', userId: 1, v_2: 'b' }]);
    const strictRun = await twoInputs(join('inner'), [{ id: '1' }], [{ userId: 1 }]);
    expect(strictRun.status).toBe('success');
    expect(strictRun.runData.Merge[0].data?.main?.[0]).toEqual([]);
  });

  it('combines by position and all combinations', async () => {
    const byPosition = await twoInputs({ mode: 'combineByPosition' }, [{ a: 1 }, { a: 2 }], [{ b: 1 }]);
    expect(byPosition.json('Merge')).toEqual([{ a: 1, b: 1 }]);
    const unpaired = await twoInputs(
      { mode: 'combineByPosition', options: { includeUnpaired: true } },
      [{ a: 1 }, { a: 2 }],
      [{ b: 1 }],
    );
    expect(unpaired.json('Merge')).toEqual([{ a: 1, b: 1 }, { a: 2 }]);
    const all = await twoInputs(
      { mode: 'combineAllCombinations' },
      [{ a: 1 }, { a: 2 }],
      [{ b: 1 }, { b: 2 }],
    );
    expect(all.json('Merge')).toHaveLength(4);
    const preferFirst = await twoInputs(
      { mode: 'combineByPosition', options: { clashHandling: 'preferInput1' } },
      [{ x: 1 }],
      [{ x: 2 }],
    );
    expect(preferFirst.json('Merge')).toEqual([{ x: 1 }]);
  });

  it('chooses a branch or outputs one empty item', async () => {
    const second = await twoInputs(
      { mode: 'chooseBranch', useDataOfInput: 2 },
      [{ a: 1 }],
      [{ b: 1 }, { b: 2 }],
    );
    expect(second.json('Merge')).toEqual([{ b: 1 }, { b: 2 }]);
    const empty = await twoInputs(
      { mode: 'chooseBranch', chooseBranchMode: 'empty' },
      [{ a: 1 }],
      [{ b: 1 }],
    );
    expect(empty.json('Merge')).toEqual([{}]);
    const bad = await twoInputs({ mode: 'chooseBranch', useDataOfInput: 3 }, [{ a: 1 }], [{ b: 1 }]);
    expect(bad.status).toBe('error');
  });

  it('requires fields to match', async () => {
    const run = await twoInputs(
      { mode: 'combineByMatchingFields', fieldsToMatch: { values: [] } },
      [{ a: 1 }],
      [{ b: 1 }],
    );
    expect(run.status).toBe('error');
    expect(run.error?.message).toMatch(/at least one pair/);
  });

  it('declares 2-10 inputs through an expression', () => {
    const description = nodeTypes.get('core.merge')!.description;
    const ports = resolvePorts(description.inputs, node('M', 'core.merge', { numberInputs: 4 }), (e, p) =>
      evaluateSimple(e, { $parameter: p }),
    );
    expect(ports).toHaveLength(4);
  });

  it('appends three inputs', async () => {
    const run = await runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('A', 'core.noOp', {}, [200, 0]),
        node('B', 'core.noOp', {}, [200, 100]),
        node('C', 'core.noOp', {}, [200, 200]),
        node('Merge', 'core.merge', { mode: 'append', numberInputs: 3 }, [400, 100]),
      ],
      connect(
        ['Start', 'A'],
        ['Start', 'B'],
        ['Start', 'C'],
        ['A', 'Merge', 0, 0],
        ['B', 'Merge', 0, 1],
        ['C', 'Merge', 0, 2],
      ),
      items({ v: 1 }),
    );
    expect(run.json('Merge')).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]);
  });
});

describe('Loop Over Items', () => {
  it('loops in batches and outputs all processed items on done', async () => {
    const run = await runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('Loop', 'core.splitInBatches', { batchSize: 2 }, [200, 0]),
        node(
          'Body',
          'core.set',
          { assignments: { assignments: [{ name: 'seen', value: '={{ $runIndex }}', type: 'number' }] } },
          [400, 100],
        ),
        node('Done', 'core.noOp', {}, [400, -100]),
      ],
      connect(['Start', 'Loop'], ['Loop', 'Done', 0], ['Loop', 'Body', 1], ['Body', 'Loop']),
      items({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }),
    );
    expect(run.status).toBe('success');
    expect(run.runData.Body).toHaveLength(3);
    expect(run.json('Done')).toEqual([
      { n: 1, seen: 0 },
      { n: 2, seen: 0 },
      { n: 3, seen: 1 },
      { n: 4, seen: 1 },
      { n: 5, seen: 2 },
    ]);
    // the loop context is cleared once done
    expect(run.result.state.executionData.contextData['node:Loop']).toEqual({});
    // $('Loop Over Items').item works inside the loop on later rounds
    expect(run.items('Loop', 1, 1).map((i) => i.pairedItem)).toEqual([
      { item: 2, input: 1 },
      { item: 3, input: 1 },
    ]);
  });

  it('runs nested loops fully on every outer round', async () => {
    const run = await runWorkflow(
      [
        node('Start', 'core.manualTrigger'),
        node('Outer', 'core.splitInBatches', { batchSize: 1 }, [200, 0]),
        node(
          'Split',
          'core.code',
          { mode: 'runOnceForAllItems', jsCode: 'return [{json:{i:1}},{json:{i:2}}]' },
          [400, 100],
        ),
        node('Inner', 'core.splitInBatches', { batchSize: 1 }, [600, 100]),
        node('InnerBody', 'core.noOp', {}, [800, 200]),
        node('Done', 'core.noOp', {}, [400, -100]),
      ],
      connect(
        ['Start', 'Outer'],
        ['Outer', 'Done', 0],
        ['Outer', 'Split', 1],
        ['Split', 'Inner'],
        ['Inner', 'Outer', 0],
        ['Inner', 'InnerBody', 1],
        ['InnerBody', 'Inner'],
      ),
      items({ o: 1 }, { o: 2 }),
    );
    expect(run.status).toBe('success');
    // two outer rounds x two inner items
    expect(run.runData.InnerBody).toHaveLength(4);
    expect(run.json('Done')).toHaveLength(4);
  });

  it('reset option treats input as a new set each run', async () => {
    const r = await runNode(
      'core.splitInBatches',
      { batchSize: 1, options: { reset: true } },
      items({ a: 1 }, { a: 2 }),
    );
    expect(r.outputs).toEqual([[], [{ a: 1 }]]);
  });
});

describe('Wait', () => {
  it('sleeps in-process for short intervals', async () => {
    const started = Date.now();
    const r = await runNode(
      'core.wait',
      { resume: 'timeInterval', amount: 0.05, unit: 'seconds' },
      items({ a: 1 }),
    );
    expect(r.status).toBe('success');
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(r.outputs).toEqual([[{ a: 1 }]]);
  });

  it('persists long waits and resumes in a new engine', async () => {
    const definition = {
      name: 'wait',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'core.wait', { resume: 'timeInterval', amount: 2, unit: 'hours' }, [200, 0]),
        node(
          'After',
          'core.set',
          { assignments: { assignments: [{ name: 'resumed', value: 'yes', type: 'string' }] } },
          [400, 0],
        ),
      ],
      connections: connect(['Start', 'Wait'], ['Wait', 'After']),
    };
    const first = await new WorkflowExecute(new Workflow(definition, nodeTypes), testServices()).run({
      triggerItems: items({ id: 7 }),
    });
    expect(first.status).toBe('waiting');
    const waitTill = Date.parse(first.state.waitTill!);
    expect(waitTill - Date.now()).toBeGreaterThan(IN_PROCESS_WAIT_LIMIT_MS);
    const persisted = JSON.parse(JSON.stringify(first.state));
    const resumed = await new WorkflowExecute(
      new Workflow(definition, nodeTypes),
      testServices(),
      persisted,
    ).resume();
    expect(resumed.status).toBe('success');
    expect(resumed.state.resultData.runData.After[0].data?.main?.[0]?.[0].json).toEqual({
      id: 7,
      resumed: 'yes',
    });
  });

  it('waits for a webhook call and continues with its data', async () => {
    const definition = {
      name: 'approval',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Wait', 'core.wait', { resume: 'webhook', httpMethod: 'POST' }, [200, 0]),
        node('After', 'core.noOp', {}, [400, 0]),
      ],
      connections: connect(['Start', 'Wait'], ['Wait', 'After']),
    };
    const workflow = new Workflow(definition, nodeTypes);
    const first = await new WorkflowExecute(workflow, testServices()).run();
    expect(first.status).toBe('waiting');
    expect(first.state.waitTill?.startsWith('3000-')).toBe(true);

    // the server calls the node's webhook() with the resume request, then resumes
    const { createWebhookContext } = await import('@workflow/core');
    const waitNode = workflow.nodes.Wait;
    const ctx = createWebhookContext(
      {
        workflow,
        node: waitNode,
        services: testServices(),
        evaluator: new (await import('@workflow/workflow')).ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        query: { a: '1' },
        params: {},
        body: { approved: true },
      },
      'default',
    );
    const response = await nodeTypes.get('core.wait')!.webhook!(ctx);
    expect(response.workflowData?.[0][0].json).toMatchObject({ body: { approved: true }, query: { a: '1' } });

    const resumed = await new WorkflowExecute(
      workflow,
      testServices(),
      JSON.parse(JSON.stringify(first.state)),
    ).resume({
      output: response.workflowData,
    });
    expect(resumed.status).toBe('success');
    expect(resumed.state.resultData.runData.After[0].data?.main?.[0]?.[0].json).toMatchObject({
      body: { approved: true },
    });
  });

  it('uses the time limit for webhook waits and rejects invalid dates', async () => {
    const limited = await runNode('core.wait', {
      resume: 'webhook',
      limitWaitTime: true,
      limitType: 'afterTimeInterval',
      resumeAmount: 1,
      resumeUnit: 'minutes',
    });
    expect(limited.status).toBe('waiting');
    expect(Date.parse(limited.result.state.waitTill!) - Date.now()).toBeLessThanOrEqual(60_000);
    const bad = await runNode('core.wait', { resume: 'specificTime', dateTime: 'tomorrow-ish' });
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/not a valid date/);
  });

  it('is cancelled through the execution signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 50);
    const workflow = new Workflow(
      {
        name: 'cancel',
        nodes: [
          node('Start', 'core.manualTrigger'),
          node('Wait', 'core.wait', { resume: 'timeInterval', amount: 30, unit: 'seconds' }, [200, 0]),
        ],
        connections: connect(['Start', 'Wait']),
      },
      nodeTypes,
    );
    const started = Date.now();
    const result = await new WorkflowExecute(workflow, testServices()).run({ signal: controller.signal });
    expect(result.status).toBe('error');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('Execute Workflow', () => {
  const calls: Array<{ source: unknown; items: Item[]; options?: unknown }> = [];
  const executeSubWorkflow = async (request: { source: unknown; items: Item[]; options?: unknown }) => {
    calls.push(request);
    return {
      executionId: `sub-${calls.length}`,
      data: [request.items.map((item) => ({ json: { ...item.json, processed: true } }))],
    };
  };

  it('runs once with all items and returns the sub-workflow output', async () => {
    calls.length = 0;
    const r = await runNode(
      'core.executeWorkflow',
      { source: 'database', workflowId: { __rl: true, mode: 'id', value: 'wf-42' } },
      items({ a: 1 }, { a: 2 }),
      { services: { executeSubWorkflow } },
    );
    expect(r.outputs).toEqual([
      [
        { a: 1, processed: true },
        { a: 2, processed: true },
      ],
    ]);
    expect(calls[0].source).toEqual({ source: 'database', workflowId: 'wf-42' });
    expect(calls[0].items).toHaveLength(2);
  });

  it('runs once per item, extracts ids from URLs, and can skip waiting', async () => {
    calls.length = 0;
    const r = await runNode(
      'core.executeWorkflow',
      {
        workflowId: { __rl: true, mode: 'url', value: 'https://app.example.com/workflow/abc123' },
        mode: 'each',
        options: { waitForSubWorkflow: false },
      },
      items({ a: 1 }, { a: 2 }),
      { services: { executeSubWorkflow } },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].source).toEqual({ source: 'database', workflowId: 'abc123' });
    expect(calls[0].options).toEqual({ doNotWaitToFinish: true });
    expect(r.outputs).toEqual([[{ a: 1 }, { a: 2 }]]);
  });

  it('accepts an inline workflow definition and validates it', async () => {
    calls.length = 0;
    const ok = await runNode(
      'core.executeWorkflow',
      { source: 'parameter', workflowJson: JSON.stringify({ nodes: [], connections: {} }) },
      items({ a: 1 }),
      { services: { executeSubWorkflow } },
    );
    expect(ok.status).toBe('success');
    expect((calls[0].source as { source: string }).source).toBe('parameter');
    const bad = await runNode(
      'core.executeWorkflow',
      { source: 'parameter', workflowJson: '{"x":1}' },
      items({}),
      {
        services: { executeSubWorkflow },
      },
    );
    expect(bad.status).toBe('error');
    expect(bad.error?.message).toMatch(/nodes/);
  });

  it('fails clearly without sub-workflow support and continues on fail per item', async () => {
    const r = await runNode(
      'core.executeWorkflow',
      { workflowId: { __rl: true, mode: 'id', value: 'x' } },
      items({}),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/not available/);
    const failing = async () => {
      throw new Error('sub failed');
    };
    const c = await runNode(
      'core.executeWorkflow',
      { workflowId: { __rl: true, mode: 'id', value: 'x' }, mode: 'each' },
      items({ a: 1 }, { a: 2 }),
      { services: { executeSubWorkflow: failing }, node: { onError: 'continueRegularOutput' } },
    );
    expect(c.outputs[0]).toEqual([{ error: 'sub failed' }, { error: 'sub failed' }]);
  });
});

describe('Execute Workflow Trigger', () => {
  it('passes data through or applies a typed input schema', async () => {
    const passthrough = await runNode('core.executeWorkflowTrigger', {}, items({ a: 1, b: 'x' }));
    expect(passthrough.outputs).toEqual([[{ a: 1, b: 'x' }]]);
    const typed = await runNode(
      'core.executeWorkflowTrigger',
      {
        inputSource: 'workflowInputs',
        workflowInputs: {
          values: [
            { name: 'id', type: 'number' },
            { name: 'tags', type: 'array' },
            { name: 'missing', type: 'string' },
          ],
        },
      },
      items({ id: '42', tags: '["a"]', extra: true }),
    );
    expect(typed.outputs).toEqual([[{ id: 42, tags: ['a'], missing: null }]]);
  });

  it('fails when a value cannot be converted', async () => {
    const r = await runNode(
      'core.executeWorkflowTrigger',
      { inputSource: 'workflowInputs', workflowInputs: { values: [{ name: 'id', type: 'number' }] } },
      items({ id: 'abc' }),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/expects a number/);
  });
});

describe('Error Trigger and Stop and Error', () => {
  it('passes the error item through, or emits an example in manual runs', async () => {
    const error = {
      execution: { id: 'e9', error: { message: 'boom' } },
      workflow: { id: 'w1', name: 'Orders' },
    };
    const r = await runNode('core.errorTrigger', {}, items(error));
    expect(r.outputs).toEqual([[error]]);
    const example = await runNode('core.errorTrigger', {});
    expect(example.outputs[0][0]).toMatchObject({
      execution: { error: { message: 'Example error message' } },
    });
  });

  it('stops the workflow with a message or an error object', async () => {
    const message = await runNode(
      'core.stopAndError',
      { errorMessage: '={{ "Order " + $json.id + " is invalid" }}' },
      items({ id: 3 }),
    );
    expect(message.status).toBe('error');
    expect(message.error).toMatchObject({ message: 'Order 3 is invalid', code: 'USER_ERROR' });
    const object = await runNode('core.stopAndError', {
      errorType: 'errorObject',
      errorObject: '{"code": 404, "message": "Customer not found", "description": "No match"}',
    });
    expect(object.error).toMatchObject({
      message: 'Customer not found',
      description: 'No match',
      code: 'USER_404',
    });
  });
});
