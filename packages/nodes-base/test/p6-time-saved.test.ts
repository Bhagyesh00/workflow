import { describe, expect, it } from 'vitest';
import { runNode } from './harness';

const metaOf = (r: Awaited<ReturnType<typeof runNode>>) =>
  r.result.state.resultData.runData.Node?.[0]?.metadata as { timeSaved?: { minutes: number } } | undefined;

describe('Track Time Saved node (P6-56)', () => {
  it('once counts the minutes once whatever the item count, and passes items through', async () => {
    const input = [{ json: { a: 1 } }, { json: { a: 2 } }, { json: { a: 3 } }];
    const r = await runNode('core.timeSaved', { mode: 'once', minutesSaved: 5 }, input);
    expect(r.status).toBe('success');
    expect(metaOf(r)).toEqual({ timeSaved: { minutes: 5 } });
    expect(r.outputs[0]).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('per item multiplies by the input items', async () => {
    const input = [{ json: {} }, { json: {} }, { json: {} }];
    const r = await runNode('core.timeSaved', { mode: 'perItem', minutesSaved: 4 }, input);
    expect(metaOf(r)).toEqual({ timeSaved: { minutes: 12 } });
    expect(r.outputs[0]).toHaveLength(3);
  });

  it('per item reads the expression for each item', async () => {
    const input = [{ json: { m: 1 } }, { json: { m: 2 } }, { json: { m: 7 } }];
    const r = await runNode('core.timeSaved', { mode: 'perItem', minutesSaved: '={{ $json.m }}' }, input);
    expect(metaOf(r)).toEqual({ timeSaved: { minutes: 10 } });
  });

  it('zero is allowed', async () => {
    const r = await runNode('core.timeSaved', { mode: 'once', minutesSaved: 0 });
    expect(r.status).toBe('success');
    expect(metaOf(r)).toEqual({ timeSaved: { minutes: 0 } });
  });

  it('a negative number throws and names the value', async () => {
    const r = await runNode('core.timeSaved', { mode: 'once', minutesSaved: -3 });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Time saved cannot be negative, got: -3');
  });

  it('a negative per-item value throws', async () => {
    const input = [{ json: { m: 2 } }, { json: { m: -1 } }];
    const r = await runNode('core.timeSaved', { mode: 'perItem', minutesSaved: '={{ $json.m }}' }, input);
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Time saved cannot be negative, got: -1');
  });

  it('a value that is not a number throws', async () => {
    const r = await runNode('core.timeSaved', { mode: 'once', minutesSaved: 'abc' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/must be a number/);
  });
});
