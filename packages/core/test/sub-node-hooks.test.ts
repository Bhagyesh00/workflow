import type { ConnectionType, Logger } from '@workflow/workflow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connect, execute, node } from './helpers';

const aiWorkflow = {
  name: 'ai-hooks',
  nodes: [
    node('Trigger', 'test.trigger'),
    node('Agent', 'test.agent', [200, 0]),
    node('Model', 'test.model', [200, 200], { parameters: { reply: 'ok' } }),
  ],
  connections: {
    ...connect(['Trigger', 'Agent']),
    Model: {
      ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel' as ConnectionType, index: 0 }]],
    },
  },
};

describe('R01 sub-node progress hooks', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('survives a failing nodeExecuteAfter for a sub-node and logs it', async () => {
    const warnings: string[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (message) => void warnings.push(message),
      error() {},
    };
    const result = await execute(aiWorkflow, {
      logger,
      hooks: {
        nodeExecuteAfter: async (name) => {
          if (name === 'Model') throw new Error('saveState failed');
        },
      },
    }).run({ triggerItems: [{ json: {} }] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.status).toBe('success');
    expect(unhandled).toEqual([]);
    expect(warnings.some((w) => /nodeExecuteAfter/.test(w))).toBe(true);
  });

  it('finishes the sub-node hook before the parent node and the run complete', async () => {
    const events: string[] = [];
    const result = await execute(aiWorkflow, {
      hooks: {
        nodeExecuteAfter: async (name) => {
          if (name === 'Model') await new Promise((resolve) => setTimeout(resolve, 30));
          events.push(`after:${name}`);
        },
      },
    }).run({ triggerItems: [{ json: {} }] });
    expect(result.status).toBe('success');
    expect(events.indexOf('after:Model')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('after:Model')).toBeLessThan(events.indexOf('after:Agent'));
  });
});

describe('R08 engine pass-through pairing', () => {
  async function lookups(extra: { disabled?: boolean; codeBody?: string }) {
    const middle = extra.codeBody
      ? node('Mid', 'test.code', [400, 0], { parameters: { code: extra.codeBody } })
      : node('Mid', 'test.set', [400, 0], { disabled: extra.disabled });
    const result = await execute({
      name: 'pairing',
      nodes: [
        node('Trigger', 'test.trigger'),
        node('Reverse', 'test.code', [200, 0], {
          parameters: {
            code: 'return $input.all().reverse().map((i) => ({ json: i.json, pairedItem: i.pairedItem }));',
          },
        }),
        middle,
        node('Read', 'test.set', [600, 0], {
          parameters: { field: 'fromTrigger', value: "={{ $('Trigger').item.json.name }}" },
        }),
      ],
      connections: connect(['Trigger', 'Reverse'], ['Reverse', 'Mid'], ['Mid', 'Read']),
    }).run({ triggerItems: [{ json: { name: 'A' } }, { json: { name: 'B' } }, { json: { name: 'C' } }] });
    expect(result.status).toBe('success');
    return result.state.resultData.runData.Read[0].data!.main![0]!;
  }

  it('keeps $(trigger).item correct through a disabled node that reorders upstream pairing', async () => {
    const out = await lookups({ disabled: true });
    expect(out.map((i) => [i.json.name, i.json.fromTrigger])).toEqual([
      ['C', 'C'],
      ['B', 'B'],
      ['A', 'A'],
    ]);
  });

  it('keeps $(trigger).item correct when a Code node returns $input.all()', async () => {
    const out = await lookups({ codeBody: 'return $input.all();' });
    expect(out.map((i) => [i.json.name, i.json.fromTrigger])).toEqual([
      ['C', 'C'],
      ['B', 'B'],
      ['A', 'A'],
    ]);
  });
});
