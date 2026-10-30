import type { FilterCondition, FilterOperation, FilterOperatorType, FilterValue } from '@workflow/workflow';
import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateFilter, FilterError, OPERATIONS_BY_TYPE } from '../src';
import { coerce, parseDate, toRegExp } from '../src/utils/filter';
import { runNode } from './harness';

const strict = { caseSensitive: true, typeValidation: 'strict' as const };
const loose = { caseSensitive: true, typeValidation: 'loose' as const };

function cond(
  type: FilterOperatorType,
  operation: FilterOperation,
  leftValue: unknown,
  rightValue?: unknown,
): FilterCondition {
  return { id: 'c', leftValue, rightValue, operator: { type, operation } };
}

function check(
  type: FilterOperatorType,
  operation: FilterOperation,
  left: unknown,
  right?: unknown,
  options: { caseSensitive: boolean; typeValidation: 'strict' | 'loose' } = strict,
) {
  return evaluateCondition(cond(type, operation, left, right), options);
}

describe('filter: every operation', () => {
  // [type, operation, left, right, expected]
  const cases: Array<[FilterOperatorType, FilterOperation, unknown, unknown, boolean]> = [
    // string
    ['string', 'exists', 'a', undefined, true],
    ['string', 'exists', null, undefined, false],
    ['string', 'notExists', undefined, undefined, true],
    ['string', 'notExists', '', undefined, false],
    ['string', 'empty', '', undefined, true],
    ['string', 'empty', undefined, undefined, true],
    ['string', 'empty', 'x', undefined, false],
    ['string', 'notEmpty', 'x', undefined, true],
    ['string', 'equals', 'abc', 'abc', true],
    ['string', 'equals', 'abc', 'abd', false],
    ['string', 'notEquals', 'abc', 'abd', true],
    ['string', 'contains', 'hello world', 'lo w', true],
    ['string', 'notContains', 'hello', 'xyz', true],
    ['string', 'startsWith', 'hello', 'he', true],
    ['string', 'notStartsWith', 'hello', 'lo', true],
    ['string', 'endsWith', 'hello', 'lo', true],
    ['string', 'notEndsWith', 'hello', 'he', true],
    ['string', 'regex', 'order-123', '^order-\\d+$', true],
    ['string', 'regex', 'ORDER-1', '/^order-\\d$/i', true],
    ['string', 'notRegex', 'abc', '\\d', true],
    ['string', 'lengthEquals', 'abc', 3, true],
    ['string', 'lengthNotEquals', 'abc', 2, true],
    ['string', 'lengthGt', 'abc', 2, true],
    ['string', 'lengthGte', 'abc', 3, true],
    ['string', 'lengthLt', 'abc', 4, true],
    ['string', 'lengthLte', 'abc', 2, false],
    // number
    ['number', 'exists', 0, undefined, true],
    ['number', 'notExists', null, undefined, true],
    ['number', 'empty', Number.NaN, undefined, true],
    ['number', 'notEmpty', 0, undefined, true],
    ['number', 'equals', 5, 5, true],
    ['number', 'notEquals', 5, 6, true],
    ['number', 'gt', 5, 4, true],
    ['number', 'gt', 4, 4, false],
    ['number', 'gte', 4, 4, true],
    ['number', 'lt', 3, 4, true],
    ['number', 'lte', 5, 4, false],
    // dateTime
    ['dateTime', 'exists', '2024-01-01', undefined, true],
    ['dateTime', 'notExists', undefined, undefined, true],
    ['dateTime', 'empty', '', undefined, true],
    ['dateTime', 'notEmpty', '2024-01-01', undefined, true],
    ['dateTime', 'equals', '2024-01-01T00:00:00Z', '2024-01-01T01:00:00+01:00', true],
    ['dateTime', 'notEquals', '2024-01-01', '2024-01-02', true],
    ['dateTime', 'after', '2024-01-02', '2024-01-01', true],
    ['dateTime', 'afterOrEquals', '2024-01-01', '2024-01-01', true],
    ['dateTime', 'before', '2023-12-31', '2024-01-01', true],
    ['dateTime', 'beforeOrEquals', '2024-01-02', '2024-01-01', false],
    // boolean
    ['boolean', 'exists', false, undefined, true],
    ['boolean', 'notExists', undefined, undefined, true],
    ['boolean', 'empty', null, undefined, true],
    ['boolean', 'notEmpty', false, undefined, true],
    ['boolean', 'true', true, undefined, true],
    ['boolean', 'true', false, undefined, false],
    ['boolean', 'false', false, undefined, true],
    ['boolean', 'equals', true, true, true],
    ['boolean', 'notEquals', true, false, true],
    // array
    ['array', 'exists', [], undefined, true],
    ['array', 'notExists', undefined, undefined, true],
    ['array', 'empty', [], undefined, true],
    ['array', 'notEmpty', [1], undefined, true],
    ['array', 'contains', [1, 2, 3], 2, true],
    ['array', 'contains', [{ a: 1 }], { a: 1 }, true],
    ['array', 'notContains', ['a', 'b'], 'c', true],
    ['array', 'lengthEquals', [1, 2], 2, true],
    ['array', 'lengthNotEquals', [1, 2], 3, true],
    ['array', 'lengthGt', [1, 2], 1, true],
    ['array', 'lengthGte', [1, 2], 2, true],
    ['array', 'lengthLt', [1, 2], 3, true],
    ['array', 'lengthLte', [1, 2], 1, false],
    // object
    ['object', 'exists', {}, undefined, true],
    ['object', 'notExists', null, undefined, true],
    ['object', 'empty', {}, undefined, true],
    ['object', 'notEmpty', { a: 1 }, undefined, true],
    ['object', 'equals', { a: 1, b: [2] }, { b: [2], a: 1 }, true],
    ['object', 'notEquals', { a: 1 }, { a: 2 }, true],
    // any
    ['any', 'exists', 0, undefined, true],
    ['any', 'notExists', undefined, undefined, true],
    ['any', 'empty', '', undefined, true],
    ['any', 'notEmpty', [0], undefined, true],
    ['any', 'equals', 'x', 'x', true],
    ['any', 'notEquals', 1, '1', true],
  ];

  it.each(cases)('%s %s %j %j -> %s', (type, operation, left, right, expected) => {
    expect(check(type, operation, left, right)).toBe(expected);
  });

  it('covers every operation listed for every type', () => {
    const covered = new Set(cases.map(([t, o]) => `${t}:${o}`));
    for (const [type, operations] of Object.entries(OPERATIONS_BY_TYPE)) {
      for (const operation of operations)
        expect(covered.has(`${type}:${operation}`), `${type}:${operation}`).toBe(true);
    }
  });
});

