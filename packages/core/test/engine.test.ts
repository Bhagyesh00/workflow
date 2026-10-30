import type { ConnectionType } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, execute, node } from './helpers';

const json = (r: { state: { resultData: { runData: any } } }, name: string, run = -1, output = 0) => {
  const runs = r.state.resultData.runData[name];
  return runs[run < 0 ? runs.length - 1 : run].data?.main?.[output]?.map((i: any) => i.json);
};

describe('WorkflowExecute', () => {
  it('runs a linear workflow and resolves expressions', async () => {
    const result = await execute({
      name: 'linear',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Set', 'test.set', [200, 0], {
          parameters: { field: 'msg', value: '={{ $vars.greeting + " " + $json.name }}' },
        }),
      ],
      connections: connect(['Trigger', 'Set']),
    }).run({ triggerItems: [{ json: { name: 'Ada' } }, { json: { name: 'Bob' } }] });

    expect(result.status).toBe('success');
    expect(json(result, 'Set')).toEqual([
      { name: 'Ada', msg: 'hello Ada' },
      { name: 'Bob', msg: 'hello Bob' },
    ]);
    expect(Object.isFrozen(result.state.resultData.runData.Set[0].data!.main![0]![0].json)).toBe(true);
  });

  it('never evaluates runtime data as an expression (data is never code)', async () => {
    const payload = '={{ (() => { throw new Error("evaluated!") })() }}';
    const result = await execute({
      name: 'data-not-code',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Set', 'test.set', [200, 0], { parameters: { field: 'copy', value: '={{ $json.text }}' } }),
        node('Set2', 'test.set', [400, 0], {
          parameters: { field: 'copy2', value: '=prefix {{ $json.copy }}' },
        }),
      ],
      connections: connect(['Trigger', 'Set'], ['Set', 'Set2']),
    }).run({ triggerItems: [{ json: { text: payload } }] });
    expect(result.status).toBe('success');
    expect(json(result, 'Set2')).toEqual([{ text: payload, copy: payload, copy2: `prefix ${payload}` }]);
  });

  it('runs branches depth-first ordered by canvas position', async () => {
    const order: string[] = [];
    const result = await execute(
      {
        name: 'branches',
        nodes: [
          node('Trigger', 'test.trigger'),
          node('IF', 'test.if', [200, 0], { parameters: { condition: '={{ $json.v > 1 }}' } }),
          node('Low', 'test.set', [400, 300]),
          node('High', 'test.set', [400, -100]),
          node('AfterHigh', 'test.set', [600, -100]),
        ],
        connections: connect(['Trigger', 'IF'], ['IF', 'High', 0], ['IF', 'Low', 1], ['High', 'AfterHigh']),
      },
      { hooks: { nodeExecuteBefore: (n) => void order.push(n) } },
    ).run({ triggerItems: [{ json: { v: 1 } }, { json: { v: 2 } }] });

    expect(result.status).toBe('success');
    expect(order).toEqual(['Trigger', 'IF', 'High', 'AfterHigh', 'Low']);
    expect(json(result, 'High')).toEqual([{ v: 2, value: '' }]);
    expect(json(result, 'Low')).toEqual([{ v: 1, value: '' }]);
  });

  it('waits for all inputs of a merge node, and runs it with partial data when one branch is empty', async () => {
    const def = (cond: string) => ({
      name: 'merge',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('IF', 'test.if', [200, 0], { parameters: { condition: cond } }),
        node('A', 'test.set', [400, -100], { parameters: { field: 'a', value: '1' } }),
        node('B', 'test.set', [400, 100], { parameters: { field: 'b', value: '2' } }),
        node('Merge', 'test.merge', [600, 0]),
      ],
      connections: connect(
        ['Trigger', 'IF'],
        ['Trigger', 'B'],
        ['IF', 'A', 0],
        ['A', 'Merge', 0, 0],
        ['B', 'Merge', 0, 1],
      ),
    });
    const both = await execute(def('={{ true }}')).run();
    expect(both.state.resultData.runData.Merge).toHaveLength(1);
    expect(json(both, 'Merge')).toEqual([{ a: '1' }, { b: '2' }]);

    const one = await execute(def('={{ false }}')).run();
    expect(one.status).toBe('success');
    expect(one.state.resultData.runData.A).toBeUndefined();
    expect(json(one, 'Merge')).toEqual([{ b: '2' }]);
  });

  it('resolves $("Node").item across branches via paired items', async () => {
    const result = await execute({
      name: 'paired',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('IF', 'test.if', [200, 0], { parameters: { condition: '={{ $json.id !== "a" }}' } }),
        node('Use', 'test.set', [400, 0], {
          parameters: { field: 'orig', value: '={{ $("Trigger").item.json.id }}' },
        }),
      ],
      connections: connect(['Trigger', 'IF'], ['IF', 'Use', 0]),
    }).run({ triggerItems: [{ json: { id: 'a' } }, { json: { id: 'b' } }, { json: { id: 'c' } }] });
    expect(json(result, 'Use')).toEqual([
      { id: 'b', orig: 'b' },
      { id: 'c', orig: 'c' },
    ]);
  });

  it('stops the workflow on error by default', async () => {
    const result = await execute({
      name: 'fail',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Fail', 'test.fail', [200, 0]),
        node('After', 'test.set', [400, 0]),
      ],
      connections: connect(['Trigger', 'Fail'], ['Fail', 'After']),
    }).run();
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toBe('boom 1');
    expect(result.state.resultData.error?.node).toBe('Fail');
    expect(result.state.resultData.runData.After).toBeUndefined();
  });

  it('records no retry metadata for a node that failed without retries', async () => {
    const result = await execute({
      name: 'no-retry',
      nodes: [node('Trigger', 'test.trigger'), node('Fail', 'test.fail', [200, 0])],
      connections: connect(['Trigger', 'Fail']),
    }).run();
    expect(result.state.resultData.runData.Fail[0].metadata).toBeUndefined();
  });

  it('retries a failing node', async () => {
    const result = await execute({
      name: 'retry',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Fail', 'test.fail', [200, 0], {
          parameters: { failTimes: 2 },
          retryOnFail: true,
          maxTries: 3,
          waitBetweenTries: 0,
        }),
      ],
      connections: connect(['Trigger', 'Fail']),
    }).run();
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Fail[0].metadata?.attempt).toBe(3);
  });

  it('continues on error via the regular or the error output', async () => {
    const regular = await execute({
      name: 'continue',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Fail', 'test.fail', [200, 0], { onError: 'continueRegularOutput' }),
        node('After', 'test.set', [400, 0]),
      ],
      connections: connect(['Trigger', 'Fail'], ['Fail', 'After']),
    }).run();
    expect(regular.status).toBe('success');
    expect(json(regular, 'After')).toEqual([{ error: 'boom 1', value: '' }]);

    const errorOutput = await execute({
      name: 'error-output',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Fail', 'test.fail', [200, 0], { onError: 'continueErrorOutput' }),
        node('Ok', 'test.set', [400, -100]),
        node('Handle', 'test.set', [400, 100], { parameters: { field: 'handled', value: '={{ true }}' } }),
      ],
      connections: connect(['Trigger', 'Fail'], ['Fail', 'Ok', 0], ['Fail', 'Handle', 1]),
    }).run({ triggerItems: [{ json: { x: 1 } }] });
    expect(errorOutput.status).toBe('success');
    expect(errorOutput.state.resultData.runData.Ok).toBeUndefined();
    expect(json(errorOutput, 'Handle')).toEqual([{ x: 1, handled: true }]);
  });

  it('uses pinned data and passes data through disabled nodes', async () => {
    const result = await execute({
      name: 'pins',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Fail', 'test.fail', [200, 0], { disabled: true }),
        node('Set', 'test.set', [400, 0], { parameters: { field: 'y', value: '2' } }),
      ],
      connections: connect(['Trigger', 'Fail'], ['Fail', 'Set']),
    }).run({ pinData: { Trigger: [{ json: { pinned: true } }] } });
    expect(result.status).toBe('success');
    expect(json(result, 'Set')).toEqual([{ pinned: true, y: '2' }]);
  });

  it('stops at the destination node in partial executions', async () => {
    const result = await execute({
      name: 'partial',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('A', 'test.set', [200, 0]),
        node('B', 'test.set', [400, 0]),
      ],
      connections: connect(['Trigger', 'A'], ['A', 'B']),
    }).run({ destinationNode: 'A' });
    expect(result.state.resultData.runData.A).toHaveLength(1);
    expect(result.state.resultData.runData.B).toBeUndefined();
  });

  it('pauses on wait and resumes with new data in a fresh engine', async () => {
    const def = {
      name: 'wait',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Wait', 'test.wait', [200, 0]),
        node('After', 'test.set', [400, 0]),
      ],
      connections: connect(['Trigger', 'Wait'], ['Wait', 'After']),
    };
    const first = await execute(def).run({ triggerItems: [{ json: { step: 1 } }] });
    expect(first.status).toBe('waiting');
    expect(first.state.waitTill).toBeTruthy();
    expect(first.state.resultData.runData.After).toBeUndefined();

    const serialized = JSON.parse(JSON.stringify(first.state));
    const { Workflow } = await import('@workflow/workflow');
    const { WorkflowExecute } = await import('../src');
    const { nodeTypes, services } = await import('./helpers');
    const resumed = await new WorkflowExecute(new Workflow(def, nodeTypes), services(), serialized).resume({
      output: [[{ json: { step: 2 } }]],
    });
    expect(resumed.status).toBe('success');
    expect(json(resumed, 'After')).toEqual([{ step: 2, value: '' }]);
  });

  it('loops with per-node context until done', async () => {
    const result = await execute({
      name: 'loop',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Loop', 'test.batches', [200, 0], { parameters: { batchSize: 2 } }),
        node('Body', 'test.set', [400, 100], { parameters: { field: 'seen', value: '={{ true }}' } }),
        node('Done', 'test.set', [400, -100], { parameters: { field: 'final', value: '={{ true }}' } }),
      ],
      connections: connect(['Trigger', 'Loop'], ['Loop', 'Done', 0], ['Loop', 'Body', 1], ['Body', 'Loop']),
    }).run({ triggerItems: [1, 2, 3, 4, 5].map((n) => ({ json: { n } })) });
    expect(result.status).toBe('success');
    expect(result.state.resultData.runData.Body).toHaveLength(3);
    expect(json(result, 'Done')).toHaveLength(5);
    expect(json(result, 'Done')[0]).toEqual({ n: 1, seen: true, final: true });
  });

  it('supplies AI sub-nodes to root nodes and logs their runs', async () => {
    const result = await execute({
      name: 'ai',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Agent', 'test.agent', [200, 0]),
        node('Model', 'test.model', [200, 200], { parameters: { reply: '={{ "echo:" + $json.q }}' } }),
      ],
      connections: {
        ...connect(['Trigger', 'Agent']),
        Model: {
          ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel' as ConnectionType, index: 0 }]],
        },
      },
    }).run({ triggerItems: [{ json: { q: 'hi' } }] });
    expect(result.status).toBe('success');
    expect(json(result, 'Agent')).toEqual([{ output: 'echo:hi' }]);
    expect(result.state.resultData.runData.Model).toHaveLength(1);
  });

  it('fails clearly when a required AI sub-node is missing', async () => {
    const result = await execute({
      name: 'ai-missing',
      nodes: [node('Trigger', 'test.trigger'), node('Agent', 'test.agent', [200, 0])],
      connections: connect(['Trigger', 'Agent']),
    }).run();
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toMatch(/sub-node must be connected/);
  });

  it('cancels a running execution', async () => {
    const engine = execute({
      name: 'cancel',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Code', 'test.code', [200, 0], {
          parameters: { code: 'const end = Date.now() + 1500; while (Date.now() < end) {} return []' },
        }),
      ],
      connections: connect(['Trigger', 'Code']),
    });
    const promise = engine.run();
    setTimeout(() => engine.cancel('user'), 100);
    const result = await promise;
    expect(result.status).toBe('canceled');
  });

  it('enforces the execution timeout', async () => {
    const result = await execute({
      name: 'timeout',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Code', 'test.code', [200, 0], {
          parameters: { code: 'const end = Date.now() + 1500; while (Date.now() < end) {} return []' },
        }),
      ],
      connections: connect(['Trigger', 'Code']),
    }).run({ timeoutMs: 200 });
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.name).toBe('ExecutionTimeoutError');
  });
});
