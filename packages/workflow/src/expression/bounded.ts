/**
 * Budget-aware versions of natives whose cost does not show in their arguments: converting nested
 * or repeated arrays to strings, JSON.stringify, flat, String.raw, sorts without a comparator. A
 * shared sub-array or object is counted every time it appears, as the native would serialize it, so
 * a structure that doubles at each level is charged at its full size before anything that large is
 * allocated. Every walk checks the deadline as it goes.
 */
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError } from '../errors';

/** what a guarded native may use from the running evaluation */
export interface NativeBudget {
  /** throws unless `size` more characters or array elements fit in what is left of the budget */
  reserve(size: number): void;
  /** counts `size` characters or array elements as allocated */
  charge(size: number): void;
  /** throws once the evaluation is past its deadline */
  checkDeadline(): void;
  /** String(value), with plain arrays joined here so nested and repeated parts are charged first */
  text(value: unknown): string;
  /** the object is input data: sharing inside it is the host's own */
  isData(value: object): boolean;
}

const arrayJoin = Array.prototype.join;
const arrayToString = Array.prototype.toString;
const arrayToLocaleString = Array.prototype.toLocaleString;
const objectValueOf = Object.prototype.valueOf;

/** an array whose string form is the built-in join: no own join, toString, valueOf or toPrimitive */
export function isPlainArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.join === arrayJoin &&
    value.toString === arrayToString &&
    value.valueOf === objectValueOf &&
    (value as any)[Symbol.toPrimitive] === undefined
  );
}

function toLength(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * Array#join, or Array#toLocaleString when `locale` holds its arguments, for an array or array-like.
 * Nested plain arrays are joined here too (memoized, so a shared sub-array is built once) and every
 * string they produce is charged; cycles become '' like the native.
 */
export function joinBounded(
  budget: NativeBudget,
  list: ArrayLike<unknown>,
  separator: string,
  locale?: unknown[],
): string {
  const memo = new Map<object, string>();
  const active = new Set<object>();
  const convert = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (locale) {
      if (Array.isArray(value) && value.toLocaleString === arrayToLocaleString) return join(value, ',');
      return `${(value as { toLocaleString(...args: unknown[]): unknown }).toLocaleString(...locale)}`;
    }
    return isPlainArray(value) ? join(value, ',') : `${value}`;
  };
  const join = (items: ArrayLike<unknown>, sep: string): string => {
    const known = memo.get(items);
    if (known !== undefined) return known;
    if (active.has(items)) return '';
    active.add(items);
    const length = Array.isArray(items) ? items.length : toLength(items.length);
    let size = sep.length * Math.max(length - 1, 0);
    budget.reserve(size);
    const parts: string[] = [];
    for (let i = 0; i < length; i++) {
      if ((i & 1023) === 1023) budget.checkDeadline();
      const text = convert(items[i]);
      size += text.length;
      budget.reserve(size);
      parts.push(text);
    }
    active.delete(items);
    const out = parts.join(sep);
    budget.charge(out.length);
    memo.set(items, out);
    return out;
  };
  return join(list, separator);
}

/**
 * Array#sort (`inPlace`) or Array#toSorted without a comparator. The native converts both elements
 * to strings on every comparison, so a nested array would be joined O(n log n) times; here each
 * element is converted once, under the budget, and the order is the same: by UTF-16 code units,
 * stable, undefined last, holes (sort only) after that.
 */
export function sortByText(budget: NativeBudget, list: unknown[], inPlace: boolean): unknown[] {
  const keyed: [string, unknown][] = [];
  let undefinedCount = 0;
  for (let i = 0; i < list.length; i++) {
    if ((i & 1023) === 1023) budget.checkDeadline();
    if (inPlace && !(i in list)) continue;
    const value = list[i];
    if (value === undefined) undefinedCount++;
    else keyed.push([budget.text(value), value]);
  }
  keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = inPlace ? list : new Array<unknown>(list.length);
  let i = 0;
  for (const [, value] of keyed) out[i++] = value;
  for (let n = 0; n < undefinedCount; n++) out[i++] = undefined;
  for (; inPlace && i < list.length; i++) delete out[i];
  return out;
}