describe('filter: type validation', () => {
  it('strict validation rejects wrong types with a helpful message', () => {
    expect(() => check('number', 'gt', '10', 9)).toThrow(
      /Wrong type: '10' is a string but was expecting a number/,
    );
    expect(() => check('string', 'equals', 5, '5')).toThrow(/is a number but was expecting a string/);
    expect(() => check('boolean', 'true', 'true')).toThrow(FilterError);
    expect(() => check('array', 'contains', '[1]', 1)).toThrow(/expecting an array/);
    expect(() => check('object', 'equals', '{}', {})).toThrow(/expecting an object/);
    expect(() => check('dateTime', 'after', 'not a date', '2024-01-01')).toThrow(/expecting a date/);
    expect(() => check('number', 'equals', 1, 'x')).toThrow(
      /Check the value you are comparing against|Wrong type/,
    );
  });

  it('loose validation converts unambiguous values', () => {
    expect(check('number', 'gt', '10', 9, loose)).toBe(true);
    expect(check('number', 'equals', true, 1, loose)).toBe(true);
    expect(check('string', 'equals', 5, '5', loose)).toBe(true);
    expect(check('boolean', 'true', 'TRUE', undefined, loose)).toBe(true);
    expect(check('boolean', 'false', '0', undefined, loose)).toBe(true);
    expect(check('array', 'contains', '[1,2]', 2, loose)).toBe(true);
    expect(check('array', 'contains', [1, 2], '2', loose)).toBe(true);
    expect(check('object', 'equals', '{"a":1}', { a: 1 }, loose)).toBe(true);
    expect(check('dateTime', 'after', 1_700_000_000, '2020-01-01', loose)).toBe(true);
    expect(check('dateTime', 'before', '1600000000000', '2021-01-01', loose)).toBe(true);
    expect(check('any', 'equals', 1, '1', loose)).toBe(true);
  });

  it('strict validation applies to the data side: a typed right value is parsed', () => {
    expect(check('number', 'gt', 150, '100')).toBe(true);
    expect(check('string', 'lengthGt', 'abc', '2')).toBe(true);
    expect(check('boolean', 'equals', true, 'true')).toBe(true);
    expect(check('boolean', 'equals', true, 'false')).toBe(false);
    expect(check('dateTime', 'after', '2024-06-01', '2024-01-01')).toBe(true);
    expect(() => check('number', 'gt', '150', '100')).toThrow(/expecting a number/);
    expect(() => check('number', 'gt', 150, 'abc')).toThrow(/Wrong type|Check the value/);
  });

  it('runs the editor-stored IF config (string right values, strict) on the engine', async () => {
    const conditions = (
      type: FilterOperatorType,
      operation: FilterOperation,
      rightValue: string,
    ): FilterValue => ({
      combinator: 'and',
      conditions: [{ id: 'c1', leftValue: '={{ $json.v }}', rightValue, operator: { type, operation } }],
      options: { caseSensitive: true, typeValidation: 'strict' },
    });
    const input = (v: unknown) => [{ json: { v } }];
    const big = await runNode('core.if', { conditions: conditions('number', 'gt', '100') }, input(150));
    expect(big.status).toBe('success');
    expect(big.outputs[0]).toEqual([{ v: 150 }]);
    const flag = await runNode(
      'core.if',
      { conditions: conditions('boolean', 'equals', 'true') },
      input(true),
    );
    expect(flag.status).toBe('success');
    expect(flag.outputs[0]).toEqual([{ v: true }]);
    const wrongData = await runNode(
      'core.if',
      { conditions: conditions('number', 'gt', '100') },
      input('150'),
    );
    expect(wrongData.status).toBe('error');
    expect(wrongData.error?.message).toMatch(/Wrong type/);
  });

  it('loose validation still fails when conversion is impossible', () => {
    expect(() => check('number', 'gt', 'abc', 1, loose)).toThrow(/expecting a number/);
    expect(() => check('boolean', 'true', 'maybe', undefined, loose)).toThrow(/expecting a boolean/);
  });

  it('missing values never throw type errors', () => {
    expect(check('number', 'gt', undefined, 1)).toBe(false);
    expect(check('number', 'equals', null, 1)).toBe(false);
    expect(check('string', 'equals', undefined, 'a')).toBe(false);
    expect(check('string', 'notEquals', undefined, 'a')).toBe(true);
    expect(check('array', 'lengthGt', undefined, 1)).toBe(false);
    expect(check('dateTime', 'after', '', '2024-01-01')).toBe(false);
  });

  it('accepts Date and Luxon values for dates', () => {
    expect(
      check('dateTime', 'equals', new Date('2024-01-01T00:00:00Z'), DateTime.fromISO('2024-01-01T00:00:00Z')),
    ).toBe(true);
    expect(parseDate('Tue, 01 Oct 2024 10:00:00 GMT', false)?.toISO()).toBe('2024-10-01T10:00:00.000Z');
    expect(parseDate('2024-10-01 10:00:00', false)?.isValid).toBe(true);
    expect(parseDate(1_700_000_000_000, false)).toBeUndefined();
  });

  it('coerce passes through null and any', () => {
    expect(coerce(null, 'number', false)).toBeNull();
    expect(coerce({ a: 1 }, 'any', false)).toEqual({ a: 1 });
  });

  it('rejects invalid lengths, operations and regular expressions', () => {
    expect(() => check('string', 'lengthGt', 'abc', -1)).toThrow(/whole number/);
    expect(() => check('number', 'contains', 1, 1)).toThrow(/not available for number/);
    expect(() => check('string', 'regex', 'a', '(')).toThrow(/Invalid regular expression/);
    expect(() => check('string', 'regex', 'aaaa!', '(a+)+$')).toThrow(FilterError);
    expect(() => check('string', 'regex', 'aaaa!', '(a+)+$')).toThrow(/not allowed/);
    expect(() => evaluateCondition(cond('nope' as never, 'equals', 1, 1), strict)).toThrow(
      /Unknown condition type/,
    );
  });
});

