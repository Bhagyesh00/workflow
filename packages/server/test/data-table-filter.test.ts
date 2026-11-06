/**
 * P4-03: the filter, search and sort SQL of data tables, without a database. Names and values must
 * only ever be bound parameters; the row tests in data-tables.test.ts run the same SQL on Postgres.
 */
import { DATA_TABLE_ERRORS, type DataTableFilter } from '@workflow/workflow';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm/sql';
import { describe, expect, it } from 'vitest';
import {
  buildFilterSql,
  buildOrderBySql,
  buildSearchSql,
  coerceCellValue,
  type DataTableFilterColumn,
  likePattern,
  parseDataTableDate,
} from '../src/services/data-table-filter';

const columns: DataTableFilterColumn[] = [
  { name: 'title', type: 'string' },
  { name: 'score', type: 'number' },
  { name: 'done', type: 'boolean' },
  { name: 'due', type: 'date' },
];

const dialect = new PgDialect();
const compile = (fragment: SQL | undefined) => dialect.sqlToQuery(fragment as SQL);
const one = (filter: DataTableFilter['filters'][number]) =>
  compile(buildFilterSql({ type: 'and', filters: [filter] }, columns));

describe('coerceCellValue', () => {
  it('keeps null and coerces non-strictly to the column type', () => {
    expect(coerceCellValue(null, 'number')).toBeNull();
    expect(coerceCellValue('5', 'number')).toBe(5);
    expect(coerceCellValue(1.5, 'number')).toBe(1.5);
    expect(coerceCellValue(5, 'string')).toBe('5');
    expect(coerceCellValue(true, 'string')).toBe('true');
    expect(coerceCellValue('yes', 'boolean')).toBe(true);
    expect(coerceCellValue('0', 'boolean')).toBe(false);
    expect(coerceCellValue(1, 'boolean')).toBe(true);
    expect(coerceCellValue('2024-03-01', 'date')).toBe('2024-03-01T00:00:00.000Z');
    expect(coerceCellValue('2024-03-01T10:00:00+02:00', 'date')).toBe('2024-03-01T08:00:00.000Z');
    expect(coerceCellValue(new Date(Date.UTC(2024, 0, 2)), 'date')).toBe('2024-01-02T00:00:00.000Z');
  });

  it.each([
    ['abc', 'number'],
    ['', 'number'],
    [Number.POSITIVE_INFINITY, 'number'],
    [true, 'number'],
    ['maybe', 'boolean'],
    [2, 'boolean'],
    ['Room 5', 'date'],
    ['2024-02-31', 'date'],
    [1700000000, 'date'],
  ] as const)("refuses %s for a %s column with n8n's text", (value, type) => {
    expect(() => coerceCellValue(value, type)).toThrow(
      `value '${String(value)}' does not match column type '${type}'`,
    );
  });
});

describe('parseDataTableDate', () => {
  it('reads ISO, SQL style and mail dates, and refuses what the loose Date parser takes', () => {
    expect(parseDataTableDate('2024-03-01 10:30:00')?.toISOString()).toBe('2024-03-01T10:30:00.000Z');
    expect(parseDataTableDate('Fri, 01 Mar 2024 10:30:00 GMT')?.toISOString()).toBe(
      '2024-03-01T10:30:00.000Z',
    );
    expect(parseDataTableDate('hello 1')).toBeUndefined();
    expect(parseDataTableDate('5')).toBeUndefined();
    expect(parseDataTableDate('12000-01-01')).toBeUndefined();
  });
});