/** String.raw: each raw segment and substitution is converted and charged before they are joined */
export function stringRawBounded(budget: NativeBudget, template: unknown, substitutions: unknown[]): string {
  const raw = (template as { raw?: unknown } | null | undefined)?.raw as
    | ArrayLike<unknown>
    | null
    | undefined;
  // let the native throw its TypeError for a missing template or raw array
  if (raw === null || raw === undefined) return String.raw(template as TemplateStringsArray);
  const length = toLength(raw.length);
  const parts: string[] = [];
  let size = 0;
  for (let i = 0; i < length; i++) {
    if ((i & 1023) === 1023) budget.checkDeadline();
    const segment = budget.text(raw[i]);
    const substitution = i + 1 < length && i < substitutions.length ? budget.text(substitutions[i]) : '';
    size += segment.length + substitution.length;
    budget.reserve(size);
    parts.push(segment, substitution);
  }
  const out = parts.join('');
  budget.charge(out.length);
  return out;
}

/** objects whose contents natives walk when they convert or copy them */
function isContainer(value: object): boolean {
  if (Array.isArray(value) || value instanceof Map || value instanceof Set) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A native may turn any part of its argument into a string, a number or a property key (Array#at,
 * Object.fromEntries, luxon's set, Intl locale lists, ...), and each conversion expands a nested array
 * in full. The parts `value` repeats (arrays, plain objects, Maps and Sets reached again, long strings
 * seen again) are reserved against the budget before the native runs, so a structure that doubles at
 * each level is refused while it is still small. Input data at the top is not walked; below input
 * data, repeats are the host's own sharing.
 */
export function reserveRepeats(budget: NativeBudget, value: object): void {
  if (!isContainer(value) || budget.isData(value) || isFlat(value)) return;
  const sizes = new Map<object, number>();
  const seenStrings = new Set<string>();
  let repeated = 0;
  let steps = 0;
  const measure = (v: unknown, inData: boolean): number => {
    if (typeof v === 'string') {
      if (v.length > 1024 && !inData) {
        if (seenStrings.has(v)) {
          repeated += v.length;
          budget.reserve(repeated);
        } else seenStrings.add(v);
      }
      return v.length;
    }
    if (v === null || typeof v !== 'object' || !isContainer(v)) return 1;
    const known = sizes.get(v);
    if (known !== undefined) {
      if (!inData) {
        repeated += known;
        budget.reserve(repeated);
      }
      return known;
    }
    if ((++steps & 1023) === 0) budget.checkDeadline();
    // a cycle counts once, as the natives stop or throw there
    sizes.set(v, 1);
    const below = inData || budget.isData(v);
    let size = 1;
    for (const item of collectionItems(v)) size += measure(item, below);
    sizes.set(v, size);
    return size;
  };
  measure(value, false);
}

/** holds only primitives and short strings: nothing in it can repeat (the common case, no bookkeeping) */
function isFlat(value: object): boolean {
  for (const item of collectionItems(value)) {
    if ((item !== null && typeof item === 'object') || (typeof item === 'string' && item.length > 1024))
      return false;
  }
  return true;
}

function collectionItems(value: object): Iterable<unknown> {
  if (Array.isArray(value)) return value;
  if (value instanceof Map) return [...value.keys(), ...value.values()];
  if (value instanceof Set) return value;
  return Object.values(value);
}

/** element count of `list.flat(depth)`, shared sub-arrays counted every time; stops counting past `limit` */
export function flatLength(budget: NativeBudget, list: unknown[], depth: number, limit: number): number {
  const memo = new Map<unknown[], Map<number, number>>();
  const active = new Set<unknown[]>();
  let steps = 0;
  const count = (items: unknown[], d: number): number => {
    const known = memo.get(items)?.get(d);
    if (known !== undefined) return known;
    // flattening a cycle without a depth limit never ends natively
    if (d === Number.POSITIVE_INFINITY && active.has(items)) return Number.POSITIVE_INFINITY;
    active.add(items);
    let n = 0;
    for (let i = 0; i < items.length && n <= limit; i++) {
      if ((++steps & 1023) === 0) budget.checkDeadline();
      if (!(i in items)) continue;
      const value = items[i];
      n += d >= 1 && Array.isArray(value) ? count(value, d - 1) : 1;
    }
    active.delete(items);
    let byDepth = memo.get(items);
    if (!byDepth) memo.set(items, (byDepth = new Map()));
    byDepth.set(d, n);
    return n;
  };
  return count(list, depth);
}

/** flat's depth argument: ToIntegerOrInfinity with undefined meaning 1 */
export function flatDepth(value: unknown): number {
  if (value === undefined) return 1;
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  return n === Number.POSITIVE_INFINITY ? n : Math.trunc(n);
}

/** toJSON methods that only read their receiver and return a short string */
const PLAIN_TO_JSON = new Set<unknown>([
  Date.prototype.toJSON,
  DateTime.prototype.toJSON,
  Duration.prototype.toJSON,
  (Interval.prototype as unknown as { toJSON(): string }).toJSON,
  URL.prototype.toJSON,
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON escapes exactly these control characters
const NEEDS_ESCAPE = /["\\\u0000-\u001f\ud800-\udfff]/;

/** length of JSON.stringify(text), escapes included */
export function quotedLength(text: string): number {
  if (!NEEDS_ESCAPE.test(text)) return text.length + 2;
  let n = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d)
      n += 2;
    else if (c < 0x20) n += 6;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 2;
        i++;
      } else n += 6;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 1;
  }
  return n;
}

/** size of one serialized value: characters, plus newlines and their relative depth for indentation */
interface JsonShape {
  chars: number;
  lines: number;
  depths: number;
}

const NULL_SHAPE: JsonShape = { chars: 4, lines: 0, depths: 0 };

/** thrown inside the walk when a toJSON the walk cannot run decides the output */
const DYNAMIC = Symbol('dynamic');

export interface JsonLength {
  /** characters of the output */
  total: number;
  /** characters coming from objects and long strings that appear more than once */
  repeated: number;
}

/**
 * Characters JSON.stringify(value, keys, gap) produces, with shared objects and arrays counted every
 * time they appear. Returns undefined when a toJSON that is not a known plain one decides the output,
 * unless `callToJSON` is set (the walk then runs it, as the serializer will). Objects `skip` accepts
 * count as `null`. Below an object `isData` accepts, repeats are the host's own sharing and do not
 * count as `repeated`; reaching that object twice from outside still does.
 */
export function jsonLength(
  budget: NativeBudget,
  value: unknown,
  options: {
    keys?: string[];
    gap?: number;
    callToJSON?: boolean;
    skip?: (object: object) => boolean;
    isData?: (object: object) => boolean;
  } = {},
): JsonLength | undefined {
  const { keys, gap = 0, callToJSON = false, skip, isData } = options;
  const memo = new Map<object, JsonShape>();
  const active = new Set<object>();
  const seenStrings = new Set<string>();
  let repeated = 0;
  let steps = 0;

  const measure = (input: unknown, key: string, inData: boolean): JsonShape | undefined => {
    if ((++steps & 1023) === 0) budget.checkDeadline();
    let v = input;
    if (v !== null && typeof v === 'object' && skip?.(v)) return NULL_SHAPE;
    if ((v !== null && typeof v === 'object') || typeof v === 'bigint') {
      const toJSON = (v as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') {
        if (!callToJSON && !PLAIN_TO_JSON.has(toJSON)) throw DYNAMIC;
        v = toJSON.call(v, key);
      }
    }
    switch (typeof v) {
      case 'string': {
        const chars = quotedLength(v);
        if (v.length > 1024 && !inData) {
          if (seenStrings.has(v)) repeated += chars;
          else seenStrings.add(v);
        }
        return { chars, lines: 0, depths: 0 };
      }
      case 'number':
        return { chars: Number.isFinite(v) ? String(v).length : 4, lines: 0, depths: 0 };
      case 'boolean':
        return { chars: v ? 4 : 5, lines: 0, depths: 0 };
      case 'bigint':
        // the serializer throws a TypeError for it
        return { chars: 0, lines: 0, depths: 0 };
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }
    if (v === null) return NULL_SHAPE;
    const object = v as object;
    const known = memo.get(object);
    if (known) {
      if (!inData) repeated += known.chars;
      return known;
    }
    // the serializer throws on a cycle
    if (active.has(object)) return NULL_SHAPE;
    active.add(object);
    const childrenInData = inData || (isData?.(object) ?? false);
    let chars = 2;
    let lines = 0;
    let depths = 0;
    let count = 0;
    const add = (shape: JsonShape, keyChars: number) => {
      chars += shape.chars + keyChars;
      lines += shape.lines + 1;
      depths += shape.depths + shape.lines + 1;
      count++;
    };
    if (Array.isArray(object)) {
      for (let i = 0; i < object.length; i++) {
        add(measure(object[i], String(i), childrenInData) ?? NULL_SHAPE, 0);
      }
    } else {
      for (const k of keys ?? Object.keys(object)) {
        const shape = measure((object as Record<string, unknown>)[k], k, childrenInData);
        if (shape) add(shape, quotedLength(k) + (gap ? 2 : 1));
      }
    }
    active.delete(object);
    if (count > 0) chars += count - 1;
    const shape: JsonShape =
      gap && count > 0
        ? { chars: chars + count + 1, lines: lines + 1, depths }
        : { chars, lines: 0, depths: 0 };
    memo.set(object, shape);
    return shape;
  };

  try {
    const shape = measure(value, '', false);
    if (!shape) return { total: 0, repeated };
    return { total: shape.chars + gap * shape.depths, repeated };
  } catch (error) {
    if (error === DYNAMIC) return undefined;
    throw error;
  }
}

function gapLength(space: unknown): number {
  if (typeof space === 'number') return Math.min(10, Math.max(0, Math.trunc(space) || 0));
  if (typeof space === 'string') return Math.min(10, space.length);
  return 0;
}

function propertyList(replacer: unknown[]): string[] {
  const keys = new Set<string>();
  for (const item of replacer) {
    if (typeof item === 'string' || typeof item === 'number') keys.add(String(item));
  }
  return [...keys];
}

/**
 * JSON.stringify with the output size reserved before the native runs. When a replacer function or
 * a toJSON written in the expression decides the output, each value is charged as the serializer
 * reaches it instead.
 */
export function stringifyBounded(
  budget: NativeBudget,
  value: unknown,
  replacer: unknown,
  space: unknown,
): string | undefined {
  const gap = gapLength(space);
  if (typeof replacer !== 'function') {
    const keys = Array.isArray(replacer) ? propertyList(replacer) : undefined;
    const length = jsonLength(budget, value, { keys, gap });
    if (length) {
      budget.reserve(length.total);
      const out = JSON.stringify(value, replacer as (string | number)[] | null, space as string | number);
      if (out !== undefined) budget.charge(out.length);
      return out;
    }
    if (keys) {
      throw new ExpressionError(
        'JSON.stringify cannot combine a list of keys with a toJSON method written in the expression',
      );
    }
  }
  const user =
    typeof replacer === 'function'
      ? (replacer as (this: unknown, k: string, v: unknown) => unknown)
      : undefined;
  const levels = new WeakMap<object, number>();
  return JSON.stringify(
    value,
    function (this: object, key: string, input: unknown) {
      budget.checkDeadline();
      const result = user ? user.call(this, key, input) : input;
      const level = (levels.get(this) ?? 0) + 1;
      let size = quotedLength(key) + 2 + gap * level;
      if (typeof result === 'string') size += quotedLength(result);
      else if (result !== null && typeof result === 'object') {
        levels.set(result, level);
        size += 2;
      } else size += 24;
      budget.charge(size);
      return result;
    },
    space as string | number,
  );
}

/** ASCII characters an encoder leaves as they are, as a lookup table for encodedUriLength */
export function uriKeepTable(kept: string): Uint8Array {
  const table = new Uint8Array(128);
  for (const range of ['AZ', 'az', '09']) {
    for (let c = range.charCodeAt(0); c <= range.charCodeAt(1); c++) table[c] = 1;
  }
  for (const ch of kept) table[ch.charCodeAt(0)] = 1;
  return table;
}

/** length of encodeURIComponent / encodeURI output: each escaped UTF-8 byte takes three characters */
export function encodedUriLength(text: string, keep: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += keep[c] ? 1 : 3;
    else if (c < 0x800) n += 6;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 12;
      i++;
    } else n += 9;
  }
  return n;
}
