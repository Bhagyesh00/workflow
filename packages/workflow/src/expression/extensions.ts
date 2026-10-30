/**
 * Data transformation functions available as methods inside expressions, e.g.
 * `{{ $json.email.isEmail() }}`, `{{ $json.tags.unique().join(', ') }}`.
 *
 * They are resolved by the interpreter only when the native method does not exist, so they
 * never patch built-in prototypes.
 */
import { DateTime, type DateTimeOptions, Duration } from 'luxon';
import { ExpressionError } from '../errors';
import { isPlainArray, jsonLength, type NativeBudget, stringifyBounded } from './bounded';
import { LIMITS, type NativeGuard, registerGuardedFunction } from './interpreter';
import { assertSafeRegExp } from './regex';

type Fn = (target: any, ...args: any[]) => unknown;

/*
 * The scans below run on input of any length in one native call the deadline cannot interrupt, so
 * each is linear: no unanchored pattern that rescans the rest of the input from every position.
 */
const EMAIL_PARTS = /^[^\s@]+@[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_LOCAL_CHAR = /[^\s@<>"']/;
const EMAIL_DOMAIN = /[^\s@<>"']+\.[^\s@<>"',;]+/y;

/** same result as /^[^\s@]+@[^\s@]+\.[^\s@]+$/ without backtracking over runs of dots */
function isEmail(s: string): boolean {
  if (!EMAIL_PARTS.test(s)) return false;
  const domain = s.slice(s.indexOf('@') + 1);
  return domain.lastIndexOf('.', domain.length - 2) >= 1;
}

/** first match of /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"',;]+/, found from each '@' instead of each position */
function extractEmail(s: string): string | undefined {
  for (let at = s.indexOf('@'); at !== -1; at = s.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL_CHAR.test(s[start - 1])) start--;
    if (start === at) continue;
    EMAIL_DOMAIN.lastIndex = at + 1;
    const domain = EMAIL_DOMAIN.exec(s);
    if (domain) return s.slice(start, at + 1) + domain[0];
  }
  return undefined;
}

/** s.replace(/<[^>]*>/g, '') in one pass */
function removeTags(s: string): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const open = s.indexOf('<', from);
    if (open === -1) break;
    const close = s.indexOf('>', open + 1);
    if (close === -1) break;
    parts.push(s.slice(from, open));
    from = close + 1;
  }
  parts.push(s.slice(from));
  return parts.join('');
}

/**
 * s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'), or the image form /!\[([^\]]*)\]\([^)]*\)/g, in one
 * pass: every opening bracket before the same `]` shares its outcome, so the scan never goes back.
 */
function replaceLinks(s: string, image: boolean): string {
  const opener = image ? '![' : '[';
  const parts: string[] = [];
  let copied = 0;
  let from = 0;
  for (;;) {
    const start = s.indexOf(opener, from);
    if (start === -1) break;
    const textStart = start + opener.length;
    const close = s.indexOf(']', textStart);
    if (close === -1) break;
    if ((!image && close === textStart) || s[close + 1] !== '(') {
      from = close + 1;
      continue;
    }
    const end = s.indexOf(')', close + 2);
    if (end === -1) break;
    parts.push(s.slice(copied, start), s.slice(textStart, close));
    copied = from = end + 1;
  }
  parts.push(s.slice(copied));
  return parts.join('');
}

/** longest format luxon is asked to parse with or expand; real formats are a few dozen characters */
const MAX_DATE_FORMAT_LENGTH = 256;

/** the regex luxon built for a format parser must pass the policy for user patterns */
export function assertSafeFormatParser(parser: unknown): void {
  const regex = (parser as { regex?: unknown } | null | undefined)?.regex;
  if (regex instanceof RegExp) assertSafeRegExp(regex.source, regex.flags);
}

/** luxon expands a format token by token (objects, Intl calls, one regex group each): keep it short */
export function assertDateFormatLength(format: unknown): string {
  const text = String(format);
  if (text.length > MAX_DATE_FORMAT_LENGTH) {
    throw new ExpressionError(`Date format is longer than ${MAX_DATE_FORMAT_LENGTH} characters`);
  }
  return text;
}

/** luxon turns a parse format into one regex (`dH` becomes `(\d{1,2})(\d{1,2})`): check it before parsing */
export function assertSafeDateFormat(format: unknown, options?: unknown): void {
  const text = assertDateFormatLength(format);
  const opts = options !== null && typeof options === 'object' ? (options as DateTimeOptions) : {};
  assertSafeFormatParser(DateTime.buildFormatParser(text, opts));
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .filter(Boolean);
}

