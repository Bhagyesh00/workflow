/**
 * Sandboxed interpreter for user-authored expressions.
 *
 * Expressions are parsed with acorn and evaluated by walking the AST. User code never reaches
 * `eval`, `Function` or the host `vm` module, so there is no "escape" in the classic sense:
 * every property read, write and call is mediated here.
 *
 * Security rules (see docs/ARCHITECTURE.md, "Expression security"):
 *  1. Prototype-chain keys (`constructor`, `__proto__`, `prototype`, ...) can never be read,
 *     written, defined or destructured.
 *  2. Dangerous host functions (Function, eval, Reflect, timers, ...) can never be called or
 *     even returned from a property read.
 *  3. Mutation is opt-in: assignment, `delete`, `Object.assign` targets and mutating Array/Map/Set
 *     methods only work on values the evaluation itself created (literals, rest/spread copies, new
 *     instances, fresh results of native producers such as `map` or `JSON.parse` without a reviver)
 *     and on input data. Input data is tracked by provenance: plain objects and arrays reached from
 *     the `dataGlobals` ($json, $input, $('Node'), $parameter, ...) or returned by the data proxy's
 *     own functions are per-execution values that expressions may sort or change as in n8n. What is
 *     stored into input data must be new (primitives, or created plain values holding only such
 *     values, each once) and is charged to the allocation budget, so host objects never become
 *     writable and data never repeats a part beyond the budget. Everything else reachable from the
 *     host (luxon's module-level presets and caches, facades, library return values) is read-only,
 *     which prevents cross-tenant contamination.
 *  4. Execution is bounded by a step budget, a wall-clock deadline checked on every call and loop
 *     iteration, and a cumulative allocation budget for strings and arrays produced natively. The
 *     segments of one template share the budget. Conversions whose size does not show in their
 *     arguments (nested or repeated arrays turned into strings, JSON.stringify, flat, default sorts,
 *     extensions) are measured by `bounded.ts` before the native runs, and a result that repeats
 *     shared parts (input data included) beyond the budget cannot leave the evaluation.
 *  5. Every regex pattern passes the safety policy in `regex.ts` before it reaches the engine, and
 *     luxon internals (`loc`, `matrix`, `c`, ...) cannot be read.
 *
 * Guarded natives (mutators, regex methods, size producers) read as values, e.g. `[].push` passed
 * to `forEach`, or handed to another native (`[x].map(Number)`, `Number.call(null, x)`), are
 * replaced by wrappers that route back through the same checks. Arguments a native may convert are
 * measured first: one that repeats shared parts beyond the budget is refused (`reserveRepeats`).
 */
import { type Node as AcornNode, parseExpressionAt } from 'acorn';
import { DateTime, Duration, Interval } from 'luxon';
import { ExpressionError } from '../errors';
import {
  flatDepth,
  flatLength,
  isPlainArray,
  joinBounded,
  jsonLength,
  type NativeBudget,
  reserveRepeats,
  sortByText,
} from './bounded';
import { assertSafeRegExp, createSafeRegExp } from './regex';

/* biome-ignore-all lint/suspicious/noExplicitAny: AST nodes are dynamically shaped */
type N = any;

export const BLOCKED_KEYS = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'caller',
  'callee',
  'arguments',
]);

const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;

const FORBIDDEN_VALUES = new Set<unknown>(
  [
    Function,
    GeneratorFunction,
    AsyncFunction,
    AsyncGeneratorFunction,
    // biome-ignore lint/security/noGlobalEval: listed so it can never be reached from expressions
    eval,
    globalThis,
    Reflect,
    Proxy,
    Object.defineProperty,
    Object.defineProperties,
    Object.getOwnPropertyDescriptor,
    Object.getOwnPropertyDescriptors,
    Object.getPrototypeOf,
    Object.setPrototypeOf,
    Object.freeze,
    Object.seal,
    Object.preventExtensions,
    (globalThis as any).setTimeout,
    (globalThis as any).setInterval,
    (globalThis as any).setImmediate,
    (globalThis as any).queueMicrotask,
    (globalThis as any).fetch,
    (globalThis as any).process,
    (globalThis as any).require,
    (globalThis as any).Buffer,
    (globalThis as any).WebAssembly,
    (globalThis as any).SharedArrayBuffer,
    (globalThis as any).Atomics,
    // recompiles a regex in place, which would skip the regex safety policy
    (RegExp.prototype as any).compile,
  ].filter((v) => v !== undefined),
);

export const LIMITS = {
  maxStringLength: 32 * 1024 * 1024,
  maxArrayLength: 10_000_000,
  /** characters plus array elements that natives, spreads and templates may produce in one evaluation */
  maxAllocation: 64 * 1024 * 1024,
};

/** luxon instance fields that hold shared module state or internals; public getters stay readable */
const LUXON_INTERNAL_KEYS = new Set([
  'loc',
  'matrix',
  'c',
  'o',
  'values',
  'weekData',
  'localWeekData',
  'invalid',
  'isLuxonDateTime',
  'isLuxonDuration',
  'isLuxonInterval',
  '_zone',
]);

/** luxon's Locale class is not exported; its instances are cached and shared by the whole process */
const LUXON_LOCALE_PROTO: object = Object.getPrototypeOf((DateTime.fromMillis(0) as any).loc);

function isLuxonValue(value: unknown): boolean {
  return DateTime.isDateTime(value) || Duration.isDuration(value) || Interval.isInterval(value);
}

/**
 * Own enumerable entries an expression may see: luxon internals are always hidden, prototype keys
 * only when the result becomes an object again (spread, rest, for-in) rather than plain data.
 */
export function visibleEntries(value: object, hideBlockedKeys = true): [string, unknown][] {
  const luxon = isLuxonValue(value);
  return Object.entries(value).filter(
    ([k]) => !(hideBlockedKeys && BLOCKED_KEYS.has(k)) && !(luxon && LUXON_INTERNAL_KEYS.has(k)),
  );
}

export interface NativeGuard {
  /** the method changes its receiver: allowed only on values the evaluation created */
  mutatesThis?: boolean;
  /** index of an argument the function changes (the `Object.assign` target) */
  mutatesArg?: number;
  /** `this` must be a RegExp that passes the policy */
  regexThis?: boolean;
  /** first argument: `compile` turns strings into checked regexes, `check` only validates RegExp objects */
  regexArg?: 'compile' | 'check';
  /** flags used when `regexArg: 'compile'` builds a regex from a string */
  regexFlags?: string;
  /**
   * the result is a new value the evaluation may mutate; `deep` also covers nested objects and
   * arrays. A function decides per call (JSON.parse only owns its result without a reviver).
   */
  fresh?: 'shallow' | 'deep' | ((args: unknown[]) => 'shallow' | 'deep' | undefined);
  /** the result counts towards the allocation budget */
  charge?: boolean;
  /** size of the result, computed before the call so oversized work never starts */
  project?: (thisArg: unknown, args: unknown[]) => number;
  /** values the call stores into its target, once per copy; checked when the target is input data */
  inserts?: (thisArg: unknown, args: unknown[]) => unknown[];
  /** plain array arguments (and receiver) are turned into strings first, under the budget, as the native would */
  textArgs?: boolean;
  /** the native stores, copies or compares its arguments without converting them: they are not measured */
  opaqueArgs?: boolean;
  /**
   * runs instead of the native, with access to the evaluation's budget. For an extension `thisArg`
   * is the value it was called on, and `textArgs` converts the other arguments only.
   */
  run?: (budget: NativeBudget, thisArg: unknown, args: unknown[]) => unknown;
}

