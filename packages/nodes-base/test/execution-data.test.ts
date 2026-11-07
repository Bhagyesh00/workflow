import { highlightedInputKey } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { runNode } from './harness';

const rows = (...list: Array<[string, unknown]>) => ({
  values: list.map(([key, value]) => ({ key, value })),
});

describe('Execution Data (P5-61)', () => {
  it('saves the keys on the execution and passes the items through', async () => {
    const r = await runNode(
      'core.executionData',
      { operation: 'save', dataToSave: rows(['orderId', '1042'], ['channel', 'web']) },
      [{ json: { a: 1 } }, { json: { a: 2 } }],
    );
    expect(r.status).toBe('success');
    expect(r.result.state.resultData.customData).toEqual({ orderId: '1042', channel: 'web' });
    expect(r.outputs[0]).toEqual([{ a: 1 }, { a: 2 }]);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('runs the values once per item, so an expression can differ per item', async () => {
    const r = await runNode(
      'core.executionData',
      { operation: 'save', dataToSave: rows(['last', '={{ $json.n }}']) },
      [{ json: { n: 1 } }, { json: { n: 7 } }],
    );
    expect(r.result.state.resultData.customData).toEqual({ last: '7' });
  });

  it('uses the same key names the Chat Trigger writes', async () => {
    const key = highlightedInputKey('Chat Trigger');
    const r = await runNode('core.executionData', { operation: 'save', dataToSave: rows([key, 'hi']) });
    expect(r.result.state.resultData.customData).toEqual({ [key]: 'hi' });
  });

  it('cuts long keys and values and skips empty keys', async () => {
    const r = await runNode('core.executionData', {
      operation: 'save',
      dataToSave: rows(['k'.repeat(60), 'v'.repeat(300)], ['', 'x']),
    });
    const data = r.result.state.resultData.customData!;
    expect(Object.keys(data)).toEqual(['k'.repeat(50)]);
    expect(data['k'.repeat(50)]).toHaveLength(255);
  });

  it('gives a hint, not a failure, past ten keys', async () => {
    const list = Array.from({ length: 12 }, (_, n) => [`key${n}`, String(n)] as [string, unknown]);
    const r = await runNode('core.executionData', { operation: 'save', dataToSave: rows(...list) });
    expect(r.status).toBe('success');
    expect(Object.keys(r.result.state.resultData.customData!)).toHaveLength(10);
    const hints = r.result.state.resultData.runData.Node[0].hints ?? [];
    expect(hints.map((h) => h.message).join('\n')).toMatch(/key10.*at most 10 keys/s);
    expect(r.outputs[0]).toHaveLength(1);
  });
});
