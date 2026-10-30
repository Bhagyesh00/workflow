import { describe, expect, it } from 'vitest';
import { ruleToCron } from '../src';
import { runNode } from './harness';

describe('core nodes', () => {
  it('Edit Fields sets typed and nested fields', async () => {
    const r = await runNode(
      'core.set',
      {
        mode: 'manual',
        assignments: {
          assignments: [
            { name: 'total', value: '={{ $json.a + 1 }}', type: 'number' },
            { name: 'user.name', value: 'Ada', type: 'string' },
            { name: 'flag', value: 'true', type: 'boolean' },
          ],
        },
      },
      [{ json: { a: 1 } }],
    );
    expect(r.status).toBe('success');
    expect(r.outputs[0]).toEqual([{ a: 1, total: 2, user: { name: 'Ada' }, flag: true }]);
  });

  it('Edit Fields raw JSON without other fields', async () => {
    const r = await runNode(
      'core.set',
      { mode: 'raw', jsonOutput: '={{ JSON.stringify({ x: $json.a * 10 }) }}', includeOtherFields: false },
      [{ json: { a: 2 } }],
    );
    expect(r.outputs[0]).toEqual([{ x: 20 }]);
  });

  it('Edit Fields reports conversion errors', async () => {
    const r = await runNode('core.set', {
      assignments: { assignments: [{ name: 'n', value: 'abc', type: 'number' }] },
    });
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/expects a number/);
  });

  it('Code node runs in the sandbox', async () => {
    const r = await runNode(
      'core.code',
      { mode: 'runOnceForEachItem', jsCode: 'return { ...$json, doubled: $json.v * 2 }' },
      [{ json: { v: 2 } }, { json: { v: 5 } }],
    );
    expect(r.outputs[0]).toEqual([
      { v: 2, doubled: 4 },
      { v: 5, doubled: 10 },
    ]);
  });

  it('Code node errors carry the message', async () => {
    const r = await runNode('core.code', { mode: 'runOnceForAllItems', jsCode: 'throw new Error("nope")' });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('nope');
  });

  it('Respond to Webhook sends a response through hooks', async () => {
    const responses: unknown[] = [];
    const r = await runNode(
      'core.respondToWebhook',
      {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: $json.id }) }}',
        options: { responseCode: 201 },
      },
      [{ json: { id: 7 } }],
      {
        services: { hooks: { sendResponse: (res) => void responses.push(res) } },
      },
    );
    expect(r.status).toBe('success');
    expect(responses).toEqual([{ statusCode: 201, headers: {}, body: { ok: 7 } }]);
  });

  it('Schedule rules become cron expressions', () => {
    expect(ruleToCron({ field: 'minutes', minutesInterval: 15 })).toBe('0 */15 * * * *');
    expect(ruleToCron({ field: 'days', triggerAtHour: 9, triggerAtMinute: 30 })).toBe('0 30 9 */1 * *');
    expect(ruleToCron({ field: 'weeks', triggerAtDay: [1, 5], triggerAtHour: 8 })).toBe('0 0 8 * * 1,5');
    expect(ruleToCron({ field: 'cronExpression', expression: '0 0 * * * *' })).toBe('0 0 * * * *');
  });
});
