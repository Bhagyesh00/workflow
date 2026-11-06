/**
 * Data tables (P4-03): cell values, and the SQL of filters, search and sort. A column name and a value
 * only ever reach SQL as bound parameters, and a name must be a column of the table first.
 *
 * Cells live in one jsonb column of a table shared by every data table, so the same key can hold a
 * number in one table and text in another. A number or boolean cast is guarded by jsonb_typeof, so no
 * row can make a query fail, whatever order Postgres checks the conditions in. Dates are stored as UTC
 * ISO text with a four-digit year, which compares correctly as bytes and needs no cast at all.
 */
import {
  DATA_TABLE_EARLIEST_DATE_MS,
  DATA_TABLE_ERRORS,
  DATA_TABLE_LATEST_DATE_MS,
  type DataTableCellValue,
  type DataTableColumnType,
  type DataTableFilter,
  type DataTableFilterClause,
  type DataTableInputValue,
  type DataTableSortDirection,
  parseDataTableDate,
} from '@workflow/workflow';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm/sql';
import { dataTableRows } from '../db/schema';
import { ApiError } from '../http/errors';

export interface DataTableFilterColumn {
  name: string;
  type: DataTableColumnType;
}

// one reader for the node and the server, kept under this name for the callers here
export { parseDataTableDate };

/** a NUL byte, or half of a surrogate pair: Postgres refuses both in text and jsonb */
const HALF_PAIR = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Text Postgres would refuse answers 400 with a reason, not 500. Returns the text. */
export function assertStorableText(text: string): string {
  if (text.includes('\0') || HALF_PAIR.test(text)) {
    throw ApiError.badRequest('Text must not hold a NUL character or half of a surrogate pair');
  }
  return text;
}

const TRUE_WORDS = new Set(['true', '1', 't', 'yes']);
const FALSE_WORDS = new Set(['false', '0', 'f', 'no']);

function mismatch(value: unknown, type: DataTableColumnType, expected: string): ApiError {
  const shown = value instanceof Date ? 'Invalid Date' : value;
  return ApiError.badRequest(
    DATA_TABLE_ERRORS.valueTypeMismatch(
      shown,
      type,
      `the value expects ${expected} but we got '${String(shown)}'`,
    ),
  );
}

function toDateText(value: DataTableInputValue): string | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time) || time < DATA_TABLE_EARLIEST_DATE_MS || time > DATA_TABLE_LATEST_DATE_MS)
      return undefined;
    return value.toISOString();
  }
  return typeof value === 'string' ? parseDataTableDate(value)?.toISOString() : undefined;
}

/** The value to store: coerced non-strictly to the column's type, as n8n does ("5" to 5). */
export function coerceCellValue(value: DataTableInputValue, type: DataTableColumnType): DataTableCellValue {
  if (value === null) return null;
  switch (type) {
    case 'string':
      return assertStorableText(value instanceof Date ? (toDateText(value) ?? String(value)) : String(value));
    case 'number': {
      const number =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
      if (!Number.isFinite(number)) throw mismatch(value, type, 'a number');
      return number;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const word = String(value).trim().toLowerCase();
      if (value instanceof Date || !(TRUE_WORDS.has(word) || FALSE_WORDS.has(word))) {
        throw mismatch(value, type, 'a boolean');
      }
      return TRUE_WORDS.has(word);
    }
    case 'date': {
      const text = toDateText(value);
      if (text === undefined) throw mismatch(value, type, 'a date');
      return text;
    }
  }
}

const SYSTEM_COLUMNS: Record<string, DataTableColumnType> = {
  id: 'number',
  createdAt: 'date',
  updatedAt: 'date',
};

interface ColumnSql {
  type: DataTableColumnType;
  /** the typed value, for comparing and sorting */
  value: SQL;
  /** the value as text, for patterns and for empty checks */
  text: SQL;
  /** a coerced value, cast so that it compares with `value` */
  bind(value: DataTableCellValue): SQL;
}

const isoText = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function systemColumnSql(name: string, type: DataTableColumnType): ColumnSql {
  if (name === 'id') {
    const column = sql`${dataTableRows.rowId}`;
    return {
      type,
      value: column,
      text: sql`${dataTableRows.rowId}::text`,
      bind: (value) =>
        Number.isSafeInteger(value) ? sql`${value}::bigint` : sql`${value}::double precision`,
    };
  }
  const column = name === 'createdAt' ? sql`${dataTableRows.createdAt}` : sql`${dataTableRows.updatedAt}`;
  return { type, value: column, text: isoText(column), bind: (value) => sql`${value}::timestamptz` };
}

