import { describe, expect, it } from 'vitest';
import {
  deepFreeze,
  type ExpressionDataContext,
  ExpressionError,
  ExpressionEvaluator,
  type Item,
  type RunData,
  splitTemplate,
} from '../src';

function ctx(items: Item[], extra: Partial<ExpressionDataContext> = {}): ExpressionDataContext {
  return {
    workflow: {
      id: 'wf1',
      name: 'Test',
      active: false,
      nodes: {
        Start: { id: '1', name: 'Start', type: 't', typeVersion: 1, position: [0, 0], parameters: {} },
        Set: { id: '2', name: 'Set', type: 't', typeVersion: 1, position: [0, 0], parameters: { a: 1 } },
      },
    },
    runData: {},
    activeNodeName: 'Set',
    connectionInputData: deepFreeze(items),
    itemIndex: 0,
    runIndex: 0,
    mode: 'manual',
    executionId: 'ex1',
    timezone: 'UTC',
    ...extra,
  };
}

const ev = new ExpressionEvaluator({ timeoutMs: 500 });
const run = (expr: string, items: Item[] = [{ json: { name: 'Ada', n: 3, tags: ['a', 'b', 'a'] } }]) =>
  ev.evaluate(expr, ctx(items));

describe('template splitting', () => {
  it('splits text and code, handling braces inside code', () => {
    expect(splitTemplate('Hi {{ $json.name }}!')).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'code', value: ' $json.name ' },
      { type: 'text', value: '!' },
    ]);
    expect(splitTemplate('{{ {a: {b: 1}}.a.b }}')).toEqual([{ type: 'code', value: ' {a: {b: 1}}.a.b ' }]);
    expect(splitTemplate('{{ "}}" }}')).toEqual([{ type: 'code', value: ' "}}" ' }]);
  });
});

describe('expression evaluation', () => {
  it('returns raw values for a single segment and strings for templates', () => {
    expect(run('={{ $json.n }}')).toBe(3);
    expect(run('={{ $json.tags }}')).toEqual(['a', 'b', 'a']);
    expect(run('=Hello {{ $json.name }} ({{ $json.n * 2 }})')).toBe('Hello Ada (6)');
    expect(run('=obj: {{ { a: 1 } }}')).toBe('obj: {"a":1}');
  });

  it('supports modern JS syntax', () => {
    expect(run('={{ $json.tags.map(t => t.toUpperCase()).join("-") }}')).toBe('A-B-A');
    expect(run('={{ $json.missing?.deep ?? "fallback" }}')).toBe('fallback');
    expect(run('={{ (() => { let s = 0; for (const x of [1,2,3]) { s += x } return s })() }}')).toBe(6);
    expect(run('={{ (({ name, ...rest }) => rest)($json) }}')).toEqual({ n: 3, tags: ['a', 'b', 'a'] });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the expression itself contains a template literal
    expect(run('={{ `${$json.name}!` }}')).toBe('Ada!');
    expect(run('={{ [...$json.tags, "c"].length }}')).toBe(4);
    expect(run('={{ (function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) })(5) }}')).toBe(120);
    expect(
      run(
        '={{ (() => { switch ($json.n) { case 1: return "one"; case 3: return "three"; default: return "?" } })() }}',
      ),
    ).toBe('three');
    expect(run('={{ (() => { try { throw new Error("x") } catch (e) { return e.message } })() }}')).toBe('x');
    expect(run('={{ typeof notDefinedAnywhere }}')).toBe('undefined');
  });

  it('provides data transformation extensions', () => {
    expect(run('={{ $json.tags.unique() }}')).toEqual(['a', 'b']);
    expect(run('={{ "hello world".toTitleCase() }}')).toBe('Hello World');
    expect(run('={{ "a@b.co".isEmail() }}')).toBe(true);
    expect(run('={{ [1,2,3].sum() }}')).toBe(6);
    expect(run('={{ (3.14159).round(2) }}')).toBe(3.14);
    expect(run('={{ ({ a: 1, b: null }).compact() }}')).toEqual({ a: 1 });
    expect(run('={{ "2024-01-15".toDateTime().format("yyyy/MM/dd") }}')).toBe('2024/01/15');
  });

  it('exposes $input, $(), $execution, $workflow, luxon and jmespath', () => {
    const items: Item[] = [{ json: { v: 1 } }, { json: { v: 2 } }];
    const c = ctx(items, { itemIndex: 1 });
    expect(ev.evaluate('={{ $input.all().length }}', c)).toBe(2);
    expect(ev.evaluate('={{ $input.item.json.v }}', c)).toBe(2);
    expect(ev.evaluate('={{ $itemIndex }}', c)).toBe(1);
    expect(ev.evaluate('={{ $execution.id }}', c)).toBe('ex1');
    expect(ev.evaluate('={{ $workflow.name }}', c)).toBe('Test');
    expect(ev.evaluate('={{ $parameter.a }}', c)).toBe(1);
    expect(ev.evaluate('={{ DateTime.fromISO("2020-01-01").year }}', c)).toBe(2020);
    expect(ev.evaluate('={{ $jmespath({a: [{b: 1}, {b: 2}]}, "a[*].b") }}', c)).toEqual([1, 2]);
    expect(ev.evaluate('={{ $ifEmpty("", "x") }}', c)).toBe('x');
  });

  it('resolves paired items through $("Node").item', () => {
    const runData: RunData = {
      Start: [
        {
          startTime: 0,
          executionTime: 0,
          executionStatus: 'success',
          source: [],
          data: { main: [[{ json: { id: 'a' } }, { json: { id: 'b' } }]] },
        },
      ],
      Filter: [
        {
          startTime: 0,
          executionTime: 0,
          executionStatus: 'success',
          source: [{ previousNode: 'Start' }],
          data: { main: [[{ json: { kept: true }, pairedItem: { item: 1 } }]] },
        },
      ],
    };
    const c = ctx([{ json: { kept: true }, pairedItem: { item: 1 } }], {
      runData,
      workflow: {
        name: 'x',
        active: false,
        nodes: {
          Start: { id: '1', name: 'Start', type: 't', typeVersion: 1, position: [0, 0], parameters: {} },
          Filter: { id: '2', name: 'Filter', type: 't', typeVersion: 1, position: [0, 0], parameters: {} },
          Set: { id: '3', name: 'Set', type: 't', typeVersion: 1, position: [0, 0], parameters: {} },
        },
      },
      executeData: { node: 'Set', data: {}, source: { main: [{ previousNode: 'Filter' }] } },
    });
    expect(ev.evaluate('={{ $("Start").item.json.id }}', c)).toBe('b');
    expect(ev.evaluate('={{ $("Start").all().length }}', c)).toBe(2);
    expect(ev.evaluate('={{ $("Start").first().json.id }}', c)).toBe('a');
  });
});