describe('likePattern', () => {
  it('adds % only when the value has none, and only % is a wildcard', () => {
    expect(likePattern('abc')).toBe('%abc%');
    expect(likePattern('ab%')).toBe('ab%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('buildFilterSql', () => {
  it('answers nothing for an empty filter', () => {
    expect(buildFilterSql({ type: 'and', filters: [] }, columns)).toBeUndefined();
    expect(buildFilterSql(undefined, columns)).toBeUndefined();
  });

  it('binds column names and values: neither is ever SQL text', () => {
    const evil = "x'; drop table users; --";
    const query = one({ columnName: 'title', condition: 'eq', value: evil });
    expect(query.sql).not.toContain('title');
    expect(query.sql).not.toContain('drop table');
    expect(query.params).toEqual(['title', evil]);
    expect(query.sql).toContain('$1');
    expect(query.sql).toContain('$2');
  });

  it('refuses an unknown or hostile column name before any SQL', () => {
    for (const name of ['nope', '__proto__', 'constructor', "title' or 1=1 --"]) {
      expect(() =>
        buildFilterSql({ type: 'and', filters: [{ columnName: name, condition: 'eq', value: 1 }] }, columns),
      ).toThrow(DATA_TABLE_ERRORS.unknownColumn(name));
    }
  });

  it('guards the number and boolean casts, so a value of another type can never fail a query', () => {
    const number = one({ columnName: 'score', condition: 'gt', value: '5' });
    expect(number.sql).toContain('jsonb_typeof');
    expect(number.sql).toContain('double precision');
    expect(number.params).toEqual(['score', 'score', 5]);
    const boolean = one({ columnName: 'done', condition: 'eq', value: 'true' });
    expect(boolean.sql).toContain('jsonb_typeof');
    expect(boolean.params).toContain(true);
  });

  it('compares dates as UTC ISO text', () => {
    const query = one({ columnName: 'due', condition: 'lte', value: '2024-03-01' });
    expect(query.sql).toContain('COLLATE "C"');
    expect(query.params).toEqual(['due', '2024-03-01T00:00:00.000Z']);
  });

  it('refuses a value that does not fit the column', () => {
    expect(() =>
      buildFilterSql(
        { type: 'and', filters: [{ columnName: 'score', condition: 'eq', value: 'abc' }] },
        columns,
      ),
    ).toThrow("value 'abc' does not match column type 'number'");
  });

  it('turns null into IS NULL, and neq also matches a missing value', () => {
    expect(one({ columnName: 'title', condition: 'eq', value: null }).sql).toContain('is null');
    expect(one({ columnName: 'title', condition: 'neq', value: null }).sql).toContain('is not null');
    const neq = one({ columnName: 'title', condition: 'neq', value: 'a' });
    expect(neq.sql).toContain('<>');
    expect(neq.sql).toContain('is null');
  });

  it('matches nothing for a comparison against null', () => {
    for (const condition of ['gt', 'gte', 'lt', 'lte'] as const) {
      expect(one({ columnName: 'title', condition, value: null }).sql).toContain('false');
    }
  });

  it('refuses like and ilike with null or a value that is not text', () => {
    for (const condition of ['like', 'ilike'] as const) {
      for (const value of [null, undefined, 5, true, new Date(0)]) {
        expect(() => one({ columnName: 'title', condition, value: value as never })).toThrow(
          `${condition} needs a text value`,
        );
      }
    }
  });

  it('like and ilike: no % means contains, only % is a wildcard, _ and backslash are literal', () => {
    for (const condition of ['like', 'ilike'] as const) {
      expect(one({ columnName: 'title', condition, value: 'a_b' }).params[1]).toBe('%a\\_b%');
      expect(one({ columnName: 'title', condition, value: 'a%b_' }).params[1]).toBe('a%b\\_');
      expect(one({ columnName: 'title', condition, value: 'x\\y' }).params[1]).toBe('%x\\\\y%');
    }
  });

  it('refuses a NUL or half a surrogate pair in a value, a pattern or a search with a 400', () => {
    for (const bad of ['a\u0000b', 'a\ud800b', 'a\udc00b']) {
      for (const condition of ['eq', 'like', 'ilike'] as const) {
        expect(() => one({ columnName: 'title', condition, value: bad })).toThrow(/NUL|surrogate/);
      }
      expect(() => buildSearchSql(bad)).toThrow(/NUL|surrogate/);
      expect(() => coerceCellValue(bad, 'string')).toThrow(/NUL|surrogate/);
    }
    expect(coerceCellValue('ok \ud83d\ude00', 'string')).toBe('ok \ud83d\ude00');
  });

  it('isEmpty and isNotEmpty read no value', () => {
    const empty = one({ columnName: 'title', condition: 'isEmpty', value: 'ignored' });
    expect(empty.sql).toContain('is null');
    expect(empty.params).not.toContain('ignored');
    const notEmpty = one({ columnName: 'title', condition: 'isNotEmpty' });
    expect(notEmpty.sql).toContain('is not null');
  });

  it('joins clauses with and or or', () => {
    const clauses: DataTableFilter['filters'] = [
      { columnName: 'title', condition: 'eq', value: 'a' },
      { columnName: 'score', condition: 'eq', value: 1 },
    ];
    expect(compile(buildFilterSql({ type: 'and', filters: clauses }, columns)).sql).toContain(' and ');
    expect(compile(buildFilterSql({ type: 'or', filters: clauses }, columns)).sql).toContain(' or ');
  });

  it('reads the system columns from their own table columns', () => {
    const id = one({ columnName: 'id', condition: 'eq', value: '7' });
    expect(id.sql).toContain('"row_id"');
    expect(id.params).toEqual([7]);
    const created = one({ columnName: 'createdAt', condition: 'gte', value: '2024-03-01' });
    expect(created.sql).toContain('"created_at"');
    expect(created.sql).toContain('timestamptz');
    expect(created.params).toEqual(['2024-03-01T00:00:00.000Z']);
  });
});

describe('buildSearchSql', () => {
  it('ignores a blank search and binds the rest', () => {
    expect(buildSearchSql(undefined)).toBeUndefined();
    expect(buildSearchSql('   ')).toBeUndefined();
    const query = compile(buildSearchSql("a_b'c"));
    expect(query.sql).toContain('ilike');
    expect(query.params).toEqual(["%a\\_b'c%"]);
  });
});

describe('buildOrderBySql', () => {
  it('sorts by id alone by default', () => {
    const [only, ...rest] = buildOrderBySql(undefined, columns);
    expect(rest).toEqual([]);
    expect(compile(only).sql).toContain('"row_id"');
  });

  it('binds the column name and breaks ties by id', () => {
    const order = buildOrderBySql({ column: 'title', direction: 'desc' }, columns);
    expect(order).toHaveLength(2);
    const first = compile(order[0]);
    expect(first.sql).toContain('desc');
    expect(first.sql).not.toContain('title');
    expect(first.params).toEqual(['title']);
    expect(compile(order[1]).sql).toContain('"row_id"');
  });

  it('does not add the tie break when sorting by id', () => {
    expect(buildOrderBySql({ column: 'id', direction: 'desc' }, columns)).toHaveLength(1);
  });

  it('refuses an unknown column', () => {
    expect(() => buildOrderBySql({ column: "x'); --", direction: 'asc' }, columns)).toThrow(
      DATA_TABLE_ERRORS.unknownColumn("x'); --"),
    );
  });
});
