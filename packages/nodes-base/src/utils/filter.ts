/**
 * Condition evaluation shared by the If, Filter and Switch nodes (`filter` parameters).
 *
 * Every condition names an operator type (string, number, dateTime, ...) and an operation.
 * With strict type validation a value of the wrong type is an error, which catches mistakes
 * such as comparing "10" with 9 as text. Loose validation converts values where it is
 * unambiguous ("10" -> 10, "true" -> true, ISO strings / timestamps -> dates, JSON -> arrays).
 */
import {
  createSafeRegExp,
  type FilterCondition,
  type FilterOperation,
  type FilterOperatorType,
  type FilterValue,
  isPlainObject,
} from '@workflow/workflow';
import { DateTime } from 'luxon';
import { deepEqual } from './utilities';

export interface FilterOptions {
  caseSensitive: boolean;
  typeValidation: 'strict' | 'loose';
}

export class FilterError extends Error {
  constructor(
    message: string,
    readonly description?: string,
    readonly conditionIndex?: number,
  ) {
    super(message);
    this.name = 'FilterError';
  }
}

/** operations that never read the right value */
export const SINGLE_VALUE_OPERATIONS: FilterOperation[] = [
  'exists',
  'notExists',
  'empty',
  'notEmpty',
  'true',
  'false',
];

/** operations available per operator type (the editor renders the same table) */
export const OPERATIONS_BY_TYPE: Record<FilterOperatorType, FilterOperation[]> = {
  string: [
    'exists',
    'notExists',
    'empty',
    'notEmpty',
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'startsWith',
    'notStartsWith',
    'endsWith',
    'notEndsWith',
    'regex',
    'notRegex',
    'lengthEquals',
    'lengthNotEquals',
    'lengthGt',
    'lengthGte',
    'lengthLt',
    'lengthLte',
  ],
  number: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'],
  dateTime: [
    'exists',
    'notExists',
    'empty',
    'notEmpty',
    'equals',
    'notEquals',
    'after',
    'afterOrEquals',
    'before',
    'beforeOrEquals',
  ],
  boolean: ['exists', 'notExists', 'empty', 'notEmpty', 'true', 'false', 'equals', 'notEquals'],
  array: [
    'exists',
    'notExists',
    'empty',
    'notEmpty',
    'contains',
    'notContains',
    'lengthEquals',
    'lengthNotEquals',
    'lengthGt',
    'lengthGte',
    'lengthLt',
    'lengthLte',
  ],
  object: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals'],
  any: ['exists', 'notExists', 'empty', 'notEmpty', 'equals', 'notEquals'],
};

const TYPE_ARTICLE: Record<string, string> = {
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean',
  dateTime: 'a date',
  array: 'an array',
  object: 'an object',
};

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date || DateTime.isDateTime(value)) return 'a date';
  const t = typeof value;
  if (t === 'object') return 'an object';
  return TYPE_ARTICLE[t] ?? t;
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? `'${value}'` : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function typeError(value: unknown, expected: FilterOperatorType, side: 'left' | 'right'): FilterError {
  return new FilterError(
    `Wrong type: ${preview(value)} is ${describeValue(value)} but was expecting ${TYPE_ARTICLE[expected]}`,
    side === 'left'
      ? "Change the type of the comparison, or turn on 'Convert types where required'"
      : "Check the value you are comparing against, or turn on 'Convert types where required'",
  );
}

function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Parse a date from a Date, Luxon DateTime, ISO/RFC/HTTP/SQL string or (loose) timestamp. */
export function parseDate(value: unknown, loose: boolean, zone = 'UTC'): DateTime | undefined {
  if (DateTime.isDateTime(value)) return value as DateTime;
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return undefined;
    for (const parse of [DateTime.fromISO, DateTime.fromRFC2822, DateTime.fromHTTP, DateTime.fromSQL]) {
      const d = parse(s, { zone, setZone: true });
      if (d.isValid) return d;
    }
    if (loose) {
      if (/^-?\d+(\.\d+)?$/.test(s)) return parseDate(Number(s), loose, zone);
      const ms = Date.parse(s);
      if (!Number.isNaN(ms)) return DateTime.fromMillis(ms, { zone });
    }
    return undefined;
  }
  if (loose && typeof value === 'number' && Number.isFinite(value)) {
    // values below 1e11 are treated as seconds (1e11 s is the year 5138)
    return DateTime.fromMillis(Math.abs(value) < 1e11 ? value * 1000 : value, { zone });
  }
  return undefined;
}

