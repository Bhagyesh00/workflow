import type { Item } from '@workflow/workflow';
import { describe, expect, it } from 'vitest';
import { connect, node, runNode, runWorkflow } from './harness';

const items = (...list: object[]): Item[] => list.map((json) => ({ json: json as Item['json'] }));
const trigger = items({ name: 'A' }, { name: 'B' }, { name: 'C' });

/** Trigger -> Sort(desc) -> <middle> -> Set(fromTrigger = $('Trigger').item.json.name) */
async function throughSort(middle: ReturnType<typeof node>) {
  const run = await runWorkflow(
    [
      node('Trigger', 'core.manualTrigger'),
      node(
        'Sort',
        'core.sort',
        { sortFieldsUi: { sortField: [{ fieldName: 'name', order: 'descending' }] } },
        [200, 0],
      ),
      middle,
      node(
        'Read',
        'core.set',
        {
          assignments: {
            assignments: [
              { id: '1', name: 'fromTrigger', value: "={{ $('Trigger').item.json.name }}", type: 'string' },
            ],
          },
          includeOtherFields: true,
        },
        [600, 0],
      ),
    ],
    connect(['Trigger', 'Sort'], ['Sort', middle.name], [middle.name, 'Read']),
    trigger,
  );
  expect(run.status).toBe('success');
  return run.json('Read').map((j) => [j.name, j.fromTrigger]);
}

const expected = [
  ['C', 'C'],
  ['B', 'B'],
  ['A', 'A'],
];

describe('R08 pass-through nodes re-pair to their own input', () => {
  it('No Op', async () => {
    expect(await throughSort(node('Mid', 'core.noOp', {}, [400, 0]))).toEqual(expected);
  });

  it('Wait (in-process)', async () => {
    const mid = node('Mid', 'core.wait', { resume: 'timeInterval', amount: 0, unit: 'seconds' }, [400, 0]);
    expect(await throughSort(mid)).toEqual(expected);
  });

  it('Respond to Webhook', async () => {
    const mid = node('Mid', 'core.respondToWebhook', { respondWith: 'text', responseText: 'ok' }, [400, 0]);
    expect(await throughSort(mid)).toEqual(expected);
  });

  it('Code returning $input.all()', async () => {
    const mid = node(
      'Mid',
      'core.code',
      { mode: 'runOnceForAllItems', jsCode: 'return $input.all();' },
      [400, 0],
    );
    expect(await throughSort(mid)).toEqual(expected);
  });

  it('Code returning a filtered $input.all()', async () => {
    const mid = node(
      'Mid',
      'core.code',
      { mode: 'runOnceForAllItems', jsCode: "return $input.all().filter((i) => i.json.name !== 'B');" },
      [400, 0],
    );
    expect(await throughSort(mid)).toEqual([
      ['C', 'C'],
      ['A', 'A'],
    ]);
  });

  it('Wait that persists the execution keeps own-input pairing', async () => {
    const upstream = items({ n: 1 }, { n: 2 }).map((item, i) => ({ ...item, pairedItem: { item: 1 - i } }));
    const r = await runNode('core.wait', { resume: 'timeInterval', amount: 2, unit: 'hours' }, upstream);
    expect(r.items[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });
});