const NATIVE_GUARDS = new Map<unknown, NativeGuard>();

/** Attach checks to a host function exposed to expressions (merged with any existing guard). */
export function registerGuardedFunction(fn: unknown, guard: NativeGuard): void {
  NATIVE_GUARDS.set(fn, { ...NATIVE_GUARDS.get(fn), ...guard });
}

function lengthOf(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  return 0;
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function freshness(guard: NativeGuard | undefined, args: unknown[]): 'shallow' | 'deep' | undefined {
  return typeof guard?.fresh === 'function' ? guard.fresh(args) : guard?.fresh;
}

/** upper bound of a replace result with a string replacement; counts matches only when the bound is large */
function projectReplace(all: boolean) {
  return (thisArg: unknown, [pattern, replacement]: unknown[]): number => {
    const subject = String(thisArg);
    if (typeof replacement !== 'string' || replacement.length <= 2) return subject.length;
    const global = pattern instanceof RegExp ? pattern.global : all;
    if (!global) return subject.length + replacement.length;
    const bound = subject.length + (subject.length + 1) * replacement.length;
    if (bound <= LIMITS.maxStringLength) return bound;
    const matches =
      pattern instanceof RegExp
        ? (subject.match(pattern)?.length ?? 0)
        : subject.split(String(pattern)).length - 1;
    return subject.length + matches * replacement.length;
  };
}

for (const name of Object.getOwnPropertyNames(String.prototype)) {
  const fn = (String.prototype as any)[name];
  if (typeof fn === 'function' && name !== 'constructor') {
    registerGuardedFunction(fn, { charge: true, textArgs: true });
  }
}

/** Array#fill / copyWithin index argument resolved against `length`, as the native does */
function relativeIndex(value: unknown, length: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value)) || 0;
  return n < 0 ? Math.max(length + n, 0) : Math.min(n, length);
}