/** Convert `value` to the operator type, or throw a FilterError. Null/undefined pass through. */
export function coerce(
  value: unknown,
  type: FilterOperatorType,
  loose: boolean,
  side: 'left' | 'right' = 'left',
): unknown {
  if (isNil(value) || type === 'any') return value;
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (!loose) throw typeError(value, type, side);
      return typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : String(value);
    case 'number': {
      if (typeof value === 'number') return value;
      if (loose) {
        if (typeof value === 'boolean') return value ? 1 : 0;
        if (typeof value === 'string' && value.trim() !== '') {
          const n = Number(value.trim());
          if (!Number.isNaN(n)) return n;
        }
      }
      throw typeError(value, type, side);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (loose) {
        const s = String(value).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(s)) return true;
        if (['false', '0', 'no', 'off', ''].includes(s)) return false;
      }
      throw typeError(value, type, side);
    }
    case 'dateTime': {
      const d = parseDate(value, loose);
      if (d?.isValid) return d;
      throw typeError(value, type, side);
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      if (loose && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* not JSON */
        }
      }
      throw typeError(value, type, side);
    }
    case 'object': {
      if (isPlainObject(value)) return value;
      if (loose && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (isPlainObject(parsed)) return parsed;
        } catch {
          /* not JSON */
        }
      }
      throw typeError(value, type, side);
    }
    default:
      return value;
  }
}

function isEmpty(value: unknown): boolean {
  if (isNil(value)) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return Number.isNaN(value);
  if (DateTime.isDateTime(value)) return !(value as DateTime).isValid;
  if (value instanceof Date) return Number.isNaN(value.getTime());
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Build a RegExp from "pattern" or "/pattern/flags". */
export function toRegExp(source: string, caseSensitive: boolean): RegExp {
  const match = /^\/(.+)\/([dgimsuvy]*)$/s.exec(source);
  let pattern = source;
  let flags = '';
  if (match) {
    pattern = match[1];
    flags = match[2].replace(/[gy]/g, '');
  }
  if (!caseSensitive && !flags.includes('i')) flags += 'i';
  try {
    return createSafeRegExp(pattern, flags);
  } catch (error) {
    const message = (error as Error).message;
    throw new FilterError(
      message.startsWith('Invalid regular expression') ? message : `Invalid regular expression: ${message}`,
    );
  }
}

function lengthOf(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  throw new FilterError(`Cannot take the length of ${describeValue(value)}`);
}

/**
 * Strict validation is about the data (left) side. A right value the user typed into the editor
 * is stored as text, so for number, boolean and date comparisons it is always parsed.
 */
function isTypedConstant(value: unknown, type: FilterOperatorType): boolean {
  return typeof value === 'string' && (type === 'number' || type === 'boolean' || type === 'dateTime');
}

function toLengthNumber(value: unknown, loose: boolean): number {
  const n = coerce(value, 'number', loose || isTypedConstant(value, 'number'), 'right');
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new FilterError(`Length must be a whole number, got ${preview(value)}`);
  }
  return n;
}

function fold(value: unknown, caseSensitive: boolean): unknown {
  return !caseSensitive && typeof value === 'string' ? value.toLowerCase() : value;
}

function compareDates(a: DateTime, b: DateTime): number {
  return a.toMillis() - b.toMillis();
}

