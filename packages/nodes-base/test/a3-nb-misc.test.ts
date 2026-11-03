import { createTriggerContext } from '@workflow/core';
import { type DataObject, ExpressionEvaluator, type Item, Workflow } from '@workflow/workflow';
import { DateTime } from 'luxon';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateCondition } from '../src';
import { node, nodeTypes, runNode, testServices } from './harness';
import { json, localHttp, startHttpServer } from './servers';

const items = (...list: object[]): Item[] => list.map((j) => ({ json: j as DataObject }));

function deepFreeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
}

describe('R33 HTTP Request pagination sends the pagination parameters on the first request', () => {
  const total = 250;
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  beforeAll(async () => {
    server = await startHttpServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const page = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, k) => ({
        id: offset + k,
      }));
      return json(res, page);
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('evaluates limit and offset for page 0 so no records are skipped', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/offset`,
        options: {
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: {
                parameters: [
                  { type: 'qs', name: 'limit', value: '100' },
                  { type: 'qs', name: 'offset', value: '={{ $pageCount * 100 }}' },
                ],
              },
              paginationCompleteWhen: 'responseIsEmpty',
            },
          },
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.status).toBe('success');
    expect(server.requests.map((q) => q.url)).toEqual([
      '/offset?limit=100&offset=0',
      '/offset?limit=100&offset=100',
      '/offset?limit=100&offset=200',
      '/offset?limit=100&offset=300',
    ]);
    expect(new Set(r.outputs[0].map((o) => o.id)).size).toBe(total);
  });
});

describe('R33 cursor pagination still starts with a bare first request', () => {
  let server: Awaited<ReturnType<typeof startHttpServer>>;

  beforeAll(async () => {
    server = await startHttpServer((req, res) => {
      const cursor = new URL(req.url, 'http://x').searchParams.get('cursor');
      if (!cursor) return json(res, { data: [{ id: 1 }], next: 'b' });
      return json(res, { data: [{ id: 2 }], next: null });
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('leaves out a parameter that needs the response on page 0', async () => {
    const r = await runNode(
      'core.httpRequest',
      {
        url: `${server.url}/c`,
        options: {
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: {
                parameters: [
                  { type: 'qs', name: 'cursor', value: '={{ $response.body.next }}' },
                  { type: 'headers', name: 'X-Cursor', value: '={{ $response.body.next }}' },
                ],
              },
              paginationCompleteWhen: 'other',
              completeExpression: '={{ !$response.body.next }}',
            },
          },
        },
      },
      items({}),
      { services: { http: localHttp() } },
    );
    expect(r.error?.message).toBeUndefined();
    expect(server.requests.map((q) => q.url)).toEqual(['/c', '/c?cursor=b']);
    expect(server.requests[0].headers['x-cursor']).toBeUndefined();
    expect(server.requests[1].headers['x-cursor']).toBe('b');
  });
});

describe('R34 Schedule Trigger honours Weeks Between Triggers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function weekly(weeksInterval: number) {
    const wfNode = node('Schedule', 'core.scheduleTrigger', {
      rule: { interval: [{ field: 'weeks', weeksInterval, triggerAtDay: [1], triggerAtHour: 9 }] },
    });
    const workflow = new Workflow(
      { name: 's', nodes: [wfNode], connections: {}, settings: { timezone: 'Europe/Berlin' } },
      nodeTypes,
    );
    const emitted: Item[][][] = [];
    const ticks: Array<() => void> = [];
    const ctx = createTriggerContext(
      {
        workflow,
        node: wfNode,
        services: testServices({}, { mode: 'trigger' }),
        evaluator: new ExpressionEvaluator(),
        signal: new AbortController().signal,
      },
      { emit: (data) => void emitted.push(data), emitError: () => undefined, activationMode: 'activate' },
    );
    const spied = {
      ...ctx,
      registerCron: (_expression: string, onTick: (slot: Date) => void) => {
        ticks.push(() => onTick(new Date()));
        return () => undefined;
      },
    };
    return { spied, emitted, ticks };
  }

  const mondays = ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'];

  async function firedDays(weeksInterval: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { spied, emitted, ticks } = weekly(weeksInterval);
    await nodeTypes.get('core.scheduleTrigger')!.trigger!(spied);
    const fired: string[] = [];
    for (const day of mondays) {
      vi.setSystemTime(DateTime.fromISO(`${day}T09:00:00`, { zone: 'Europe/Berlin' }).toMillis());
      const before = emitted.length;
      ticks[0]();
      if (emitted.length > before) fired.push(day);
    }
    return fired;
  }

  it('runs only every second Monday when the interval is 2', async () => {
    expect(await firedDays(2)).toEqual(['2026-10-26', '2026-11-09']);
  });

  it('keeps the same weeks after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fireOnFreshTrigger = async (day: string) => {
      const { spied, emitted, ticks } = weekly(2);
      await nodeTypes.get('core.scheduleTrigger')!.trigger!(spied);
      vi.setSystemTime(DateTime.fromISO(`${day}T09:00:00`, { zone: 'Europe/Berlin' }).toMillis());
      ticks[0]();
      return emitted.length === 1;
    };
    expect(await fireOnFreshTrigger('2026-10-26')).toBe(true);
    expect(await fireOnFreshTrigger('2026-11-02')).toBe(false);
    expect(await fireOnFreshTrigger('2026-11-09')).toBe(true);
  });

  it('runs every Monday when the interval is 1', async () => {
    expect(await firedDays(1)).toEqual(mondays);
  });
});

describe('R37 Edit Fields writes into an object taken from input data', () => {
  it('copies assigned objects so a later dotted assignment can extend them', async () => {
    const input = items({ customer: { name: 'Ada' } });
    deepFreeze(input);
    const r = await runNode(
      'core.set',
      {
        includeOtherFields: false,
        assignments: {
          assignments: [
            { name: 'customer', value: '={{ $json.customer }}', type: 'object' },
            { name: 'customer.tier', value: 'gold', type: 'string' },
          ],
        },
      },
      input,
    );
    expect(r.error?.message).toBeUndefined();
    expect(r.outputs[0]).toEqual([{ customer: { name: 'Ada', tier: 'gold' } }]);
    expect(input[0].json).toEqual({ customer: { name: 'Ada' } });
  });

  it('keeps a luxon date assigned without a type as a date', async () => {
    const r = await runNode(
      'core.set',
      { includeOtherFields: false, assignments: { assignments: [{ name: 'when', value: '={{ $now }}' }] } },
      items({}),
    );
    expect(r.error?.message).toBeUndefined();
    const when = JSON.parse(JSON.stringify(r.outputs[0]))[0].when;
    expect(typeof when).toBe('string');
    expect(Number.isNaN(Date.parse(when))).toBe(false);
  });
});

describe('R38 date comparisons read offset-less dates in the workflow timezone', () => {
  const cond = (operation: string, left: unknown, right: unknown) =>
    ({ operator: { type: 'dateTime', operation }, leftValue: left, rightValue: right }) as never;
  const base = { caseSensitive: true, typeValidation: 'strict' as const };
  const berlin = { ...base, zone: 'Europe/Berlin' };

  it('treats a date-only string as midnight in the configured zone', () => {
    const today = DateTime.fromISO('2026-10-30T00:00:00', { zone: 'Europe/Berlin' });
    expect(evaluateCondition(cond('equals', '2026-10-30', today), berlin)).toBe(true);
    expect(evaluateCondition(cond('before', '2026-10-30', today), berlin)).toBe(false);
  });

  it('keeps UTC when no zone is given and respects explicit offsets', () => {
    const today = DateTime.fromISO('2026-10-30T00:00:00', { zone: 'Europe/Berlin' });
    expect(evaluateCondition(cond('equals', '2026-10-30', today), base)).toBe(false);
    expect(
      evaluateCondition(cond('equals', '2026-10-30T00:00:00+01:00', today), {
        ...base,
        zone: 'America/New_York',
      }),
    ).toBe(true);
  });
});