function userColumnSql(name: string, type: DataTableColumnType): ColumnSql {
  const text = sql`(${dataTableRows.data} ->> ${name}::text)`;
  switch (type) {
    case 'number':
      return {
        type,
        text,
        value: sql`(case when jsonb_typeof(${dataTableRows.data} -> ${name}::text) = 'number' then ${text}::double precision end)`,
        bind: (value) => sql`${value}::double precision`,
      };
    case 'boolean':
      return {
        type,
        text,
        value: sql`(case when jsonb_typeof(${dataTableRows.data} -> ${name}::text) = 'boolean' then ${text}::boolean end)`,
        bind: (value) => sql`${value}::boolean`,
      };
    case 'date':
      return { type, text, value: sql`${text} COLLATE "C"`, bind: (value) => sql`${value}::text` };
    case 'string':
      return { type, text, value: text, bind: (value) => sql`${value}::text` };
  }
}

function columnSql(columns: readonly DataTableFilterColumn[], name: string): ColumnSql {
  // own keys only: a name like "constructor" must not find Object.prototype
  if (Object.hasOwn(SYSTEM_COLUMNS, name)) return systemColumnSql(name, SYSTEM_COLUMNS[name]);
  const column = columns.find((c) => c.name === name);
  if (!column) throw ApiError.badRequest(DATA_TABLE_ERRORS.unknownColumn(name));
  return userColumnSql(name, column.type);
}

const escapeLike = (value: string) => value.replace(/[\\_]/g, (c) => `\\${c}`);

/** Only `%` is a wildcard, and a value without one matches anywhere in the text. */
export function likePattern(value: string): string {
  const escaped = escapeLike(value);
  return value.includes('%') ? escaped : `%${escaped}%`;
}

function clauseSql(clause: DataTableFilterClause, columns: readonly DataTableFilterColumn[]): SQL {
  const column = columnSql(columns, clause.columnName);
  const { condition } = clause;
  if (condition === 'isEmpty') return sql`(${column.text} is null or ${column.text} = '')`;
  if (condition === 'isNotEmpty') return sql`(${column.text} is not null and ${column.text} <> '')`;

  const input = clause.value ?? null;
  if (condition === 'like' || condition === 'ilike') {
    // n8n: a pattern is text; null and numbers are a validation error, not "match nothing"
    if (typeof input !== 'string') {
      throw ApiError.badRequest(
        DATA_TABLE_ERRORS.valueTypeMismatch(input, 'string', `${condition} needs a text value`),
      );
    }
    const pattern = likePattern(assertStorableText(input));
    return condition === 'like'
      ? sql`${column.text} like ${pattern}::text`
      : sql`${column.text} ilike ${pattern}::text`;
  }
  if (input === null) {
    if (condition === 'eq') return sql`${column.text} is null`;
    if (condition === 'neq') return sql`${column.text} is not null`;
    // as in SQL: comparing with null matches nothing
    return sql`false`;
  }

  const value = column.bind(coerceCellValue(input, column.type));
  switch (condition) {
    case 'eq':
      return sql`${column.value} = ${value}`;
    case 'neq':
      return sql`(${column.value} <> ${value} or ${column.text} is null)`;
    case 'gt':
      return sql`${column.value} > ${value}`;
    case 'gte':
      return sql`${column.value} >= ${value}`;
    case 'lt':
      return sql`${column.value} < ${value}`;
    case 'lte':
      return sql`${column.value} <= ${value}`;
  }
}

/** The condition of a filter; undefined when it has no clauses. Refuses an unknown column. */
export function buildFilterSql(
  filter: DataTableFilter | undefined,
  columns: readonly DataTableFilterColumn[],
): SQL | undefined {
  if (!filter?.filters.length) return undefined;
  const clauses = filter.filters.map((clause) => clauseSql(clause, columns));
  return sql`(${sql.join(clauses, filter.type === 'or' ? sql` or ` : sql` and `)})`;
}

/** Any user column as text, case-insensitively; a blank search is no search. */
export function buildSearchSql(search: string | undefined): SQL | undefined {
  if (!search?.trim()) return undefined;
  const pattern = likePattern(assertStorableText(search));
  return sql`exists (select 1 from jsonb_each_text(${dataTableRows.data}) cell where cell.value ilike ${pattern}::text)`;
}

/** The requested order, with `id` ascending as the tie break and the default. */
export function buildOrderBySql(
  sortBy: { column: string; direction: DataTableSortDirection } | undefined,
  columns: readonly DataTableFilterColumn[],
): SQL[] {
  const byId = sql`${dataTableRows.rowId} asc`;
  if (!sortBy) return [byId];
  const { value } = columnSql(columns, sortBy.column);
  const order = sortBy.direction === 'desc' ? sql`${value} desc` : sql`${value} asc`;
  return sortBy.column === 'id' ? [order] : [order, byId];
}