const insertedValues: Record<string, (thisArg: unknown, args: unknown[]) => unknown[]> = {
  push: (_thisArg, args) => args,
  unshift: (_thisArg, args) => args,
  // one copy per slot, so a value filled into several slots counts as stored several times
  fill: (thisArg, [value, start, end]) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'string')) return [];
    const length = lengthOf(thisArg);
    const from = relativeIndex(start, length, 0);
    const slots = Math.max(relativeIndex(end, length, length) - from, 0);
    // two copies of an object are already one too many
    return new Array(typeof value === 'object' ? Math.min(slots, 2) : slots).fill(value);
  },
  // the elements copied over are stored a second time
  copyWithin: (thisArg, [target, start, end]) => {
    if (!Array.isArray(thisArg)) return [];
    const length = thisArg.length;
    const to = relativeIndex(target, length, 0);
    const from = relativeIndex(start, length, 0);
    const count = Math.min(relativeIndex(end, length, length) - from, length - to);
    return count > 0 ? thisArg.slice(from, from + count) : [];
  },
};
for (const name of ['push', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin']) {
  registerGuardedFunction((Array.prototype as any)[name], {
    mutatesThis: true,
    inserts: insertedValues[name],
  });
}
// without a comparator every comparison converts both elements again; nested arrays are converted once here
for (const name of ['sort', 'toSorted']) {
  const sort = (Array.prototype as any)[name];
  if (!sort) continue;
  registerGuardedFunction(sort, {
    run: (budget, thisArg, args) =>
      args[0] === undefined && Array.isArray(thisArg) && thisArg.some(isPlainArray)
        ? sortByText(budget, thisArg, name === 'sort')
        : Reflect.apply(sort, thisArg, args),
  });
}
for (const name of ['map', 'filter', 'slice', 'toSorted', 'toReversed', 'toSpliced', 'with']) {
  const fn = (Array.prototype as any)[name];
  if (fn) registerGuardedFunction(fn, { fresh: 'shallow', charge: true });
}
registerGuardedFunction(Array.prototype.splice, {
  mutatesThis: true,
  fresh: 'shallow',
  charge: true,
  inserts: (_thisArg, args) => args.slice(2),
});
registerGuardedFunction(Array.prototype.concat, {
  fresh: 'shallow',
  charge: true,
  project: (thisArg, args) =>
    args.reduce<number>((n, a) => n + (Array.isArray(a) ? a.length : 1), lengthOf(thisArg)),
});
registerGuardedFunction(Array.prototype.flat, {
  fresh: 'shallow',
  charge: true,
  run: (budget, thisArg, args) => {
    if (Array.isArray(thisArg))
      budget.reserve(flatLength(budget, thisArg, flatDepth(args[0]), LIMITS.maxAllocation));
    return Reflect.apply(Array.prototype.flat, thisArg, args);
  },
});
registerGuardedFunction(Array.prototype.flatMap, {
  fresh: 'shallow',
  charge: true,
  // flattened here so a callback that keeps returning one large array is stopped before it is copied
  run: (budget, thisArg, [callback, callbackThis]) => {
    if (!Array.isArray(thisArg) || typeof callback !== 'function') {
      return Reflect.apply(Array.prototype.flatMap, thisArg, [callback, callbackThis]);
    }
    const out: unknown[] = [];
    for (let i = 0; i < thisArg.length; i++) {
      if ((i & 1023) === 1023) budget.checkDeadline();
      if (!(i in thisArg)) continue;
      const mapped = callback.call(callbackThis, thisArg[i], i, thisArg);
      if (!Array.isArray(mapped)) {
        out.push(mapped);
        continue;
      }
      budget.reserve(out.length + mapped.length);
      for (let j = 0; j < mapped.length; j++) if (j in mapped) out.push(mapped[j]);
    }
    return out;
  },
});
registerGuardedFunction(Array.prototype.join, {
  run: (budget, thisArg, [separator]) => {
    if (thisArg === null || thisArg === undefined) return Reflect.apply(Array.prototype.join, thisArg, []);
    const sep = separator === undefined ? ',' : budget.text(separator);
    return joinBounded(budget, Object(thisArg) as ArrayLike<unknown>, sep);
  },
});
registerGuardedFunction(Array.prototype.toString, {
  run: (budget, thisArg) =>
    isPlainArray(thisArg)
      ? joinBounded(budget, thisArg, ',')
      : Reflect.apply(Array.prototype.toString, thisArg, []),
});
registerGuardedFunction(Array.prototype.toLocaleString, {
  run: (budget, thisArg, args) =>
    Array.isArray(thisArg)
      ? joinBounded(budget, thisArg, ',', args)
      : Reflect.apply(Array.prototype.toLocaleString, thisArg, args),
});
for (const proto of [Map.prototype, Set.prototype]) {
  for (const name of ['set', 'add', 'delete', 'clear']) {
    const fn = (proto as any)[name];
    if (fn) registerGuardedFunction(fn, { mutatesThis: true, opaqueArgs: true });
  }
  for (const name of ['get', 'has']) {
    const fn = (proto as any)[name];
    if (fn) registerGuardedFunction(fn, { opaqueArgs: true });
  }
}
// these store or copy their arguments as they are
for (const name of ['push', 'unshift', 'concat', 'join', 'toString']) {
  registerGuardedFunction((Array.prototype as any)[name], { opaqueArgs: true });
}
registerGuardedFunction(String.prototype.repeat, {
  project: (thisArg, [count]) => String(thisArg).length * Number(count),
});
registerGuardedFunction(String.prototype.padStart, { project: (_thisArg, [length]) => Number(length) });
registerGuardedFunction(String.prototype.padEnd, { project: (_thisArg, [length]) => Number(length) });
registerGuardedFunction(String.prototype.concat, {
  project: (thisArg, args) => args.reduce<number>((n, a) => n + stringLength(a), String(thisArg).length),
});
registerGuardedFunction(String.prototype.match, { regexArg: 'compile', fresh: 'shallow' });
registerGuardedFunction(String.prototype.matchAll, { regexArg: 'compile', regexFlags: 'g' });
registerGuardedFunction(String.prototype.search, { regexArg: 'compile' });
registerGuardedFunction(String.prototype.split, { regexArg: 'check', fresh: 'shallow' });
registerGuardedFunction(String.prototype.replace, { regexArg: 'check', project: projectReplace(false) });
registerGuardedFunction(String.prototype.replaceAll, { regexArg: 'check', project: projectReplace(true) });
registerGuardedFunction(RegExp.prototype.exec, { regexThis: true, fresh: 'shallow' });
registerGuardedFunction(RegExp.prototype.test, { regexThis: true });

export interface InterpreterOptions {
  /** AST node evaluations per run */
  maxSteps?: number;
  /** wall clock per run */
  timeoutMs?: number;
  /** resolve `.method()` calls that do not exist natively (data transformation functions) */
  extensions?: (target: unknown, name: string) => ((...args: unknown[]) => unknown) | undefined;
  /** globals holding per-execution input data ($json, $input, ...): what they lead to may be changed */
  dataGlobals?: Iterable<string>;
}

/** sentinel returned by optional chains that short-circuit (`a?.b` with nullish `a`) */
const ShortCircuit = { instance: Object.freeze({ shortCircuit: true }) } as const;

type Completion =
  | undefined
  | { type: 'return'; value: unknown }
  | { type: 'break'; label?: string }
  | { type: 'continue'; label?: string };

interface Binding {
  value: unknown;
  mutable: boolean;
}

class Scope {
  private vars = new Map<string, Binding>();
  constructor(
    readonly parent: Scope | null,
    readonly thisValue?: { value: unknown },
  ) {}

  declare(name: string, value: unknown, mutable: boolean) {
    this.vars.set(name, { value, mutable });
  }

  find(name: string): Binding | undefined {
    let s: Scope | null = this;
    while (s) {
      const b = s.vars.get(name);
      if (b) return b;
      s = s.parent;
    }
    return undefined;
  }

  getThis(): unknown {
    let s: Scope | null = this;
    while (s) {
      if (s.thisValue) return s.thisValue.value;
      s = s.parent;
    }
    return undefined;
  }
}

const astCache = new Map<string, AcornNode>();
const AST_CACHE_MAX = 5000;

export function parseExpression(code: string): AcornNode {
  const cached = astCache.get(code);
  if (cached) return cached;
  let ast: AcornNode;
  try {
    ast = parseExpressionAt(code, 0, {
      ecmaVersion: 2023,
      sourceType: 'script',
      allowReserved: true,
      preserveParens: true,
    });
  } catch (error) {
    throw new ExpressionError(`Invalid syntax: ${(error as Error).message}`, { cause: error });
  }
  if (ast.end < code.trimEnd().length) {
    const rest = code.slice(ast.end).trim();
    if (rest && rest !== ';') throw new ExpressionError(`Invalid syntax: unexpected "${rest.slice(0, 20)}"`);
  }
  if (astCache.size >= AST_CACHE_MAX) astCache.delete(astCache.keys().next().value as string);
  astCache.set(code, ast);
  return ast;
}

export function isPlainMutable(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  if (Object.isFrozen(target)) return false;
  if (Array.isArray(target)) return true;
  const proto = Object.getPrototypeOf(target);
  return proto === Object.prototype || proto === null;
}

function assertKey(key: unknown): string | number {
  if (typeof key === 'symbol') throw new ExpressionError('Symbol property access is not allowed');
  if (typeof key === 'number') return key;
  const k = String(key);
  if (BLOCKED_KEYS.has(k)) throw new ExpressionError(`Access to "${k}" is not allowed`);
  return k;
}

function assertValue<T>(value: T): T {
  if ((typeof value === 'function' || typeof value === 'object') && FORBIDDEN_VALUES.has(value)) {
    throw new ExpressionError('Access to this value is not allowed');
  }
  return value;
}

function checkSize(value: unknown): unknown {
  if (typeof value === 'string' && value.length > LIMITS.maxStringLength) {
    throw new ExpressionError('String exceeds the maximum allowed length');
  }
  if (Array.isArray(value) && value.length > LIMITS.maxArrayLength) {
    throw new ExpressionError('Array exceeds the maximum allowed length');
  }
  return value;
}

/** budget errors a `try/catch` in the expression must not swallow (it could repeat the allocation) */
const UNCATCHABLE_ERRORS =
  /maximum number of steps|time limit|allocation budget|maximum allowed length|too large/;

const STRING_RESULT_PRODUCERS = new Set<unknown>([
  String.prototype.repeat,
  String.prototype.padStart,
  String.prototype.padEnd,
  String.prototype.concat,
  String.prototype.replace,
  String.prototype.replaceAll,
]);

/** built-in constructors that turn their arguments into strings */
const TEXT_ARG_CONSTRUCTORS = new Set<unknown>([Error, TypeError, RangeError, Date, URL]);

/** built-in constructors that store their entries as they are */
const OPAQUE_ARG_CONSTRUCTORS = new Set<unknown>([Map, Set]);

/** a plain object or array: the only shapes that count as input data */
function isPlainShape(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function notStorable(): ExpressionError {
  return new ExpressionError('Cannot store this value in input data', {
    description:
      'Input data can hold plain values and new objects, each once. Store a copy instead: JSON.parse(JSON.stringify(value)).',
  });
}

export class Interpreter {
  private steps = 0;
  private deadline = 0;
  private allocated = 0;
  private readonly maxSteps: number;
  private readonly timeoutMs: number;
  private readonly interpretedFunctions = new WeakSet<object>();
  /** objects and arrays this evaluation created: they may be changed */
  private readonly owned = new WeakSet<object>();
  /** plain objects and arrays reached from input data: they may be changed, but only hold data */
  private readonly data = new WeakSet<object>();
  /** data objects whose children are marked as data too (natives hand children to callbacks) */
  private readonly expanded = new WeakSet<object>();
  /** functions of the data proxy ($input.all, $('Node'), ...): what they return is data */
  private readonly dataFunctions = new WeakSet<object>();
  private readonly dataGlobals: ReadonlySet<string>;
  private readonly guardWrappers = new Map<unknown, (...args: unknown[]) => unknown>();
  private readonly budget: NativeBudget = {
    reserve: (size) => this.reserve(size),
    charge: (size) => this.charge(size),
    checkDeadline: () => this.checkDeadline(),
    text: (value) => this.toText(value),
    isData: (value) => this.data.has(value),
  };

  constructor(
    private readonly globals: Record<string, unknown>,
    private readonly options: InterpreterOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.dataGlobals = new Set(options.dataGlobals ?? []);
  }

  /**
   * `continued` keeps the step, time and allocation budget of the previous call, so the segments of
   * one template cannot each spend a full budget.
   */
  evaluate(code: string, continued = false): unknown {
    const ast = parseExpression(code);
    if (!continued) {
      this.steps = 0;
      this.allocated = 0;
      this.deadline = Date.now() + this.timeoutMs;
    }
    const result = this.expr(ast, new Scope(null));
    const value = result === ShortCircuit.instance ? undefined : result;
    this.assertResultSize(value);
    return value;
  }

  /** counts text the caller builds from results (template output) towards the allocation budget */
  chargeOutput(size: number): void {
    this.charge(size);
  }

  /**
   * The caller serializes the result outside the budget, so a result built from shared parts
   * (an array that doubles at each level, or input data listed many times) must not expand beyond
   * the allocation budget there. Sharing inside input data is the host's own and is not counted.
   */
  private assertResultSize(value: unknown): void {
    if (value === null || typeof value !== 'object' || this.data.has(value)) return;
    const length = jsonLength(this.budget, value, {
      callToJSON: true,
      skip: (o) => Object.isFrozen(o),
      isData: this.budget.isData,
    });
    if (length && length.repeated > LIMITS.maxAllocation) {
      throw new ExpressionError('Expression result is too large', {
        description: 'The result repeats the same values too many times to be stored.',
      });
    }
  }

  private tick() {
    this.steps++;
    if (this.steps > this.maxSteps)
      throw new ExpressionError('Expression exceeded the maximum number of steps');
    if ((this.steps & 1023) === 0) this.checkDeadline();
  }

  /** called on every call, function entry and loop iteration so slow native work cannot hide between ticks */
  private checkDeadline() {
    if (Date.now() > this.deadline) {
      throw new ExpressionError(`Expression exceeded the time limit of ${this.timeoutMs}ms`);
    }
  }

  /** fail before native work whose result would not fit in the remaining allocation budget */
  private reserve(size: number) {
    if (size > LIMITS.maxAllocation - this.allocated) {
      throw new ExpressionError(
        `Expression exceeded the allocation budget of ${LIMITS.maxAllocation} characters and array elements`,
      );
    }
  }

  private charge(size: number) {
    if (size <= 0) return;
    this.reserve(size);
    this.allocated += size;
  }

  private own<T>(value: T, deep = false): T {
    if (value === null || typeof value !== 'object') return value;
    if (!deep) {
      this.owned.add(value);
      return value;
    }
    const stack: object[] = [value];
    while (stack.length) {
      const current = stack.pop() as object;
      if (this.owned.has(current)) continue;
      this.owned.add(current);
      for (const child of Object.values(current)) {
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
    return value;
  }

  private assertWritable(target: unknown, message: string) {
    if (
      target === null ||
      typeof target !== 'object' ||
      Object.isFrozen(target) ||
      !(this.owned.has(target) || this.data.has(target))
    ) {
      throw new ExpressionError(message, {
        description:
          'Only input data and values the expression created can be changed. Copy it first: { ...value } or [...value].',
      });
    }
  }

  /**
   * A write into input data. Data outlives the evaluation and the host serializes it, so what is
   * stored must be new: primitives and other values the host serializes at a fixed size, or plain
   * objects and arrays the expression created that hold only such values, each object once. Storing
   * an object the data already holds would let a few writes repeat it without limit. Stored strings
   * and elements count towards the allocation budget, as the host will copy them.
   */
  private assertStorable(target: unknown, values: unknown[]) {
    if (target === null || typeof target !== 'object' || !this.data.has(target)) return;
    const adopted = new Set<object>();
    const stack = [...values];
    let size = 0;
    while (stack.length) {
      const value = stack.pop();
      if (typeof value === 'string') size += value.length;
      else if (value instanceof URL) size += value.href.length;
      // a function would run later in host code that serializes or compares the data
      if (typeof value === 'function') throw notStorable();
      if (value === null || typeof value !== 'object' || !isPlainShape(value)) continue;
      if (this.data.has(value) || adopted.has(value) || !this.owned.has(value) || Object.isFrozen(value)) {
        throw notStorable();
      }
      adopted.add(value);
      const children = Array.isArray(value) ? value : Object.values(value);
      size += children.length;
      for (const child of children) stack.push(child);
    }
    this.charge(size);
    for (const value of adopted) this.data.add(value);
  }

  /** `value` was read from input data: plain objects and arrays are data, data proxy functions return data */
  private markData(value: unknown, fromProxy: boolean) {
    if (value === null) return;
    if (typeof value === 'object') {
      if (isPlainShape(value)) this.data.add(value);
    } else if (
      typeof value === 'function' &&
      fromProxy &&
      !this.interpretedFunctions.has(value) &&
      !NATIVE_GUARDS.has(value)
    ) {
      this.dataFunctions.add(value);
    }
  }

  /** natives and loops hand the children of a data value to the expression without a property read */
  private expand(value: unknown) {
    if (value === null || typeof value !== 'object' || !this.data.has(value)) return;
    if (this.expanded.has(value) || Object.isFrozen(value)) return;
    this.expanded.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child !== null && typeof child === 'object' && isPlainShape(child)) this.data.add(child);
    }
  }

  /** a native may convert any of these arguments (all but the one it writes to): repeats are reserved first */
  private reserveArgs(args: unknown[], written?: number) {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (i !== written && arg !== null && typeof arg === 'object') reserveRepeats(this.budget, arg);
    }
  }

  /** String(value), with plain arrays joined under the budget (a small nested array can join into a huge string) */
  private toText(value: unknown): string {
    return isPlainArray(value) ? joinBounded(this.budget, value, ',') : String(value);
  }

  /** what operators convert an operand to: plain arrays become their bounded string, the rest is left to the native */
  private primitive(value: unknown): unknown {
    return isPlainArray(value) ? joinBounded(this.budget, value, ',') : value;
  }

  private key(raw: unknown): string | number {
    return assertKey(isPlainArray(raw) ? this.toText(raw) : raw);
  }

  /** a guarded native read as a value (not called in place) is replaced by a wrapper that keeps its checks */
  private guardedValue(value: unknown): unknown {
    if (typeof value !== 'function' || !NATIVE_GUARDS.has(value)) return value;
    let wrapper = this.guardWrappers.get(value);
    if (!wrapper) {
      const interpreter = this;
      wrapper = function (this: unknown, ...args: unknown[]) {
        return interpreter.invoke(value, this, args);
      };
      this.interpretedFunctions.add(wrapper);
      this.guardWrappers.set(value, wrapper);
    }
    return wrapper;
  }

  private assertRegExp(value: unknown) {
    if (value instanceof RegExp) assertSafeRegExp(value.source, value.flags);
  }

  // -------------------------------------------------------------------------------------------
  // expressions
  // -------------------------------------------------------------------------------------------

  private expr(node: N, scope: Scope): unknown {
    this.tick();
    switch (node.type) {
      case 'Literal':
        if (node.regex) return this.own(createSafeRegExp(node.regex.pattern, node.regex.flags));
        return node.value;
      case 'Identifier':
        return this.lookup(node.name, scope);
      case 'ThisExpression':
        return scope.getThis();
      case 'TemplateLiteral': {
        let out = '';
        let longest = 0;
        node.quasis.forEach((q: N, i: number) => {
          out += q.value.cooked ?? q.value.raw;
          if (i < node.expressions.length) {
            const v = this.toText(this.expr(node.expressions[i], scope));
            longest = Math.max(longest, v.length);
            out += v;
            checkSize(out);
          }
        });
        // the longest piece is shared with the result (rope); everything else is new
        this.charge(out.length - longest);
        return out;
      }
      case 'TaggedTemplateExpression': {
        const tag = this.expr(node.tag, scope);
        const strings = node.quasi.quasis.map((q: N) => q.value.cooked);
        Object.defineProperty(strings, 'raw', { value: node.quasi.quasis.map((q: N) => q.value.raw) });
        const values = node.quasi.expressions.map((e: N) => this.expr(e, scope));
        return this.invoke(tag, undefined, [strings, ...values]);
      }
      case 'ArrayExpression': {
        const out: unknown[] = [];
        for (const el of node.elements) {
          if (el === null) out.push(undefined);
          else if (el.type === 'SpreadElement') {
            const before = out.length;
            for (const v of this.iterable(this.expr(el.argument, scope))) out.push(v);
            this.charge(out.length - before);
          } else out.push(this.expr(el, scope));
          checkSize(out);
        }
        return this.own(out);
      }
      case 'ObjectExpression':
        return this.own(this.objectLiteral(node, scope));
      case 'MemberExpression': {
        const object = this.expr(node.object, scope);
        if (object === ShortCircuit.instance) return object;
        if (node.optional && (object === null || object === undefined)) return ShortCircuit.instance;
        const key = node.computed ? this.expr(node.property, scope) : node.property.name;
        return this.getMember(object, key);
      }
      case 'ChainExpression': {
        const v = this.expr(node.expression, scope);
        return v === ShortCircuit.instance ? undefined : v;
      }
      case 'CallExpression':
        return this.call(node, scope);
      case 'NewExpression': {
        const ctor = this.expr(node.callee, scope);
        let args = this.args(node.arguments, scope);
        if (typeof ctor !== 'function' || this.interpretedFunctions.has(ctor)) {
          throw new ExpressionError('Value is not a constructor');
        }
        assertValue(ctor);
        this.checkDeadline();
        if (TEXT_ARG_CONSTRUCTORS.has(ctor) || NATIVE_GUARDS.get(ctor)?.textArgs) {
          args = args.map((a) => (isPlainArray(a) ? this.toText(a) : a));
        }
        if (!OPAQUE_ARG_CONSTRUCTORS.has(ctor)) this.reserveArgs(args);
        const constructed = checkSize(Reflect.construct(ctor, args));
        this.charge(lengthOf(constructed));
        // a constructor may return any object it can reach: only a new instance belongs to the evaluation
        const fresh =
          freshness(NATIVE_GUARDS.get(ctor), args) ??
          (Object.getPrototypeOf(constructed) === (ctor as { prototype?: unknown }).prototype
            ? 'shallow'
            : undefined);
        if (fresh) this.own(constructed, fresh === 'deep');
        return constructed;
      }
      case 'UnaryExpression':
        return this.unary(node, scope);
      case 'BinaryExpression':
        return this.binary(node.operator, this.expr(node.left, scope), this.expr(node.right, scope));
      case 'LogicalExpression': {
        const left = this.expr(node.left, scope);
        if (node.operator === '&&') return left ? this.expr(node.right, scope) : left;
        if (node.operator === '||') return left ? left : this.expr(node.right, scope);
        return left ?? this.expr(node.right, scope);
      }
      case 'ConditionalExpression':
        return this.expr(node.test, scope)
          ? this.expr(node.consequent, scope)
          : this.expr(node.alternate, scope);
      case 'AssignmentExpression':
        return this.assignment(node, scope);
      case 'UpdateExpression': {
        const current = Number(this.primitive(this.readTarget(node.argument, scope)));
        const next = node.operator === '++' ? current + 1 : current - 1;
        this.writeTarget(node.argument, next, scope);
        return node.prefix ? next : current;
      }
      case 'SequenceExpression': {
        let v: unknown;
        for (const e of node.expressions) v = this.expr(e, scope);
        return v;
      }
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return this.makeFunction(node, scope);
      case 'ParenthesizedExpression':
        return this.expr(node.expression, scope);
      default:
        throw new ExpressionError(`Unsupported syntax: ${node.type}`);
    }
  }

  private lookup(name: string, scope: Scope): unknown {
    const binding = scope.find(name);
    if (binding) return binding.value;
    if (name === 'undefined') return undefined;
    if (Object.hasOwn(this.globals, name)) {
      const value = this.globals[name];
      if (this.dataGlobals.has(name)) this.markData(value, true);
      return value;
    }
    throw new ExpressionError(`${name} is not defined`);
  }

  private objectLiteral(node: N, scope: Scope): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') {
        const src = this.expr(prop.argument, scope);
        if (src !== null && src !== undefined) {
          this.assertReadable(src);
          this.expand(src);
          const entries = visibleEntries(src as object);
          this.charge(entries.length);
          for (const [k, v] of entries) obj[k] = v;
        }
        continue;
      }
      if (prop.kind !== 'init') throw new ExpressionError('Getters and setters are not allowed');
      const rawKey = prop.computed
        ? this.expr(prop.key, scope)
        : prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.value;
      const key = this.key(rawKey);
      obj[key] = this.expr(prop.value, scope);
    }
    return obj;
  }

  getMember(object: unknown, rawKey: unknown): unknown {
    const key = this.key(rawKey);
    if (object === null || object === undefined) {
      throw new ExpressionError(`Cannot read properties of ${object} (reading '${key}')`);
    }
    return this.guardedValue(this.readMember(object, key));
  }

  /** property read without wrapping guarded natives (callers that invoke the result in place) */
  private readMember(object: unknown, key: string | number): unknown {
    this.assertReadable(object);
    if (typeof key === 'string' && LUXON_INTERNAL_KEYS.has(key) && isLuxonValue(object)) {
      throw new ExpressionError(`Access to "${key}" is not allowed`);
    }
    const value = assertValue((object as any)[key]);
    // the data proxy's functions are own properties of its frozen objects; inherited methods such as
    // valueOf and functions found in writable data are not among them
    if (object !== null && typeof object === 'object' && this.data.has(object)) {
      this.markData(value, Object.isFrozen(object) && Object.hasOwn(object, key));
    }
    return value;
  }

  /** luxon's shared Locale instances can be reached through data (e.g. $jmespath) but never used */
  private assertReadable(object: unknown) {
    if (
      object !== null &&
      typeof object === 'object' &&
      Object.getPrototypeOf(object) === LUXON_LOCALE_PROTO
    ) {
      throw new ExpressionError('Access to luxon internals is not allowed');
    }
  }

  private args(nodes: N[], scope: Scope): unknown[] {
    const out: unknown[] = [];
    for (const a of nodes) {
      if (a.type === 'SpreadElement') {
        const before = out.length;
        for (const v of this.iterable(this.expr(a.argument, scope))) out.push(v);
        this.charge(out.length - before);
      } else out.push(this.expr(a, scope));
    }
    return out;
  }

  private call(node: N, scope: Scope): unknown {
    const callee = unwrap(node.callee);
    let fn: unknown;
    let thisArg: unknown;
    if (callee.type === 'MemberExpression') {
      const object = this.expr(callee.object, scope);
      if (object === ShortCircuit.instance) return object;
      if (callee.optional && (object === null || object === undefined)) return ShortCircuit.instance;
      const k = this.key(callee.computed ? this.expr(callee.property, scope) : callee.property.name);
      if (object === null || object === undefined) {
        throw new ExpressionError(`Cannot read properties of ${object} (reading '${k}')`);
      }
      fn = this.readMember(object, k);
      thisArg = object;
      if (typeof fn !== 'function') {
        const extension = typeof k === 'string' ? this.options.extensions?.(object, k) : undefined;
        if (extension) {
          if (node.optional && fn == null) return ShortCircuit.instance;
          return this.callExtension(extension, object, this.args(node.arguments, scope));
        }
        if (node.optional && fn == null) return ShortCircuit.instance;
        throw new ExpressionError(`${describe(callee)} is not a function`);
      }
    } else {
      fn = this.expr(callee, scope);
      if (fn === ShortCircuit.instance) return fn;
      if (node.optional && (fn === null || fn === undefined)) return ShortCircuit.instance;
    }
    const args = this.args(node.arguments, scope);
    return this.invoke(fn, thisArg, args, callee);
  }

  /** a data transformation function called on `target`; its guard sees the target as `thisArg` */
  private callExtension(
    extension: (...args: unknown[]) => unknown,
    target: unknown,
    args: unknown[],
  ): unknown {
    this.checkDeadline();
    this.expand(target);
    for (const a of args) this.expand(a);
    const guard = NATIVE_GUARDS.get(extension);
    const callArgs = guard?.textArgs ? args.map((a) => (isPlainArray(a) ? this.toText(a) : a)) : args;
    if (!guard?.opaqueArgs) this.reserveArgs(callArgs);
    const result = checkSize(
      assertValue(guard?.run ? guard.run(this.budget, target, callArgs) : extension(target, ...callArgs)),
    );
    // a `run` charges what it builds unless its guard asks for the result to be charged here
    if (!guard?.run || guard.charge) this.charge(lengthOf(result));
    const fresh = freshness(guard, callArgs);
    if (fresh) this.own(result, fresh === 'deep');
    return result;
  }

  private invoke(fn: unknown, receiver: unknown, args: unknown[], calleeNode?: N): unknown {
    if (typeof fn !== 'function') {
      throw new ExpressionError(`${calleeNode ? describe(calleeNode) : 'value'} is not a function`);
    }
    assertValue(fn);
    this.checkDeadline();
    const guard = NATIVE_GUARDS.get(fn);
    let thisArg = receiver;
    let callArgs = args;
    const native = !this.interpretedFunctions.has(fn);
    if (native) {
      this.expand(thisArg);
      for (const a of args) this.expand(a);
      // a guarded native handed to another native (a callback, or the function `call` and `apply`
      // run) would be called without its checks; natives that only store or compare keep it as is
      thisArg = this.guardedValue(thisArg);
      if (!guard?.opaqueArgs) callArgs = callArgs.map((a) => this.guardedValue(a));
    }
    if (guard?.textArgs) {
      if (isPlainArray(thisArg)) thisArg = this.toText(thisArg);
      callArgs = callArgs.map((a) => (isPlainArray(a) ? this.toText(a) : a));
    }
    // before the checks below, which convert arguments themselves (lengths, indexes, patterns)
    if (native && !guard?.opaqueArgs) this.reserveArgs(callArgs, guard?.mutatesArg);
    if (guard) {
      if (guard.mutatesThis) {
        this.assertWritable(thisArg, 'Cannot modify this value');
        if (guard.inserts && this.data.has(thisArg as object)) {
          this.assertStorable(thisArg, guard.inserts(thisArg, callArgs));
        }
      }
      if (guard.mutatesArg !== undefined) {
        const target = callArgs[guard.mutatesArg];
        this.assertWritable(target, 'Cannot modify this value');
        if (guard.inserts && this.data.has(target as object)) {
          this.assertStorable(target, guard.inserts(thisArg, callArgs));
        }
      }
      if (guard.regexThis) this.assertRegExp(thisArg);
      if (guard.regexArg && callArgs[0] instanceof RegExp) this.assertRegExp(callArgs[0]);
      else if (guard.regexArg === 'compile' && callArgs[0] !== undefined) {
        // compile once here so a stateful toString cannot hand the engine a different pattern
        callArgs = [createSafeRegExp(String(callArgs[0]), guard.regexFlags), ...callArgs.slice(1)];
      }
      if (guard.project) {
        const projected = guard.project(thisArg, callArgs);
        if (!Number.isNaN(projected)) {
          if (STRING_RESULT_PRODUCERS.has(fn) && projected > LIMITS.maxStringLength) {
            throw new ExpressionError('String exceeds the maximum allowed length');
          }
          this.reserve(projected);
        }
      }
    }
    const result = guard?.run
      ? guard.run(this.budget, thisArg, callArgs)
      : Reflect.apply(fn, thisArg, callArgs);
    if (Array.isArray(thisArg)) checkSize(thisArg);
    checkSize(assertValue(result));
    if (guard?.charge || guard?.project) this.charge(lengthOf(result));
    const fresh = freshness(guard, callArgs);
    if (fresh) this.own(result, fresh === 'deep');
    // a data function that hands back its receiver, an argument or a created value ($fromAI's default)
    // does not turn it into data
    if (
      this.dataFunctions.has(fn) &&
      result !== receiver &&
      !args.includes(result) &&
      !(result !== null && typeof result === 'object' && this.owned.has(result))
    ) {
      this.markData(result, false);
    }
    return result;
  }

  private unary(node: N, scope: Scope): unknown {
    const argument = unwrap(node.argument);
    if (node.operator === 'typeof' && argument.type === 'Identifier') {
      const binding = scope.find(argument.name);
      if (binding) return typeof binding.value;
      if (Object.hasOwn(this.globals, argument.name)) return typeof this.globals[argument.name];
      return 'undefined';
    }
    if (node.operator === 'delete') {
      if (argument.type !== 'MemberExpression') return true;
      const object = this.expr(argument.object, scope);
      const key = this.key(argument.computed ? this.expr(argument.property, scope) : argument.property.name);
      this.assertWritable(object, 'Cannot delete properties of this value');
      return delete (object as any)[key];
    }
    const value = this.expr(node.argument, scope);
    const v =
      node.operator === '-' || node.operator === '+' || node.operator === '~' ? this.primitive(value) : value;
    switch (node.operator) {
      case 'typeof':
        return typeof v;
      case 'void':
        return undefined;
      case '!':
        return !v;
      case '-':
        return -(v as number);
      case '+':
        return +(v as number);
      case '~':
        return ~(v as number);
      default:
        throw new ExpressionError(`Unsupported operator ${node.operator}`);
    }
  }

  private binary(op: string, left: any, right: any): unknown {
    let l = left;
    let r = right;
    // operators convert array operands to strings natively; do it here under the budget
    // (== between two objects compares identity and converts nothing)
    const converts =
      op !== '===' &&
      op !== '!==' &&
      op !== 'in' &&
      op !== 'instanceof' &&
      (op !== '==' && op !== '!=' ? true : (typeof l === 'object') !== (typeof r === 'object'));
    if (converts) {
      l = this.primitive(l);
      r = this.primitive(r);
    }
    switch (op) {
      case '+': {
        const sum = checkSize(l + r);
        // concatenation shares the longer operand (rope); only the shorter side is new memory
        if (typeof sum === 'string') this.charge(sum.length - Math.max(stringLength(l), stringLength(r)));
        return sum;
      }
      case '-':
        return l - r;
      case '*':
        return l * r;
      case '/':
        return l / r;
      case '%':
        return l % r;
      case '**':
        return l ** r;
      case '==':
        // biome-ignore lint/suspicious/noDoubleEquals: user code semantics
        return l == r;
      case '!=':
        // biome-ignore lint/suspicious/noDoubleEquals: user code semantics
        return l != r;
      case '===':
        return l === r;
      case '!==':
        return l !== r;
      case '<':
        return l < r;
      case '<=':
        return l <= r;
      case '>':
        return l > r;
      case '>=':
        return l >= r;
      case '&':
        return l & r;
      case '|':
        return l | r;
      case '^':
        return l ^ r;
      case '<<':
        return l << r;
      case '>>':
        return l >> r;
      case '>>>':
        return l >>> r;
      case 'in':
        if (r === null || typeof r !== 'object') throw new ExpressionError("Cannot use 'in' operator here");
        return this.key(l) in r;
      case 'instanceof':
        if (typeof r !== 'function')
          throw new ExpressionError("Right-hand side of 'instanceof' is not callable");
        return l instanceof r;
      default:
        throw new ExpressionError(`Unsupported operator ${op}`);
    }
  }

  private assignment(node: N, scope: Scope): unknown {
    if (node.operator === '=') {
      const value = this.expr(node.right, scope);
      if (node.left.type === 'ObjectPattern' || node.left.type === 'ArrayPattern') {
        this.bindPattern(node.left, value, scope, 'assign');
      } else {
        this.writeTarget(node.left, value, scope);
      }
      return value;
    }
    const current = this.readTarget(node.left, scope);
    const op = node.operator.slice(0, -1);
    if (op === '&&')
      return current ? this.writeTarget(node.left, this.expr(node.right, scope), scope) : current;
    if (op === '||')
      return current ? current : this.writeTarget(node.left, this.expr(node.right, scope), scope);
    if (op === '??') return current ?? this.writeTarget(node.left, this.expr(node.right, scope), scope);
    const value = this.binary(op, current, this.expr(node.right, scope));
    return this.writeTarget(node.left, value, scope);
  }

  private readTarget(target: N, scope: Scope): unknown {
    target = unwrap(target);
    if (target.type === 'Identifier') return this.lookup(target.name, scope);
    if (target.type === 'MemberExpression') {
      const object = this.expr(target.object, scope);
      const key = target.computed ? this.expr(target.property, scope) : target.property.name;
      return this.getMember(object, key);
    }
    throw new ExpressionError('Invalid assignment target');
  }

  private writeTarget(target: N, value: unknown, scope: Scope): unknown {
    target = unwrap(target);
    if (target.type === 'Identifier') {
      const binding = scope.find(target.name);
      if (!binding) throw new ExpressionError(`Cannot assign to undeclared variable ${target.name}`);
      if (!binding.mutable) throw new ExpressionError(`Assignment to constant variable ${target.name}`);
      binding.value = value;
      return value;
    }
    if (target.type === 'MemberExpression') {
      const object = this.expr(target.object, scope);
      const key = this.key(target.computed ? this.expr(target.property, scope) : target.property.name);
      this.assertWritable(object, 'Cannot assign properties of this value');
      this.assertStorable(object, [value]);
      (object as any)[key] = value;
      checkSize(object);
      return value;
    }
    throw new ExpressionError('Invalid assignment target');
  }

  private iterable(value: unknown): Iterable<unknown> {
    this.expand(value);
    if (typeof value === 'string' || Array.isArray(value) || value instanceof Map || value instanceof Set) {
      return value as Iterable<unknown>;
    }
    if (value && typeof value === 'object' && typeof (value as any)[Symbol.iterator] === 'function') {
      return value as Iterable<unknown>;
    }
    throw new ExpressionError('Value is not iterable');
  }

  // -------------------------------------------------------------------------------------------
  // patterns / functions / statements
  // -------------------------------------------------------------------------------------------

  private bindPattern(pattern: N, value: unknown, scope: Scope, mode: 'let' | 'const' | 'assign'): void {
    switch (pattern.type) {
      case 'Identifier':
        if (mode === 'assign') this.writeTarget(pattern, value, scope);
        else scope.declare(pattern.name, value, mode === 'let');
        return;
      case 'MemberExpression':
        if (mode !== 'assign') throw new ExpressionError('Invalid destructuring target');
        this.writeTarget(pattern, value, scope);
        return;
      case 'AssignmentPattern':
        this.bindPattern(
          pattern.left,
          value === undefined ? this.expr(pattern.right, scope) : value,
          scope,
          mode,
        );
        return;
      case 'ArrayPattern': {
        const arr = [...this.iterable(value)];
        pattern.elements.forEach((el: N, i: number) => {
          if (!el) return;
          if (el.type === 'RestElement') this.bindPattern(el.argument, this.own(arr.slice(i)), scope, mode);
          else this.bindPattern(el, arr[i], scope, mode);
        });
        return;
      }
      case 'ObjectPattern': {
        if (value === null || value === undefined) throw new ExpressionError(`Cannot destructure ${value}`);
        const used = new Set<string>();
        for (const prop of pattern.properties) {
          if (prop.type === 'RestElement') {
            const rest: Record<string, unknown> = {};
            this.assertReadable(value);
            this.expand(value);
            for (const [k, v] of visibleEntries(value as object)) {
              if (!used.has(k)) rest[k] = v;
            }
            this.bindPattern(prop.argument, this.own(rest), scope, mode);
            continue;
          }
          const key = String(
            this.key(
              prop.computed
                ? this.expr(prop.key, scope)
                : prop.key.type === 'Identifier'
                  ? prop.key.name
                  : prop.key.value,
            ),
          );
          used.add(key);
          this.bindPattern(prop.value, this.getMember(value, key), scope, mode);
        }
        return;
      }
      default:
        throw new ExpressionError(`Unsupported pattern ${pattern.type}`);
    }
  }

  private makeFunction(node: N, scope: Scope): (...args: unknown[]) => unknown {
    if (node.async || node.generator)
      throw new ExpressionError('Async and generator functions are not supported');
    const interpreter = this;
    const isArrow = node.type === 'ArrowFunctionExpression';
    const fn = function (this: unknown, ...args: unknown[]) {
      // natives (map, forEach, Array.from) call back without going through invoke
      interpreter.checkDeadline();
      const fnScope = new Scope(scope, isArrow ? undefined : { value: this });
      if (!isArrow && node.id) fnScope.declare(node.id.name, fn, false);
      node.params.forEach((param: N, i: number) => {
        if (param.type === 'RestElement')
          interpreter.bindPattern(param.argument, interpreter.own(args.slice(i)), fnScope, 'let');
        else interpreter.bindPattern(param, args[i], fnScope, 'let');
      });
      if (node.expression) return interpreter.expr(node.body, fnScope);
      const completion = interpreter.block(node.body.body, new Scope(fnScope));
      return completion?.type === 'return' ? completion.value : undefined;
    };
    this.interpretedFunctions.add(fn);
    return fn;
  }

  private block(statements: N[], scope: Scope): Completion {
    for (const s of statements) {
      if (s.type === 'FunctionDeclaration') scope.declare(s.id.name, this.makeFunction(s, scope), true);
    }
    for (const s of statements) {
      const c = this.stmt(s, scope);
      if (c) return c;
    }
    return undefined;
  }

  private stmt(node: N, scope: Scope, label?: string): Completion {
    this.tick();
    switch (node.type) {
      case 'ExpressionStatement':
        this.expr(node.expression, scope);
        return undefined;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          const value = d.init ? this.expr(d.init, scope) : undefined;
          this.bindPattern(d.id, value, scope, node.kind === 'const' ? 'const' : 'let');
        }
        return undefined;
      case 'FunctionDeclaration':
      case 'EmptyStatement':
        return undefined;
      case 'ReturnStatement':
        return { type: 'return', value: node.argument ? this.expr(node.argument, scope) : undefined };
      case 'BlockStatement':
        return this.block(node.body, new Scope(scope));
      case 'IfStatement':
        if (this.expr(node.test, scope)) return this.stmt(node.consequent, new Scope(scope));
        return node.alternate ? this.stmt(node.alternate, new Scope(scope)) : undefined;
      case 'ThrowStatement': {
        const value = this.expr(node.argument, scope);
        throw value instanceof Error ? value : new ExpressionError(this.toText(value));
      }
      case 'TryStatement':
        return this.tryStatement(node, scope);
      case 'BreakStatement':
        return { type: 'break', label: node.label?.name };
      case 'ContinueStatement':
        return { type: 'continue', label: node.label?.name };
      case 'LabeledStatement':
        return this.stmt(node.body, scope, node.label.name);
      case 'ForStatement':
        return this.forStatement(node, scope, label);
      case 'ForOfStatement':
      case 'ForInStatement':
        return this.forEachStatement(node, scope, label);
      case 'WhileStatement':
      case 'DoWhileStatement':
        return this.whileStatement(node, scope, label);
      case 'SwitchStatement':
        return this.switchStatement(node, scope);
      default:
        throw new ExpressionError(`Unsupported syntax: ${node.type}`);
    }
  }

  private loopControl(c: Completion, label?: string): 'break' | 'continue' | 'propagate' | undefined {
    if (!c) return undefined;
    if (c.type === 'return') return 'propagate';
    if (c.label && c.label !== label) return 'propagate';
    return c.type;
  }

  private forStatement(node: N, scope: Scope, label?: string): Completion {
    const loopScope = new Scope(scope);
    if (node.init) {
      if (node.init.type === 'VariableDeclaration') this.stmt(node.init, loopScope);
      else this.expr(node.init, loopScope);
    }
    while (node.test ? this.expr(node.test, loopScope) : true) {
      this.checkDeadline();
      const c = this.stmt(node.body, new Scope(loopScope));
      const ctl = this.loopControl(c, label);
      if (ctl === 'propagate') return c;
      if (ctl === 'break') break;
      if (node.update) this.expr(node.update, loopScope);
    }
    return undefined;
  }

  private forEachStatement(node: N, scope: Scope, label?: string): Completion {
    const subject = this.expr(node.right, scope);
    const values =
      node.type === 'ForInStatement'
        ? subject === null || subject === undefined
          ? []
          : visibleEntries(subject as object).map(([k]) => k)
        : this.iterable(subject);
    for (const value of values) {
      const iterScope = new Scope(scope);
      if (node.left.type === 'VariableDeclaration') {
        this.bindPattern(
          node.left.declarations[0].id,
          value,
          iterScope,
          node.left.kind === 'const' ? 'const' : 'let',
        );
      } else {
        this.bindPattern(node.left, value, iterScope, 'assign');
      }
      this.checkDeadline();
      const c = this.stmt(node.body, iterScope);
      const ctl = this.loopControl(c, label);
      if (ctl === 'propagate') return c;
      if (ctl === 'break') break;
    }
    return undefined;
  }

  private whileStatement(node: N, scope: Scope, label?: string): Completion {
    if (node.type === 'DoWhileStatement') {
      do {
        this.checkDeadline();
        const c = this.stmt(node.body, new Scope(scope));
        const ctl = this.loopControl(c, label);
        if (ctl === 'propagate') return c;
        if (ctl === 'break') break;
      } while (this.expr(node.test, scope));
      return undefined;
    }
    while (this.expr(node.test, scope)) {
      this.checkDeadline();
      const c = this.stmt(node.body, new Scope(scope));
      const ctl = this.loopControl(c, label);
      if (ctl === 'propagate') return c;
      if (ctl === 'break') break;
    }
    return undefined;
  }

  private switchStatement(node: N, scope: Scope): Completion {
    const discriminant = this.expr(node.discriminant, scope);
    const switchScope = new Scope(scope);
    let matched = false;
    const cases: N[] = node.cases;
    const defaultIndex = cases.findIndex((c) => c.test === null);
    const run = (start: number): Completion => {
      for (let i = start; i < cases.length; i++) {
        const c = this.block(cases[i].consequent, switchScope);
        if (c?.type === 'break' && !c.label) return undefined;
        if (c) return c;
      }
      return undefined;
    };
    for (let i = 0; i < cases.length; i++) {
      if (cases[i].test && this.expr(cases[i].test, switchScope) === discriminant) {
        matched = true;
        return run(i);
      }
    }
    if (!matched && defaultIndex >= 0) return run(defaultIndex);
    return undefined;
  }

  private tryStatement(node: N, scope: Scope): Completion {
    let completion: Completion;
    try {
      completion = this.block(node.block.body, new Scope(scope));
    } catch (error) {
      if (!node.handler) throw error;
      if (error instanceof ExpressionError && UNCATCHABLE_ERRORS.test(error.message)) throw error;
      const catchScope = new Scope(scope);
      if (node.handler.param) this.bindPattern(node.handler.param, error, catchScope, 'let');
      completion = this.block(node.handler.body.body, catchScope);
    } finally {
      if (node.finalizer) {
        const f = this.block(node.finalizer.body, new Scope(scope));
        // biome-ignore lint/correctness/noUnsafeFinally: mirrors JS semantics (return in finally overrides)
        if (f) return f;
      }
    }
    return completion;
  }
}

/** strip redundant parentheses (acorn runs with preserveParens) */
function unwrap(node: N): N {
  while (node?.type === 'ParenthesizedExpression') node = node.expression;
  return node;
}

function describe(node: N): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed)
    return `${describe(node.object)}.${node.property.name}`;
  if (node.type === 'MemberExpression') return `${describe(node.object)}[...]`;
  if (node.type === 'CallExpression') return `${describe(node.callee)}(...)`;
  return 'expression';
}