function smartJoin(a: unknown[], keyField: string, valueField: string, text: (value: unknown) => string) {
  return Object.fromEntries(a.map((v) => [text((v as any)?.[keyField]), (v as any)?.[valueField]]));
}

/** sorted copy by one field, undefined items last; `key` turns a field value into what is compared */
function sortBy(a: unknown[], field: string, direction: string, key: (value: unknown) => unknown): unknown[] {
  const keyed: [any, unknown][] = [];
  let undefinedCount = 0;
  for (const v of a) {
    if (v === undefined) undefinedCount++;
    else keyed.push([key((v as any)?.[field]), v]);
  }
  keyed.sort(([x], [y]) => {
    const c = x < y ? -1 : x > y ? 1 : 0;
    return direction === 'desc' ? -c : c;
  });
  const out = keyed.map(([, v]) => v);
  for (let i = 0; i < undefinedCount; i++) out.push(undefined);
  return out;
}

function urlEncodeObject(o: Record<string, unknown>, text: (value: unknown) => string): string {
  return new URLSearchParams(Object.entries(o).map(([k, v]) => [k, text(v)] as [string, string])).toString();
}

function toDateTime(value: unknown, format?: string): DateTime {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === 'number') {
    // seconds vs milliseconds heuristic
    return value < 1e11 ? DateTime.fromSeconds(value) : DateTime.fromMillis(value);
  }
  const s = String(value);
  if (format) assertSafeDateFormat(format);
  const dt = format
    ? DateTime.fromFormat(s, format)
    : ([DateTime.fromISO(s), DateTime.fromRFC2822(s), DateTime.fromHTTP(s), DateTime.fromSQL(s)].find(
        (d) => d.isValid,
      ) ?? DateTime.fromJSDate(new Date(s)));
  if (!dt.isValid) throw new ExpressionError(`Cannot convert "${s}" to a date`);
  return dt;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToUtf8(s: string): string {
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const stringExtensions: Record<string, Fn> = {
  isEmpty: (s: string) => s.length === 0,
  isNotEmpty: (s: string) => s.length > 0,
  isBlank: (s: string) => s.trim().length === 0,
  isEmail: (s: string) => isEmail(s),
  isUrl: (s: string) => URL_RE.test(s),
  isDomain: (s: string) => DOMAIN_RE.test(s),
  isNumeric: (s: string) => s.trim() !== '' && !Number.isNaN(Number(s)),
  toNumber: (s: string) => {
    const n = Number(s);
    if (Number.isNaN(n)) throw new ExpressionError(`Cannot convert "${s}" to a number`);
    return n;
  },
  toInt: (s: string) => Number.parseInt(s, 10),
  toFloat: (s: string) => Number.parseFloat(s),
  toBoolean: (s: string) => !['false', '0', 'no', 'n', 'off', ''].includes(s.trim().toLowerCase()),
  toDateTime: (s: string, format?: string) => toDateTime(s, format),
  toTitleCase: (s: string) =>
    s.toLowerCase().replace(/(^|[\s\-_])(\p{L})/gu, (_m, p, c) => p + c.toUpperCase()),
  toSentenceCase: (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  toSnakeCase: (s: string) =>
    words(s)
      .map((w) => w.toLowerCase())
      .join('_'),
  toKebabCase: (s: string) =>
    words(s)
      .map((w) => w.toLowerCase())
      .join('-'),
  toCamelCase: (s: string) =>
    words(s)
      .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(''),
  capitalize: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
  extractEmail: (s: string) => extractEmail(s),
  extractDomain: (s: string) => {
    const email = s.match(/@([^\s@>]+)/);
    if (email) return email[1];
    try {
      return new URL(s.includes('://') ? s : `https://${s}`).hostname;
    } catch {
      return undefined;
    }
  },
  extractUrl: (s: string) => s.match(/https?:\/\/[^\s"'<>]+/)?.[0],
  extractUrlPath: (s: string) => {
    try {
      return new URL(s).pathname;
    } catch {
      return undefined;
    }
  },
  removeTags: (s: string) => removeTags(s),
  removeMarkdown: (s: string) =>
    replaceLinks(replaceLinks(s.replace(/```[\s\S]*?```/g, '').replace(/`([^`]+)`/g, '$1'), true), false)
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2'),
  replaceSpecialChars: (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, ''),
  urlEncode: (s: string, all = false) => (all ? encodeURIComponent(s) : encodeURI(s)),
  urlDecode: (s: string, all = false) => (all ? decodeURIComponent(s) : decodeURI(s)),
  base64Encode: (s: string) => utf8ToBase64(s),
  base64Decode: (s: string) => base64ToUtf8(s),
  quote: (s: string, mark = '"') => `${mark}${s.replaceAll(mark, `\\${mark}`)}${mark}`,
  parseJson: (s: string) => {
    try {
      return JSON.parse(s);
    } catch (e) {
      throw new ExpressionError(`Invalid JSON: ${(e as Error).message}`);
    }
  },
  toJsonString: (s: string) => JSON.stringify(s),
  length: (s: string) => s.length,
};

const numberExtensions: Record<string, Fn> = {
  round: (n: number, decimals = 0) => {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
  },
  floor: (n: number) => Math.floor(n),
  ceil: (n: number) => Math.ceil(n),
  abs: (n: number) => Math.abs(n),
  isEven: (n: number) => n % 2 === 0,
  isOdd: (n: number) => Math.abs(n % 2) === 1,
  isInteger: (n: number) => Number.isInteger(n),
  isEmpty: () => false,
  toBoolean: (n: number) => n !== 0,
  toDateTime: (n: number, unit?: 'ms' | 's') =>
    unit === 'ms' ? DateTime.fromMillis(n) : unit === 's' ? DateTime.fromSeconds(n) : toDateTime(n),
  format: (n: number, locale?: string, options?: Intl.NumberFormatOptions) =>
    new Intl.NumberFormat(locale, options).format(n),
};

function plainKeys(o: object): string[] {
  return Object.keys(o);
}

const arrayExtensions: Record<string, Fn> = {
  first: (a: unknown[]) => a[0],
  last: (a: unknown[]) => a[a.length - 1],
  isEmpty: (a: unknown[]) => a.length === 0,
  isNotEmpty: (a: unknown[]) => a.length > 0,
  sum: (a: unknown[]) => a.reduce<number>((s, v) => s + Number(v), 0),
  min: (a: unknown[]) => Math.min(...a.map(Number)),
  max: (a: unknown[]) => Math.max(...a.map(Number)),
  average: (a: unknown[]) => (a.length ? a.reduce<number>((s, v) => s + Number(v), 0) / a.length : 0),
  unique: (a: unknown[], ...fields: string[]) => {
    if (!fields.length) {
      const seen = new Set<string>();
      return a.filter((v) => {
        const k = typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${String(v)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    const seen = new Set<string>();
    return a.filter((v) => {
      const k = JSON.stringify(fields.map((f) => (v as any)?.[f]));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },
  removeDuplicates: (a: unknown[], ...fields: string[]) => arrayExtensions.unique(a, ...fields),
  compact: (a: unknown[]) => a.filter((v) => v !== null && v !== undefined && v !== ''),
  chunk: (a: unknown[], size: number) => {
    // a fractional size would loop (and allocate) far more often than there are elements
    const step = Math.floor(Number(size));
    if (!(step >= 1)) throw new ExpressionError('chunk size must be a positive integer');
    const out: unknown[][] = [];
    for (let i = 0; i < a.length; i += step) out.push(a.slice(i, i + step));
    return out;
  },
  pluck: (a: unknown[], ...fields: string[]) =>
    a.map((v) => {
      if (fields.length === 1) return (v as any)?.[fields[0]];
      return Object.fromEntries(fields.map((f) => [f, (v as any)?.[f]]));
    }),
  difference: (a: unknown[], b: unknown[]) => {
    const keys = new Set(b.map((v) => JSON.stringify(v)));
    return a.filter((v) => !keys.has(JSON.stringify(v)));
  },
  intersection: (a: unknown[], b: unknown[]) => {
    const keys = new Set(b.map((v) => JSON.stringify(v)));
    return arrayExtensions.unique(a.filter((v) => keys.has(JSON.stringify(v))));
  },
  union: (a: unknown[], b: unknown[]) => arrayExtensions.unique([...a, ...b]),
  append: (a: unknown[], ...values: unknown[]) => [...a, ...values],
  randomItem: (a: unknown[]) => a[Math.floor(Math.random() * a.length)],
  smartJoin: (a: unknown[], keyField: string, valueField: string) =>
    smartJoin(a, keyField, valueField, String),
  sortBy: (a: unknown[], field: string, direction: 'asc' | 'desc' = 'asc') =>
    sortBy(a, field, direction, (v) => v),
  toJsonString: (a: unknown[]) => JSON.stringify(a),
  renameKeys: (a: unknown[], from: string, to: string) =>
    a.map((v) => {
      if (!v || typeof v !== 'object') return v;
      const { [from]: value, ...rest } = v as Record<string, unknown>;
      return { ...rest, [to]: value };
    }),
};

const objectExtensions: Record<string, Fn> = {
  isEmpty: (o: object) => plainKeys(o).length === 0,
  isNotEmpty: (o: object) => plainKeys(o).length > 0,
  keys: (o: object) => plainKeys(o),
  values: (o: object) => Object.values(o),
  entries: (o: object) => Object.entries(o),
  hasField: (o: object, field: string) => Object.hasOwn(o, field),
  removeField: (o: Record<string, unknown>, field: string) => {
    const { [field]: _removed, ...rest } = o;
    return rest;
  },
  removeFieldsContaining: (o: Record<string, unknown>, text: string) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => !(typeof v === 'string' && v.includes(text)))),
  keepFieldsContaining: (o: Record<string, unknown>, text: string) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.includes(text))),
  compact: (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')),
  merge: (o: Record<string, unknown>, other: Record<string, unknown>) => ({ ...other, ...o }),
  toJsonString: (o: object) => JSON.stringify(o),
  urlEncode: (o: Record<string, unknown>) => urlEncodeObject(o, String),
};

const booleanExtensions: Record<string, Fn> = {
  toNumber: (b: boolean) => (b ? 1 : 0),
  isEmpty: () => false,
};

const dateExtensions: Record<string, Fn> = {
  format: (d: DateTime, fmt: string) => {
    assertDateFormatLength(fmt);
    return d.toFormat(fmt);
  },
  toDateTime: (d: DateTime) => d,
  beginningOf: (d: DateTime, unit: Parameters<DateTime['startOf']>[0] = 'day') => d.startOf(unit),
  endOfMonth: (d: DateTime) => d.endOf('month'),
  isWeekend: (d: DateTime) => d.weekday >= 6,
  isBetween: (d: DateTime, a: unknown, b: unknown) => {
    const x = toDateTime(a).toMillis();
    const y = toDateTime(b).toMillis();
    const v = d.toMillis();
    return v > Math.min(x, y) && v < Math.max(x, y);
  },
  extract: (d: DateTime, part: 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second' = 'day') =>
    part === 'week' ? d.weekNumber : d.get(part),
  diffTo: (d: DateTime, other: unknown, unit: Parameters<DateTime['diff']>[1] = 'days') =>
    d.diff(toDateTime(other), unit).as(Array.isArray(unit) ? unit[0] : (unit as any)),
  isInLast: (d: DateTime, n = 0, unit: string = 'minutes') =>
    d >= DateTime.now().minus(Duration.fromObject({ [unit]: n })) && d <= DateTime.now(),
};

// extensions that build a new array or object: the expression may change the result (not its elements)
for (const fn of [
  ...['unique', 'removeDuplicates', 'compact', 'chunk', 'pluck', 'difference', 'intersection', 'union'].map(
    (name) => arrayExtensions[name],
  ),
  ...['append', 'smartJoin', 'sortBy', 'renameKeys'].map((name) => arrayExtensions[name]),
  ...['keys', 'values', 'entries', 'removeField', 'removeFieldsContaining', 'keepFieldsContaining'].map(
    (name) => objectExtensions[name],
  ),
  objectExtensions.compact,
  objectExtensions.merge,
]) {
  registerGuardedFunction(fn, { fresh: 'shallow' });
}
// JSON.parse without a reviver: every nested object is new as well
registerGuardedFunction(stringExtensions.parseJson, { fresh: 'deep' });

/*
 * Extensions run natively, so conversions they make (Number(), String(), comparisons, property keys,
 * JSON.stringify) would turn a nested or repeated array into a huge string outside the budget. Their
 * guards convert plain arrays under the budget first (`textArgs` for arguments, `run` for the target's
 * items) and charge JSON output before it is built.
 */

/** plain arrays among the items become their text under the budget, as Number() or `<` would */
function textItems(budget: NativeBudget, items: unknown[]): unknown[] {
  return items.some(isPlainArray) ? items.map((v) => (isPlainArray(v) ? budget.text(v) : v)) : items;
}

function textKey(budget: NativeBudget): (value: unknown) => unknown {
  return (value) => (isPlainArray(value) ? budget.text(value) : value);
}

/** the extension calls JSON.stringify on these values (or their items): charge the output first */
function chargingJson(fn: Fn, jsonArgs: number): NativeGuard['run'] {
  return (budget, target, args) => {
    const length = jsonLength(budget, [target, ...args.slice(0, jsonArgs)], { callToJSON: true });
    if (length) budget.charge(length.total);
    return fn(target, ...args);
  };
}

function numericItems(fn: Fn): NativeGuard['run'] {
  return (budget, target, args) => fn(textItems(budget, target as unknown[]), ...args);
}

const toJsonGuard: NativeGuard = {
  run: (budget, target) => stringifyBounded(budget, target, undefined, undefined),
};

for (const fn of Object.values(stringExtensions)) registerGuardedFunction(fn, { textArgs: true });
registerGuardedFunction(stringExtensions.toJsonString, toJsonGuard);
registerGuardedFunction(numberExtensions.round, { textArgs: true });
registerGuardedFunction(numberExtensions.toDateTime, { textArgs: true });

for (const name of ['unique', 'removeDuplicates']) {
  registerGuardedFunction(arrayExtensions[name], {
    textArgs: true,
    charge: true,
    run: chargingJson(arrayExtensions[name], 0),
  });
}
for (const name of ['difference', 'intersection', 'union']) {
  registerGuardedFunction(arrayExtensions[name], {
    charge: true,
    run: chargingJson(arrayExtensions[name], 1),
  });
}
for (const name of ['sum', 'min', 'max', 'average']) {
  registerGuardedFunction(arrayExtensions[name], { run: numericItems(arrayExtensions[name]) });
}
for (const name of ['chunk', 'pluck', 'renameKeys'])
  registerGuardedFunction(arrayExtensions[name], { textArgs: true });
registerGuardedFunction(arrayExtensions.smartJoin, {
  textArgs: true,
  run: (budget, a, [keyField, valueField]) =>
    smartJoin(a as unknown[], keyField as string, valueField as string, (v) => budget.text(v)),
});
registerGuardedFunction(arrayExtensions.sortBy, {
  textArgs: true,
  charge: true,
  run: (budget, a, [field, direction]) =>
    sortBy(a as unknown[], field as string, direction as string, textKey(budget)),
});
registerGuardedFunction(arrayExtensions.toJsonString, toJsonGuard);

for (const name of ['hasField', 'removeField', 'removeFieldsContaining', 'keepFieldsContaining']) {
  registerGuardedFunction(objectExtensions[name], { textArgs: true });
}
registerGuardedFunction(objectExtensions.toJsonString, toJsonGuard);
registerGuardedFunction(objectExtensions.urlEncode, {
  charge: true,
  run: (budget, o) => urlEncodeObject(o as Record<string, unknown>, (v) => budget.text(v)),
});

const dateGuards: Record<string, NativeGuard> = {
  format: { textArgs: true },
  beginningOf: { textArgs: true },
  isBetween: { textArgs: true },
  extract: { textArgs: true },
  isInLast: { textArgs: true },
  // the unit may be a list of units; only the other date is converted
  diffTo: {
    run: (budget, d, [other, unit]) => dateExtensions.diffTo(d, textKey(budget)(other), unit),
  },
};
/** the date extensions for JS Date values, guarded the same way */
const jsDateExtensions: Record<string, Fn> = {};
const toLuxon = (t: unknown) => DateTime.fromJSDate(t as Date);
for (const [name, fn] of Object.entries(dateExtensions)) {
  jsDateExtensions[name] = (t: unknown, ...args: unknown[]) => fn(toLuxon(t), ...args);
  const guard = dateGuards[name];
  if (!guard) continue;
  registerGuardedFunction(fn, guard);
  const run = guard.run;
  registerGuardedFunction(jsDateExtensions[name], {
    ...guard,
    run: run && ((budget, t, args) => run(budget, toLuxon(t), args)),
  });
}

/** Extension lookup used by the interpreter for calls the value does not support natively. */
export function findExtension(target: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  let table: Record<string, Fn> | undefined;
  if (typeof target === 'string') table = stringExtensions;
  else if (typeof target === 'number') table = numberExtensions;
  else if (typeof target === 'boolean') table = booleanExtensions;
  else if (Array.isArray(target)) table = arrayExtensions;
  else if (DateTime.isDateTime(target)) table = dateExtensions;
  else if (target instanceof Date) table = jsDateExtensions;
  else if (target && typeof target === 'object') {
    const proto = Object.getPrototypeOf(target);
    if (proto === Object.prototype || proto === null) table = objectExtensions;
  }
  if (!table || !Object.hasOwn(table, name)) return undefined;
  return table[name] as (...args: unknown[]) => unknown;
}

/** names listed in the editor autocomplete */
export const extensionNames = {
  string: Object.keys(stringExtensions),
  number: Object.keys(numberExtensions),
  array: Object.keys(arrayExtensions),
  object: Object.keys(objectExtensions),
  boolean: Object.keys(booleanExtensions),
  date: Object.keys(dateExtensions),
};

export { toDateTime };

export function guardArrayLength(length: unknown): number {
  const n = Number(length);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > LIMITS.maxArrayLength) throw new ExpressionError('Array exceeds the maximum allowed length');
  return n;
}
