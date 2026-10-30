/**
 * Data transformation functions available as methods inside expressions, e.g.
 * `{{ $json.email.isEmail() }}`, `{{ $json.tags.unique().join(', ') }}`.
 *
 * They are resolved by the interpreter only when the native method does not exist, so they
 * never patch built-in prototypes.
 */
import { DateTime, Duration } from 'luxon';
import { ExpressionError } from '../errors';
import { LIMITS } from './interpreter';

type Fn = (target: any, ...args: any[]) => unknown;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .filter(Boolean);
}

function toDateTime(value: unknown, format?: string): DateTime {
  if (DateTime.isDateTime(value)) return value;
  if (value instanceof Date) return DateTime.fromJSDate(value);
  if (typeof value === 'number') {
    // seconds vs milliseconds heuristic
    return value < 1e11 ? DateTime.fromSeconds(value) : DateTime.fromMillis(value);
  }
  const s = String(value);
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
  isEmail: (s: string) => EMAIL_RE.test(s),
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
  extractEmail: (s: string) => s.match(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"',;]+/)?.[0],
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
  removeTags: (s: string) => s.replace(/<[^>]*>/g, ''),
  removeMarkdown: (s: string) =>
    s
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
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
    if (!(size > 0)) throw new ExpressionError('chunk size must be > 0');
    const out: unknown[][] = [];
    for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size));
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
    Object.fromEntries(a.map((v) => [String((v as any)?.[keyField]), (v as any)?.[valueField]])),
  sortBy: (a: unknown[], field: string, direction: 'asc' | 'desc' = 'asc') =>
    [...a].sort((x, y) => {
      const vx = (x as any)?.[field];
      const vy = (y as any)?.[field];
      const c = vx < vy ? -1 : vx > vy ? 1 : 0;
      return direction === 'desc' ? -c : c;
    }),
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
  urlEncode: (o: Record<string, unknown>) =>
    new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)] as [string, string])).toString(),
};

const booleanExtensions: Record<string, Fn> = {
  toNumber: (b: boolean) => (b ? 1 : 0),
  isEmpty: () => false,
};

const dateExtensions: Record<string, Fn> = {
  format: (d: DateTime, fmt: string) => d.toFormat(fmt),
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

/** Extension lookup used by the interpreter for calls the value does not support natively. */
export function findExtension(target: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  let table: Record<string, Fn> | undefined;
  if (typeof target === 'string') table = stringExtensions;
  else if (typeof target === 'number') table = numberExtensions;
  else if (typeof target === 'boolean') table = booleanExtensions;
  else if (Array.isArray(target)) table = arrayExtensions;
  else if (DateTime.isDateTime(target)) table = dateExtensions;
  else if (target instanceof Date) {
    const fn = dateExtensions[name];
    return fn ? (t: unknown, ...args: unknown[]) => fn(DateTime.fromJSDate(t as Date), ...args) : undefined;
  } else if (target && typeof target === 'object') {
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
