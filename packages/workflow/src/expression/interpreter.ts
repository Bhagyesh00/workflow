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
 *  3. Writes/deletes are only allowed on plain objects and arrays (data), never on functions,
 *     classes, frozen facades or exotic host objects. This prevents cross-tenant contamination
 *     of shared module state (e.g. `Math.floor = ...`).
 *  4. Execution is bounded by a step budget and a wall-clock deadline; string/array growth is capped.
 */
import { type Node as AcornNode, parseExpressionAt } from 'acorn';
import { ExpressionError } from '../errors';

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
  ].filter((v) => v !== undefined),
);

export const LIMITS = {
  maxStringLength: 32 * 1024 * 1024,
  maxArrayLength: 10_000_000,
};

export interface InterpreterOptions {
  /** AST node evaluations per run */
  maxSteps?: number;
  /** wall clock per run */
  timeoutMs?: number;
  /** resolve `.method()` calls that do not exist natively (data transformation functions) */
  extensions?: (target: unknown, name: string) => ((...args: unknown[]) => unknown) | undefined;
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

const GUARDED_STRING_METHODS = new Set<unknown>([
  String.prototype.repeat,
  String.prototype.padStart,
  String.prototype.padEnd,
]);

export class Interpreter {
  private steps = 0;
  private deadline = 0;
  private readonly maxSteps: number;
  private readonly timeoutMs: number;
  private readonly interpretedFunctions = new WeakSet<object>();

  constructor(
    private readonly globals: Record<string, unknown>,
    private readonly options: InterpreterOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 1_000_000;
    this.timeoutMs = options.timeoutMs ?? 1000;
  }

  evaluate(code: string): unknown {
    const ast = parseExpression(code);
    this.steps = 0;
    this.deadline = Date.now() + this.timeoutMs;
    const result = this.expr(ast, new Scope(null));
    return result === ShortCircuit.instance ? undefined : result;
  }

  private tick() {
    this.steps++;
    if (this.steps > this.maxSteps)
      throw new ExpressionError('Expression exceeded the maximum number of steps');
    if ((this.steps & 1023) === 0 && Date.now() > this.deadline) {
      throw new ExpressionError(`Expression exceeded the time limit of ${this.timeoutMs}ms`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // expressions
  // -------------------------------------------------------------------------------------------

  private expr(node: N, scope: Scope): unknown {
    this.tick();
    switch (node.type) {
      case 'Literal':
        if (node.regex) return new RegExp(node.regex.pattern, node.regex.flags);
        return node.value;
      case 'Identifier':
        return this.lookup(node.name, scope);
      case 'ThisExpression':
        return scope.getThis();
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((q: N, i: number) => {
          out += q.value.cooked ?? q.value.raw;
          if (i < node.expressions.length) {
            const v = this.expr(node.expressions[i], scope);
            out += String(v);
            checkSize(out);
          }
        });
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
            for (const v of this.iterable(this.expr(el.argument, scope))) out.push(v);
          } else out.push(this.expr(el, scope));
          checkSize(out);
        }
        return out;
      }
      case 'ObjectExpression':
        return this.objectLiteral(node, scope);
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
        const args = this.args(node.arguments, scope);
        if (typeof ctor !== 'function' || this.interpretedFunctions.has(ctor)) {
          throw new ExpressionError('Value is not a constructor');
        }
        assertValue(ctor);
        return checkSize(Reflect.construct(ctor, args));
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
        const current = Number(this.readTarget(node.argument, scope));
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
    if (Object.hasOwn(this.globals, name)) return this.globals[name];
    throw new ExpressionError(`${name} is not defined`);
  }

  private objectLiteral(node: N, scope: Scope): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (prop.type === 'SpreadElement') {
        const src = this.expr(prop.argument, scope);
        if (src !== null && src !== undefined) {
          for (const [k, v] of Object.entries(src as object)) {
            if (!BLOCKED_KEYS.has(k)) obj[k] = v;
          }
        }
        continue;
      }
      if (prop.kind !== 'init') throw new ExpressionError('Getters and setters are not allowed');
      const rawKey = prop.computed
        ? this.expr(prop.key, scope)
        : prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.value;
      const key = assertKey(rawKey);
      obj[key] = this.expr(prop.value, scope);
    }
    return obj;
  }

