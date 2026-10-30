/**
 * Globals visible to expressions. Shared host objects (Math, JSON, Object, ...) are exposed only
 * through frozen facades so that user code can never mutate process-wide state that other
 * tenants' expressions would observe.
 */
import jmespath from 'jmespath';
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError } from '../errors';
import { guardArrayLength } from './extensions';
import { isPlainMutable } from './interpreter';

function freezeCopy<T extends object>(source: T, keys: string[]): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (source as any)[k];
  return Object.freeze(out);
}

function callableFacade<F extends (...args: any[]) => unknown>(fn: F, statics: Record<string, unknown>): F {
  for (const [k, v] of Object.entries(statics)) {
    Object.defineProperty(fn, k, { value: v, enumerable: true });
  }
  return Object.freeze(fn);
}

const SafeObject = Object.freeze({
  keys: (o: object) => Object.keys(o),
  values: (o: object) => Object.values(o),
  entries: (o: object) => Object.entries(o),
  fromEntries: (e: Iterable<readonly [PropertyKey, unknown]>) => Object.fromEntries(e),
  hasOwn: (o: object, k: PropertyKey) => Object.hasOwn(o, k),
  is: (a: unknown, b: unknown) => Object.is(a, b),
  assign: (target: object, ...sources: object[]) => {
    if (!isPlainMutable(target)) throw new ExpressionError('Object.assign target must be a plain object');
    return Object.assign(target, ...sources);
  },
});

const SafeArray = Object.freeze({
  isArray: (v: unknown) => Array.isArray(v),
  of: (...items: unknown[]) => items,
  from: (source: any, mapFn?: (v: unknown, i: number) => unknown) => {
    if (source && typeof source === 'object' && 'length' in source && !Array.isArray(source)) {
      guardArrayLength(source.length);
    }
    return mapFn ? Array.from(source, mapFn) : Array.from(source);
  },
});

const SafeNumber = callableFacade((v: unknown) => Number(v), {
  isInteger: Number.isInteger,
  isFinite: Number.isFinite,
  isNaN: Number.isNaN,
  isSafeInteger: Number.isSafeInteger,
  parseFloat: Number.parseFloat,
  parseInt: Number.parseInt,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  EPSILON: Number.EPSILON,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
});

const SafeString = callableFacade((v: unknown) => String(v), {
  fromCharCode: String.fromCharCode,
  fromCodePoint: String.fromCodePoint,
  raw: String.raw,
});

const SafeBoolean = callableFacade((v: unknown) => Boolean(v), {});

/** constructs real RegExp objects without exposing the legacy cross-call statics (RegExp.$1, RegExp.input) */
function SafeRegExp(pattern: string | RegExp, flags?: string) {
  return new RegExp(pattern, flags);
}
Object.freeze(SafeRegExp);

const SafeIntl = freezeCopy(Intl, [
  'NumberFormat',
  'DateTimeFormat',
  'Collator',
  'PluralRules',
  'RelativeTimeFormat',
  'ListFormat',
]);

const SafeJSON = Object.freeze({
  parse: (text: string, reviver?: (k: string, v: unknown) => unknown) => JSON.parse(text, reviver),
  stringify: (value: unknown, replacer?: any, space?: string | number) =>
    JSON.stringify(value, replacer, space),
});

const SafeMath = freezeCopy(
  Math,
  Object.getOwnPropertyNames(Math).filter((k) => k !== 'constructor'),
);

export const baseGlobals: Readonly<Record<string, unknown>> = Object.freeze({
  Math: SafeMath,
  JSON: SafeJSON,
  Object: SafeObject,
  Array: SafeArray,
  Number: SafeNumber,
  String: SafeString,
  Boolean: SafeBoolean,
  Date,
  RegExp: SafeRegExp,
  Map,
  Set,
  Error,
  TypeError,
  RangeError,
  URL,
  URLSearchParams,
  Intl: SafeIntl,
  DateTime,
  Duration,
  Interval,
  parseInt: Number.parseInt,
  parseFloat: Number.parseFloat,
  isNaN: Number.isNaN,
  isFinite: Number.isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  btoa: (s: string) => btoa(s),
  atob: (s: string) => atob(s),
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  $jmespath: (data: unknown, query: string) => jmespath.search(data as any, query),
  $if: (condition: unknown, a: unknown, b: unknown) => (condition ? a : b),
  $ifEmpty: (value: unknown, fallback: unknown) => {
    if (value === null || value === undefined || value === '') return fallback;
    if (Array.isArray(value) && value.length === 0) return fallback;
    if (typeof value === 'object' && Object.keys(value as object).length === 0) return fallback;
    return value;
  },
  $max: (...values: number[]) => Math.max(...values),
  $min: (...values: number[]) => Math.min(...values),
});