/** Evaluate one condition. `leftValue` / `rightValue` are already resolved expressions. */
export function evaluateCondition(condition: FilterCondition, options: FilterOptions): boolean {
  const { type = 'string', operation } = condition.operator ?? ({} as FilterCondition['operator']);
  const loose = options.typeValidation === 'loose';
  const cs = options.caseSensitive;
  const allowed = OPERATIONS_BY_TYPE[type];
  if (!allowed) throw new FilterError(`Unknown condition type "${type}"`);
  if (!allowed.includes(operation)) {
    throw new FilterError(`The operation "${operation}" is not available for ${type} values`);
  }

  const rawLeft = condition.leftValue === '' && type !== 'string' ? undefined : condition.leftValue;
  switch (operation) {
    case 'exists':
      return !isNil(rawLeft);
    case 'notExists':
      return isNil(rawLeft);
    case 'empty':
    case 'notEmpty': {
      // empty checks never fail on type: a missing or blank value is simply empty
      let value = rawLeft;
      if (loose && (type === 'array' || type === 'object') && typeof value === 'string') {
        try {
          value = coerce(value, type, true);
        } catch {
          /* keep the string */
        }
      }
      const empty = isEmpty(value);
      return operation === 'empty' ? empty : !empty;
    }
    default:
      break;
  }

  const left = coerce(rawLeft, type, loose, 'left');
  if (operation === 'true' || operation === 'false') return left === (operation === 'true');

  // operations comparing against the right value
  if (operation.startsWith('length')) {
    if (isNil(left)) return false;
    const len = lengthOf(left);
    const target = toLengthNumber(condition.rightValue, loose);
    switch (operation) {
      case 'lengthEquals':
        return len === target;
      case 'lengthNotEquals':
        return len !== target;
      case 'lengthGt':
        return len > target;
      case 'lengthGte':
        return len >= target;
      case 'lengthLt':
        return len < target;
      case 'lengthLte':
        return len <= target;
    }
  }

  if (type === 'array' && (operation === 'contains' || operation === 'notContains')) {
    const list = (left ?? []) as unknown[];
    const needle = fold(condition.rightValue, cs);
    const found = list.some((entry) => {
      const value = fold(entry, cs);
      if (deepEqual(value, needle)) return true;
      return loose && !isNil(value) && !isNil(needle) && String(value) === String(needle);
    });
    return operation === 'contains' ? found : !found;
  }

  const rightType: FilterOperatorType = operation === 'regex' || operation === 'notRegex' ? 'string' : type;
  const right = coerce(
    condition.rightValue === '' && rightType !== 'string' ? undefined : condition.rightValue,
    rightType,
    loose || isTypedConstant(condition.rightValue, rightType),
    'right',
  );

  switch (type) {
    case 'string': {
      const l = fold(left ?? '', cs) as string;
      const r = fold(right ?? '', cs) as string;
      switch (operation) {
        case 'equals':
          return !isNil(left) && l === r;
        case 'notEquals':
          return isNil(left) || l !== r;
        case 'contains':
          return !isNil(left) && l.includes(r);
        case 'notContains':
          return isNil(left) || !l.includes(r);
        case 'startsWith':
          return !isNil(left) && l.startsWith(r);
        case 'notStartsWith':
          return isNil(left) || !l.startsWith(r);
        case 'endsWith':
          return !isNil(left) && l.endsWith(r);
        case 'notEndsWith':
          return isNil(left) || !l.endsWith(r);
        case 'regex':
          return !isNil(left) && toRegExp(String(right ?? ''), cs).test(String(left));
        case 'notRegex':
          return isNil(left) || !toRegExp(String(right ?? ''), cs).test(String(left));
      }
      break;
    }
    case 'number': {
      if (operation === 'equals') return !isNil(left) && left === right;
      if (operation === 'notEquals') return left !== right;
      if (isNil(left) || isNil(right)) return false;
      const l = left as number;
      const r = right as number;
      switch (operation) {
        case 'gt':
          return l > r;
        case 'gte':
          return l >= r;
        case 'lt':
          return l < r;
        case 'lte':
          return l <= r;
      }
      break;
    }
    case 'dateTime': {
      if (isNil(left) || isNil(right))
        return operation === 'notEquals' ? !(isNil(left) && isNil(right)) : false;
      const diff = compareDates(left as DateTime, right as DateTime);
      switch (operation) {
        case 'equals':
          return diff === 0;
        case 'notEquals':
          return diff !== 0;
        case 'after':
          return diff > 0;
        case 'afterOrEquals':
          return diff >= 0;
        case 'before':
          return diff < 0;
        case 'beforeOrEquals':
          return diff <= 0;
      }
      break;
    }
    case 'boolean':
      if (operation === 'equals') return !isNil(left) && left === right;
      if (operation === 'notEquals') return left !== right;
      break;
    case 'object':
    case 'any': {
      let equal = deepEqual(fold(left, cs), fold(right, cs));
      if (!equal && loose && type === 'any' && !isNil(left) && !isNil(right)) {
        equal = String(fold(left, cs)) === String(fold(right, cs));
      }
      if (operation === 'equals') return equal;
      if (operation === 'notEquals') return !equal;
      break;
    }
  }
  throw new FilterError(`The operation "${operation}" is not available for ${type} values`);
}

/**
 * Evaluate a whole filter value (conditions + combinator). Errors carry the 1-based condition
 * number so the editor can point at it.
 */
export function evaluateFilter(
  filter: FilterValue | undefined,
  overrides: Partial<FilterOptions> = {},
): boolean {
  const conditions = filter?.conditions ?? [];
  const options: FilterOptions = {
    caseSensitive: overrides.caseSensitive ?? filter?.options?.caseSensitive ?? true,
    typeValidation: overrides.typeValidation ?? filter?.options?.typeValidation ?? 'strict',
  };
  if (!conditions.length) return true;
  const combinator = filter?.combinator === 'or' ? 'or' : 'and';
  for (let i = 0; i < conditions.length; i++) {
    let result: boolean;
    try {
      result = evaluateCondition(conditions[i], options);
    } catch (error) {
      if (error instanceof FilterError) {
        throw new FilterError(`${error.message} [condition ${i + 1}]`, error.description, i);
      }
      throw error;
    }
    if (combinator === 'and' && !result) return false;
    if (combinator === 'or' && result) return true;
  }
  return combinator === 'and';
}
