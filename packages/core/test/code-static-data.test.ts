import { describe, expect, it, vi } from 'vitest';
import { CodeExecutionError, type CodeRunnerInput, IsolatedVmCodeRunner } from '../src';

const runner = new IsolatedVmCodeRunner({ timeoutMs: 3000, memoryLimitMb: 64 });
const base = {
  items: [{ json: { a: 1 } }, { json: { a: 2 } }],
  nodeOutputs: {},
  variables: {},
  workflow: { id: 'w', name: 'W', active: true },
  execution: { id: 'e', mode: 'production' },
  nodeName: 'Code',
  timezone: 'UTC',
};

type Data = { global: Record<string, unknown>; node: Record<string, unknown> };

function run(
  mode: CodeRunnerInput['mode'],
  code: string,
  staticData: Data = { global: {}, node: {} },
  onStaticData?: (d: Data) => void,
) {
  return runner.run({ ...base, mode, code, staticData, onStaticData });
}

describe('$getWorkflowStaticData in the Code node', () => {
  it('counts in the global and the node scope (run once for all items)', async () => {
    const onStaticData = vi.fn();
    const out = await run(
      'runOnceForAllItems',
      `const g = $getWorkflowStaticData('global'); const n = $getWorkflowStaticData('node');
       g.count = (g.count ?? 0) + 1; n.seen = (n.seen ?? 0) + 10;
       return [{ json: { g: g.count, n: n.seen } }];`,
      { global: { count: 4 }, node: { seen: 20 } },
      onStaticData,
    );
    expect(out[0]!.json).toEqual({ g: 5, n: 30 });
    expect(onStaticData).toHaveBeenCalledTimes(1);
    expect(onStaticData).toHaveBeenCalledWith({ global: { count: 5 }, node: { seen: 30 } });
  });

  it('counts across the items (run once for each item)', async () => {
    const onStaticData = vi.fn();
    const out = await run(
      'runOnceForEachItem',
      `const g = $getWorkflowStaticData('global'); g.count = (g.count ?? 0) + 1; return { n: g.count };`,
      { global: {}, node: {} },
      onStaticData,
    );
    expect(out.map((i) => i.json)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(onStaticData).toHaveBeenCalledWith({ global: { count: 2 }, node: {} });
  });

  it('does not call onStaticData when the data is unchanged', async () => {
    const onStaticData = vi.fn();
    await run(
      'runOnceForAllItems',
      `const g = $getWorkflowStaticData('global'); g.count = g.count; return [{ json: { c: g.count } }];`,
      { global: { count: 1 }, node: {} },
      onStaticData,
    );
    await run('runOnceForAllItems', `return [{ json: {} }]`, { global: {}, node: {} }, onStaticData);
    expect(onStaticData).not.toHaveBeenCalled();
  });

  it('throws for a scope other than global or node', async () => {
    await expect(
      run('runOnceForAllItems', `$getWorkflowStaticData('workflow'); return [{ json: {} }]`),
    ).rejects.toThrow(/global|node/);
    await expect(
      run('runOnceForAllItems', `$getWorkflowStaticData(); return [{ json: {} }]`),
    ).rejects.toThrow(/global|node/);
  });

  it('keeps the host data when the code throws', async () => {
    const onStaticData = vi.fn();
    const data = { global: { count: 1 }, node: {} };
    await expect(
      run(
        'runOnceForAllItems',
        `$getWorkflowStaticData('global').count = 99; throw new Error('boom');`,
        data,
        onStaticData,
      ),
    ).rejects.toThrow('boom');
    expect(onStaticData).not.toHaveBeenCalled();
    expect(data.global.count).toBe(1);
  });

  it('keeps the host data when the code returns an invalid result', async () => {
    const onStaticData = vi.fn();
    const data = { global: { count: 1 }, node: {} };
    await expect(
      run(
        'runOnceForAllItems',
        `$getWorkflowStaticData('global').count = 99; return 'not items';`,
        data,
        onStaticData,
      ),
    ).rejects.toBeInstanceOf(CodeExecutionError);
    await expect(
      run(
        'runOnceForEachItem',
        `$getWorkflowStaticData('global').count = 99; return [1, 2];`,
        data,
        onStaticData,
      ),
    ).rejects.toBeInstanceOf(CodeExecutionError);
    expect(onStaticData).not.toHaveBeenCalled();
    expect(data.global.count).toBe(1);
  });

  it('does not let the code change the host copy before the run ends', async () => {
    const data = { global: { list: [1] }, node: {} };
    await run(
      'runOnceForAllItems',
      `$getWorkflowStaticData('global').list.push(2); return [{ json: {} }]`,
      data,
    );
    expect(data.global.list).toEqual([1]);
  });

  it('refuses static data over 1 MB and keeps the host data', async () => {
    const onStaticData = vi.fn();
    const err = await run(
      'runOnceForAllItems',
      `$getWorkflowStaticData('global').big = 'x'.repeat(1024 * 1024 + 10); return [{ json: {} }]`,
      { global: {}, node: {} },
      onStaticData,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CodeExecutionError);
    expect(String(err.message)).toMatch(/1 ?MB/i);
    expect(onStaticData).not.toHaveBeenCalled();
  });

  it('works without static data in the input', async () => {
    const out = await runner.run({
      ...base,
      mode: 'runOnceForAllItems',
      code: `const g = $getWorkflowStaticData('global'); g.a = 1; return [{ json: { g } }]`,
    });
    expect(out[0]!.json).toEqual({ g: { a: 1 } });
  });
});