  getMember(object: unknown, rawKey: unknown): unknown {
    if (object === null || object === undefined) {
      throw new ExpressionError(`Cannot read properties of ${object} (reading '${String(rawKey)}')`);
    }
    const key = assertKey(rawKey);
    return assertValue((object as any)[key]);
  }

  private args(nodes: N[], scope: Scope): unknown[] {
    const out: unknown[] = [];
    for (const a of nodes) {
      if (a.type === 'SpreadElement') out.push(...this.iterable(this.expr(a.argument, scope)));
      else out.push(this.expr(a, scope));
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
      const key = callee.computed ? this.expr(callee.property, scope) : callee.property.name;
      if (object === null || object === undefined) {
        throw new ExpressionError(`Cannot read properties of ${object} (reading '${String(key)}')`);
      }
      const k = assertKey(key);
      fn = (object as any)[k];
      thisArg = object;
      if (typeof fn !== 'function') {
        const extension = typeof k === 'string' ? this.options.extensions?.(object, k) : undefined;
        if (extension) {
          if (node.optional && fn == null) return ShortCircuit.instance;
          return checkSize(extension(object, ...this.args(node.arguments, scope)));
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

  private invoke(fn: unknown, thisArg: unknown, args: unknown[], calleeNode?: N): unknown {
    if (typeof fn !== 'function') {
      throw new ExpressionError(`${calleeNode ? describe(calleeNode) : 'value'} is not a function`);
    }
    assertValue(fn);
    if (GUARDED_STRING_METHODS.has(fn)) {
      const base = String(thisArg).length;
      const n = Number(args[0]);
      const projected = fn === String.prototype.repeat ? base * n : n;
      if (projected > LIMITS.maxStringLength)
        throw new ExpressionError('String exceeds the maximum allowed length');
    }
    const result = Reflect.apply(fn, thisArg, args);
    if (Array.isArray(thisArg)) checkSize(thisArg);
    return checkSize(assertValue(result));
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
      const key = assertKey(argument.computed ? this.expr(argument.property, scope) : argument.property.name);
      if (!isPlainMutable(object)) throw new ExpressionError('Cannot delete properties of this value');
      return delete (object as any)[key];
    }
    const v = this.expr(node.argument, scope);
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

  private binary(op: string, l: any, r: any): unknown {
    switch (op) {
      case '+':
        return checkSize(l + r);
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
        return assertKey(l) in r;
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
      const key = assertKey(target.computed ? this.expr(target.property, scope) : target.property.name);
      if (!isPlainMutable(object)) throw new ExpressionError('Cannot assign properties of this value');
      (object as any)[key] = value;
      checkSize(object);
      return value;
    }
    throw new ExpressionError('Invalid assignment target');
  }

  private iterable(value: unknown): Iterable<unknown> {
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
          if (el.type === 'RestElement') this.bindPattern(el.argument, arr.slice(i), scope, mode);
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
            for (const [k, v] of Object.entries(value as object)) {
              if (!used.has(k) && !BLOCKED_KEYS.has(k)) rest[k] = v;
            }
            this.bindPattern(prop.argument, rest, scope, mode);
            continue;
          }
          const key = String(
            assertKey(
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
      const fnScope = new Scope(scope, isArrow ? undefined : { value: this });
      if (!isArrow && node.id) fnScope.declare(node.id.name, fn, false);
      node.params.forEach((param: N, i: number) => {
        if (param.type === 'RestElement')
          interpreter.bindPattern(param.argument, args.slice(i), fnScope, 'let');
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
        throw value instanceof Error ? value : new ExpressionError(String(value));
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
          : Object.keys(subject as object).filter((k) => !BLOCKED_KEYS.has(k))
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
        const c = this.stmt(node.body, new Scope(scope));
        const ctl = this.loopControl(c, label);
        if (ctl === 'propagate') return c;
        if (ctl === 'break') break;
      } while (this.expr(node.test, scope));
      return undefined;
    }
    while (this.expr(node.test, scope)) {
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
      if (error instanceof ExpressionError && /maximum number of steps|time limit/.test(error.message))
        throw error;
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