describe('expression security', () => {
  const blocked = [
    '={{ "".constructor.constructor("return process")() }}',
    '={{ $json.constructor }}',
    '={{ (() => {}).constructor("return 1")() }}',
    '={{ $json["const" + "ructor"] }}',
    '={{ [].__proto__ }}',
    '={{ ({}).__proto__.polluted = 1 }}',
    '={{ Object.getPrototypeOf({}) }}',
    '={{ process }}',
    '={{ require("fs") }}',
    '={{ globalThis }}',
    '={{ this.constructor }}',
    '={{ Function("return 1") }}',
    '={{ eval("1") }}',
    '={{ Reflect }}',
    '={{ (async () => 1)() }}',
    '={{ (function* () {})() }}',
    '={{ $env.HOME }}',
    '={{ Math.floor = () => 0 }}',
    '={{ JSON.parse = 1 }}',
    '={{ DateTime.now = () => 1 }}',
    '={{ Object.assign(Math, { floor: 1 }) }}',
    '={{ $json.name = "x" }}',
    '={{ ({ get x() { return 1 } }) }}',
    '={{ ({ __proto__: null }) }}',
    '={{ (({ constructor }) => constructor)("") }}',
    '={{ "x".repeat(1e9) }}',
    '={{ Array.from({ length: 1e9 }) }}',
    '={{ (() => { while (true) {} })() }}',
    '={{ (() => { let s = "ab"; for (let i = 0; i < 40; i++) s += s; return s.length })() }}',
    '={{ (() => { try { while(true){} } catch (e) { return "swallowed" } })() }}',
    '={{ new Function("return 1") }}',
    '={{ new (() => 1)() }}',
    '={{ setTimeout }}',
  ];

  for (const expr of blocked) {
    it(`blocks: ${expr}`, () => {
      expect(() => run(expr)).toThrow(ExpressionError);
    });
  }

  it('does not leak mutations of shared globals between evaluations', () => {
    expect(() => run('={{ Math.max = Math.min }}')).toThrow();
    expect(run('={{ Math.max(1, 2) }}')).toBe(2);
    expect(Math.max(1, 2)).toBe(2);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('allows mutation of objects created by the expression itself', () => {
    expect(run('={{ (() => { const o = { ...$json }; o.name = "Bob"; return o.name })() }}')).toBe('Bob');
    expect(run('={{ (() => { const a = []; a.push(1); a[1] = 2; return a })() }}')).toEqual([1, 2]);
  });
});
