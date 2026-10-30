/**
 * Globals visible to expressions. Shared host objects (Math, JSON, Object, ...) are exposed only
 * through frozen facades so that user code can never mutate process-wide state that other
 * tenants' expressions would observe.
 */
import jmespath from 'jmespath';
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError } from '../errors';
import { deepFreeze } from '../utils';
import { encodedUriLength, jsonLength, stringifyBounded, stringRawBounded, uriKeepTable } from './bounded';
import {
  assertDateFormatLength,
  assertSafeDateFormat,
  assertSafeFormatParser,
  guardArrayLength,
} from './extensions';
import { isPlainMutable, LIMITS, registerGuardedFunction, visibleEntries } from './interpreter';
import { createSafeRegExp } from './regex';

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
  keys: (o: object) => visibleEntries(o, false).map(([k]) => k),
  values: (o: object) => visibleEntries(o, false).map(([, v]) => v),
  entries: (o: object) => visibleEntries(o, false),
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

/**
 * Constructs real RegExp objects without exposing the legacy cross-call statics (RegExp.$1,
 * RegExp.input). Patterns go through the regex safety policy.
 */
function SafeRegExp(pattern: string | RegExp, flags?: string) {
  return createSafeRegExp(pattern instanceof RegExp ? pattern : String(pattern), flags);
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

registerGuardedFunction(SafeObject.assign, {
  mutatesArg: 0,
  // everything the native copies, internals included, so input data can only receive data
  inserts: (_thisArg, [, ...sources]) =>
    sources.flatMap((s) => (s !== null && typeof s === 'object' ? Object.values(s) : [])),
});
// these read or copy their arguments without converting them (JSON.stringify, String and
// $jmespath measure what they convert themselves)
for (const fn of [
  SafeObject.assign,
  SafeObject.keys,
  SafeObject.values,
  SafeObject.entries,
  SafeObject.is,
  SafeArray.isArray,
  SafeArray.of,
  SafeJSON.stringify,
  SafeString,
]) {
  registerGuardedFunction(fn, { opaqueArgs: true });
}
for (const fn of [
  SafeObject.keys,
  SafeObject.values,
  SafeObject.entries,
  SafeObject.fromEntries,
  SafeArray.of,
]) {
  registerGuardedFunction(fn, { fresh: 'shallow', charge: true });
}
registerGuardedFunction(SafeArray.from, {
  fresh: 'shallow',
  charge: true,
  project: (_thisArg, [source]) => {
    if (typeof source === 'string' || Array.isArray(source)) return source.length;
    if (source instanceof Map || source instanceof Set) return source.size;
    if (source && typeof source === 'object' && 'length' in source)
      return guardArrayLength((source as any).length);
    return 0;
  },
});
// a reviver can hand back any object it reaches, so only a parse without one creates only new values
registerGuardedFunction(SafeJSON.parse, {
  fresh: ([, reviver]) => (typeof reviver === 'function' ? undefined : 'deep'),
  charge: true,
  textArgs: true,
});
registerGuardedFunction(SafeJSON.stringify, {
  run: (budget, _thisArg, [value, replacer, space]) => stringifyBounded(budget, value, replacer, space),
});
registerGuardedFunction(SafeString, {
  run: (budget, _thisArg, args) => (args.length ? budget.text(args[0]) : ''),
});
registerGuardedFunction(String.raw, {
  run: (budget, _thisArg, [template, ...substitutions]) => stringRawBounded(budget, template, substitutions),
});
registerGuardedFunction(SafeRegExp, { fresh: 'shallow', textArgs: true });

/** encoders write up to three escape characters per UTF-8 byte: reserve the exact output first */
function guardEncoder(encode: (text: string) => string, kept: string) {
  const keep = uriKeepTable(kept);
  registerGuardedFunction(encode, {
    charge: true,
    run: (budget, _thisArg, [value]) => {
      const text = budget.text(value);
      const size = encodedUriLength(text, keep);
      if (size > LIMITS.maxStringLength)
        throw new ExpressionError('String exceeds the maximum allowed length');
      budget.reserve(size);
      return encode(text);
    },
  });
}
guardEncoder(encodeURIComponent, "-_.!~*'()");
guardEncoder(encodeURI, "-_.!~*'();/?:@&=+$,#");

const safeJmespath = (data: unknown, query: string) => jmespath.search(data as any, query);
// to_string and join serialize natively: the input may not repeat shared parts beyond the budget
registerGuardedFunction(safeJmespath, {
  opaqueArgs: true,
  run: (budget, _thisArg, [data, query]) => {
    const length = jsonLength(budget, data, { callToJSON: true, isData: budget.isData });
    if (length) budget.reserve(length.repeated);
    return safeJmespath(data, query as string);
  },
});

const safeBtoa = (s: string) => btoa(s);
const safeAtob = (s: string) => atob(s);
registerGuardedFunction(safeBtoa, {
  charge: true,
  textArgs: true,
  project: (_thisArg, [s]) => Math.ceil(String(s).length / 3) * 4,
});
// these convert their arguments to strings or numbers, which joins plain arrays natively
for (const fn of [decodeURIComponent, decodeURI, safeAtob, Number.parseInt, Number.parseFloat]) {
  registerGuardedFunction(fn, { charge: true, textArgs: true });
}
registerGuardedFunction(SafeNumber, { textArgs: true });

// luxon compiles a parse format into one backtracking regex: it must pass the regex policy
for (const name of ['fromFormat', 'fromString', 'fromFormatExplain', 'fromStringExplain']) {
  const parse = (DateTime as any)[name];
  if (typeof parse !== 'function') continue;
  registerGuardedFunction(parse, {
    textArgs: true,
    run: (_budget, thisArg, args) => {
      assertSafeDateFormat(args[1], args[2]);
      return Reflect.apply(parse, thisArg, args);
    },
  });
}
registerGuardedFunction(DateTime.buildFormatParser, {
  textArgs: true,
  run: (_budget, thisArg, args) => {
    assertSafeDateFormat(args[0], args[1]);
    return Reflect.apply(DateTime.buildFormatParser, thisArg, args);
  },
});
registerGuardedFunction(DateTime.fromFormatParser, {
  textArgs: true,
  run: (_budget, thisArg, args) => {
    assertSafeFormatParser(args[1]);
    return Reflect.apply(DateTime.fromFormatParser, thisArg, args);
  },
});
// output formats are expanded token by token into objects and Intl calls: a long one costs seconds
for (const format of [
  DateTime.prototype.toFormat,
  Duration.prototype.toFormat,
  Interval.prototype.toFormat,
  DateTime.expandFormat,
] as ((...args: unknown[]) => unknown)[]) {
  registerGuardedFunction(format, {
    textArgs: true,
    run: (_budget, thisArg, args) => {
      assertDateFormatLength(args[0]);
      return Reflect.apply(format, thisArg, args);
    },
  });
}

// V8's Error.captureStackTrace adds a `stack` property to the object it is given
const captureStackTrace: unknown = Reflect.get(Error, 'captureStackTrace');
if (typeof captureStackTrace === 'function') registerGuardedFunction(captureStackTrace, { mutatesArg: 0 });

// luxon hands out its Formats presets (DateTime.DATE_SHORT, ...) as shared module-level objects
for (const name of Object.getOwnPropertyNames(DateTime)) {
  if (!/^[A-Z][A-Z_]+$/.test(name)) continue;
  const preset = (DateTime as any)[name];
  if (preset && typeof preset === 'object') deepFreeze(preset);
}

const SafeMath = freezeCopy(
  Math,
  Object.getOwnPropertyNames(Math).filter((k) => k !== 'constructor'),
);
for (const fn of Object.values(SafeMath)) {
  if (typeof fn === 'function') registerGuardedFunction(fn, { textArgs: true });
}

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
  btoa: safeBtoa,
  atob: safeAtob,
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  $jmespath: safeJmespath,
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