describe('filter: case sensitivity', () => {
  const ci = { caseSensitive: false, typeValidation: 'strict' as const };
  it('folds case for string operations when not case sensitive', () => {
    expect(check('string', 'equals', 'Hello', 'hello')).toBe(false);
    expect(check('string', 'equals', 'Hello', 'hello', ci)).toBe(true);
    expect(check('string', 'contains', 'Hello World', 'WORLD', ci)).toBe(true);
    expect(check('string', 'startsWith', 'Hello', 'HE', ci)).toBe(true);
    expect(check('string', 'endsWith', 'Hello', 'LO', ci)).toBe(true);
    expect(check('string', 'regex', 'Hello', '^hello$', ci)).toBe(true);
    expect(check('array', 'contains', ['Apple'], 'apple', ci)).toBe(true);
    expect(check('array', 'contains', ['Apple'], 'apple')).toBe(false);
  });

  it('builds regular expressions from /pattern/flags without the global flag', () => {
    const re = toRegExp('/a+/gi', true);
    expect(re.flags).toBe('i');
    expect(re.test('AAA')).toBe(true);
    expect(re.test('AAA')).toBe(true);
  });
});

describe('filter: combinators', () => {
  const t = cond('boolean', 'true', true);
  const f = cond('boolean', 'true', false);
  const filter = (combinator: 'and' | 'or', ...conditions: FilterCondition[]): FilterValue => ({
    combinator,
    conditions,
  });

  it('combines with and / or and treats an empty filter as passing', () => {
    expect(evaluateFilter(filter('and', t, t))).toBe(true);
    expect(evaluateFilter(filter('and', t, f))).toBe(false);
    expect(evaluateFilter(filter('or', f, t))).toBe(true);
    expect(evaluateFilter(filter('or', f, f))).toBe(false);
    expect(evaluateFilter({ combinator: 'and', conditions: [] })).toBe(true);
    expect(evaluateFilter(undefined)).toBe(true);
  });

  it('short-circuits and reports the failing condition number', () => {
    const bad = cond('number', 'gt', 'x', 1);
    expect(evaluateFilter(filter('or', t, bad))).toBe(true);
    expect(() => evaluateFilter(filter('and', t, bad))).toThrow(/\[condition 2\]/);
  });

  it('uses options from the filter value unless overridden', () => {
    const value: FilterValue = {
      combinator: 'and',
      conditions: [cond('number', 'gt', '5', 4)],
      options: { typeValidation: 'loose' },
    };
    expect(evaluateFilter(value)).toBe(true);
    expect(() => evaluateFilter(value, { typeValidation: 'strict' })).toThrow(FilterError);
    const ci: FilterValue = {
      combinator: 'and',
      conditions: [cond('string', 'equals', 'A', 'a')],
      options: { caseSensitive: false },
    };
    expect(evaluateFilter(ci)).toBe(true);
  });
});
