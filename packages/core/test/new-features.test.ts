import { Workflow } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { HttpError, retryDelay, WorkflowExecute } from '../src';
import { connect, execute, node, nodeTypes, services } from './helpers';

describe('NF-01 retry from the failed node', () => {
  it('re-runs only the failed node and its successors, reusing upstream output', async () => {
    const order: string[] = [];
    const def = {
      name: 'resume',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Before', 'test.set', [200, 0], { parameters: { field: 'before', value: '={{ 1 }}' } }),
        node('Fail', 'test.fail', [400, 0], { parameters: { failTimes: 1 } }),
        node('After', 'test.set', [600, 0], { parameters: { field: 'after', value: '={{ 2 }}' } }),
      ],
      connections: connect(['Trigger', 'Before'], ['Before', 'Fail'], ['Fail', 'After']),
      staticData: {},
    };
    const first = await execute(def).run({ triggerItems: [{ json: { id: 1 } }] });
    expect(first.status).toBe('error');
    expect(first.state.executionData.failedExecuteData?.node).toBe('Fail');

    // new process: rebuild the engine from persisted JSON state (static data keeps the fail counter)
    const persisted = JSON.parse(JSON.stringify(first.state));
    const engine = new WorkflowExecute(
      new Workflow({ ...def, staticData: { 'node:Fail': { calls: 1 } } }, nodeTypes),
      services({ hooks: { nodeExecuteBefore: (n) => void order.push(n) } }),
      persisted,
    );
    const retried = await engine.retryFromFailure();
    expect(retried.status).toBe('success');
    expect(order).toEqual(['Fail', 'After']);
    const after = retried.state.resultData.runData.After[0].data!.main![0]!.map((i) => i.json);
    expect(after).toEqual([{ id: 1, before: 1, after: 2 }]);
    expect(retried.state.resultData.runData.Fail.map((r) => r.executionStatus)).toEqual(['error', 'success']);
    expect(retried.state.resultData.error).toBeUndefined();
  });

  it('refuses to retry when nothing failed', async () => {
    const ok = await execute({ name: 'ok', nodes: [node('Trigger', 'test.trigger')], connections: {} }).run();
    const engine = new WorkflowExecute(
      new Workflow({ name: 'ok', nodes: [node('Trigger', 'test.trigger')], connections: {} }, nodeTypes),
      services(),
      ok.state,
    );
    await expect(engine.retryFromFailure()).rejects.toThrow(/no failed node/);
  });
});

describe('NF-02 retry backoff', () => {
  it('grows exponentially with jitter, honours Retry-After, and caps waits', () => {
    const n = node('X', 'test.fail', [0, 0], { waitBetweenTries: 1000, retryBackoff: 'exponential' });
    const d1 = retryDelay(n, 1, new Error('x'));
    const d3 = retryDelay(n, 3, new Error('x'));
    expect(d1).toBeGreaterThanOrEqual(800);
    expect(d1).toBeLessThanOrEqual(1200);
    expect(d3).toBeGreaterThanOrEqual(3200);
    expect(d3).toBeLessThanOrEqual(4800);
    const fixed = node('Y', 'test.fail', [0, 0], { waitBetweenTries: 500 });
    expect(retryDelay(fixed, 4, new Error('x'))).toBe(500);
    const rateLimited = new HttpError('429', 429, 'Too Many Requests', {}, { 'retry-after': '7' });
    expect(retryDelay(fixed, 1, { retryAfterMs: rateLimited.retryAfterMs })).toBe(7000);
    expect(retryDelay(fixed, 1, { retryAfterMs: 10 * 60_000 })).toBe(60_000);
  });
});

describe('NF-20 per-execution quotas', () => {
  it('fails the execution cleanly when a node output is too large', async () => {
    const result = await execute(
      { name: 'quota', nodes: [node('Trigger', 'test.trigger')], connections: {} },
      { limits: { maxItemsPerOutput: 2 } },
    ).run({ triggerItems: [{ json: {} }, { json: {} }, { json: {} }] });
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.code).toBe('QUOTA_EXCEEDED');
  });

  it('stops runaway loops with a configurable node-run cap', async () => {
    const result = await execute(
      {
        name: 'loop',
        nodes: [
          node('Trigger', 'test.trigger'),
          node('A', 'test.set', [200, 0]),
          node('B', 'test.set', [400, 0]),
        ],
        connections: connect(['Trigger', 'A'], ['A', 'B'], ['B', 'A']),
      },
      { limits: { maxNodeRuns: 50 } },
    ).run();
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.code).toBe('QUOTA_EXCEEDED');
  });
});

describe('NF-05 credential slots resolved per item', () => {
  it('resolves an expression credential id from item data', async () => {
    const seen: string[] = [];
    const result = await execute(
      {
        name: 'slots',
        nodes: [
          node('Trigger', 'test.trigger'),
          node('Use', 'test.credUser', [200, 0], {
            credentials: { apiKey: { id: '={{ $json.customer + "-cred" }}', name: 'per customer' } },
          }),
        ],
        connections: connect(['Trigger', 'Use']),
      },
      {
        credentials: {
          get: async (ref) => {
            seen.push(ref.id!);
            return { key: `key-of-${ref.id}` };
          },
          update: async () => {},
        },
      },
    ).run({ triggerItems: [{ json: { customer: 'acme' } }, { json: { customer: 'globex' } }] });
    expect(result.status).toBe('success');
    expect(seen).toEqual(['acme-cred', 'globex-cred']);
    expect(result.state.resultData.runData.Use[0].data!.main![0]!.map((i) => i.json.key)).toEqual([
      'key-of-acme-cred',
      'key-of-globex-cred',
    ]);
  });

  it('reports an expression that does not produce an id', async () => {
    const result = await execute({
      name: 'slots-bad',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Use', 'test.credUser', [200, 0], {
          credentials: { apiKey: { id: '={{ $json.missing }}', name: 'x' } },
        }),
      ],
      connections: connect(['Trigger', 'Use']),
    }).run();
    expect(result.status).toBe('error');
    expect(result.state.resultData.error?.message).toMatch(/did not resolve to a credential id/);
  });
});
