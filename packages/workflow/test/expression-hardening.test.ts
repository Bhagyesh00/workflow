import { DateTime, Duration } from 'luxon';
import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  createSafeRegExp,
  type ExpressionDataContext,
  ExpressionError,
  ExpressionEvaluator,
  evaluateSimple,
  findExtension,
  type Item,
} from '../src';

const evaluate = (expression: string, variables: Record<string, unknown> = {}, timeoutMs = 1000) =>
  evaluateSimple(expression, variables, { timeoutMs });

/** fails unless `run` throws an ExpressionError matching `pattern` within `ms` */
function expectFastError(run: () => unknown, pattern: RegExp, ms = 1000) {
  const start = Date.now();
  expect(run).toThrow(pattern);
  expect(Date.now() - start).toBeLessThan(ms);
}

describe('regex safety policy (R19a)', () => {
  const catastrophic = [
    "={{ /^(a+)+$/.test('a'.repeat(20) + '!') }}",
    "={{ /^(a*)*$/.test('a'.repeat(20) + '!') }}",
    "={{ /^(a|a)+$/.test('a'.repeat(20) + '!') }}",
    "={{ /^(a|ab)*$/.test('a'.repeat(20) + '!') }}",
    "={{ /^(\\w|\\d)+$/.test('1'.repeat(20) + '!') }}",
    "={{ /^(a?){20}a{20}$/.test('a'.repeat(20)) }}",
    "={{ /(a)\\1/.test('aa') }}",
    "={{ /(?<x>a)\\k<x>/.test('aa') }}",
    "={{ RegExp('^(a+)+$').test('a'.repeat(20) + '!') }}",
    "={{ new RegExp('^(a+)+$').test('a'.repeat(20) + '!') }}",
    "={{ RegExp(/^(a+)+$/).test('a'.repeat(20) + '!') }}",
    "={{ ('a'.repeat(20) + '!').match('^(a+)+$') }}",
    "={{ ('a'.repeat(20) + '!').search('^(a+)+$') }}",
    "={{ [...('a'.repeat(20) + '!').matchAll('^(a+)+$')] }}",
    "={{ ''.match.call('a'.repeat(20) + '!', '^(a+)+$') }}",
    "={{ (() => { const m = ''.match; return m.apply('a'.repeat(20) + '!', ['^(a+)+$']) })() }}",
    "={{ new Map([['^(a+)+$', 'a'.repeat(20) + '!']]).forEach((() => 0).call, ''.search) }}",
    "={{ (() => { const r = /a/; r.compile('^(a+)+$'); return r.test('a'.repeat(20) + '!') })() }}",
  ];

  for (const expression of catastrophic) {
    it(`rejects ${expression}`, { timeout: 5000 }, () => {
      expect(() => evaluate(expression)).toThrow(ExpressionError);
    });
  }

  it('keeps ordinary regexes working', () => {
    expect(evaluate("={{ /^[a-z]+@[a-z]+\\.com$/i.test('Ada@example.com') }}")).toBe(true);
    expect(evaluate("={{ /^(foo|bar)+$/.test('foobarfoo') }}")).toBe(true);
    expect(evaluate("={{ '555-1234'.replace(/(\\d{3})-(\\d{4})/, '$2-$1') }}")).toBe('1234-555');
    expect(evaluate("={{ 'a,b;c'.split(/[,;]/) }}")).toEqual(['a', 'b', 'c']);
    expect(evaluate("={{ 'x1y22'.match(/\\d+/g) }}")).toEqual(['1', '22']);
    expect(evaluate("={{ RegExp('^ab?c$').test('ac') }}")).toBe(true);
    expect(evaluate("={{ 'a.b'.split('.') }}")).toEqual(['a', 'b']);
    expect(evaluate("={{ 'aXbX'.replaceAll('X', '-') }}")).toBe('a-b-');
  });

  const polynomial = [
    '^.*.*=$',
    '^.*.*.*.*.*=$',
    '^\\d*\\d*\\d*\\d*\\d*\\d*\\d*\\d*x$',
    '^\\s*-?\\s*x$',
    '^(.*)(.*)$',
    '^.*a.*a.*=$',
    `^${'(a|a)'.repeat(20)}$`,
    '^((a|a)b)*$',
    '^((?=a+)a)*$',
    '^(\\w+\\w)+$',
    '^(a+ba+)+$',
    '^(\\w+\\.?)+$',
    '^(a+)+$',
    '^(a*)*$',
    '^(a|a)*$',
    '(a)\\1',
    '^(a{2}(a){1,3}){0,}\\d+!$',
  ];
  for (const pattern of polynomial) {
    it(`rejects the polynomial or exponential pattern /${pattern}/`, () => {
      expect(() => createSafeRegExp(pattern)).toThrow(/not allowed/);
    });
  }

  it('rejects the unrolled patterns from the review quickly', { timeout: 5000 }, () => {
    expectFastError(() => evaluate("={{ /^.*.*.*.*.*=$/.test('x'.repeat(150)) }}", {}, 200), /not allowed/);
    expectFastError(
      () => evaluate(`={{ RegExp('^' + '(a|a)'.repeat(20) + '$').test('a'.repeat(20) + '!') }}`),
      /not allowed/,
    );
  });

  it('accepts common linear patterns with a separator after each repeat', () => {
    const linear: [string, string, boolean][] = [
      ['^[\\w.+-]+@([\\w-]+\\.)+[\\w-]{2,}$', 'ada.l+x@mail.example.com', true],
      ['^[\\w.+-]+@([\\w-]+\\.)+[\\w-]{2,}$', 'ada@localhost', false],
      ['^(\\d+,)*\\d+$', '1,22,333', true],
      ['^(,\\d+)*$', ',1,22', true],
      ['^(?:[a-z]+\\s)*[a-z]+$', 'the quick fox', true],
      ['^(.*)-(.*)$', 'left-right', true],
      ['^\\d+\\.\\d+\\.\\d+\\.\\d+$', '10.0.0.1', true],
      ['\\d{1,3}(,\\d{3})*', '1,234,567', true],
      ['^\\w+\\s+\\w+$', 'two words', true],
      ['^(?:\\w+\\.)*\\w+$', 'a.b.c', true],
      ['^(foo|bar)+$', 'foobar', true],
      ['^(?!-)[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}$', 'sub.example.com', true],
      ['^(\\s*\\w+\\s*,)*\\s*\\w+\\s*$', 'a , b,c ', true],
    ];
    for (const [pattern, input, expected] of linear) {
      expect(createSafeRegExp(pattern).test(input), pattern).toBe(expected);
    }
    // with the i flag, non-ASCII whitespace no longer counts as "any character"
    expect(createSafeRegExp('(\\d+)\\s*(kg|g|lb)', 'i').test('12 KG')).toBe(true);
    expect(createSafeRegExp('^[a-z]+\\s[\\u00e0-\\u00ff]+$', 'iu').test('Caf ÉÈ')).toBe(true);
    expect(() => createSafeRegExp('^(k|\\u212a)+$', 'iu')).toThrow(ExpressionError);
    expect(evaluate("={{ 'a@b.co'.match(/^[\\w.+-]+@([\\w-]+\\.)+[\\w-]{2,}$/) !== null }}")).toBe(true);
  });

  it('exports createSafeRegExp with the same policy', () => {
    expect(createSafeRegExp('^ab+c$', 'i').test('ABBC')).toBe(true);
    expect(() => createSafeRegExp('^(a+)+$')).toThrow(ExpressionError);
    expect(() => createSafeRegExp('(x)\\1')).toThrow(ExpressionError);
    expect(() => createSafeRegExp('([a-z]')).toThrow(ExpressionError);
    expect(() => createSafeRegExp('^(?:[A-Z]|b)+$', 'i')).toThrow(ExpressionError);
    expect(() => createSafeRegExp('^(s|\\u017f)+$', 'iu')).toThrow(ExpressionError);
    expect(() => createSafeRegExp('^(.|a)+$', 's')).toThrow(ExpressionError);
    expect(createSafeRegExp('^(.|\\n)*$').test('a\nb')).toBe(true);
    expect(createSafeRegExp('^(?:[a-c]|[x-z])+$', 'i').test('AbXz')).toBe(true);
  });
});

describe('deadline checks (R19b)', () => {
  let clock: MockInstance<() => number> | undefined;

  afterEach(() => {
    clock?.mockRestore();
    clock = undefined;
  });

  function fakeClock() {
    let now = 1_000_000;
    clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 10;
      return now;
    });
  }

  it('checks the deadline on every loop iteration', () => {
    fakeClock();
    expect(() =>
      evaluate('={{ (() => { let n = 0; for (let i = 0; i < 50; i++) n++; return n })() }}', {}, 100),
    ).toThrow(/time limit/);
  });

  it('checks the deadline on every call', () => {
    fakeClock();
    expect(() =>
      evaluate('={{ [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((x) => x * 2) }}', {}, 100),
    ).toThrow(/time limit/);
  });
});

describe('allocation budget (R19c)', () => {
  it('stops native producers once the cumulative budget is spent', { timeout: 10_000 }, () => {
    expect(() =>
      evaluate("={{ Array.from({ length: 30 }, (_, i) => 'x'.repeat(3e6 + i).toUpperCase()).length }}"),
    ).toThrow(/allocation/);
  });

  it('charges join, concat, padStart and template literals', { timeout: 10_000 }, () => {
    expect(() =>
      evaluate("={{ Array.from({ length: 100 }, () => 'y'.padStart(2e6, 'x')).join('').length }}"),
    ).toThrow(/allocation/);
    expect(() =>
      evaluate(
        "={{ (() => { const s = 'x'.repeat(1.5e7); return [s.concat(s), s.concat(s), `${s}${s}`] })().length }}",
      ),
    ).toThrow(/allocation/);
    expect(() =>
      evaluate(
        "={{ (() => { const a = 'x'.repeat(2e7); const b = 'y'.repeat(2e7); return Array.from({ length: 3e5 }).join('z'.repeat(100)).length })() }}",
      ),
    ).toThrow(/allocation/);
  });

  it('cannot be swallowed by try/catch', { timeout: 10_000 }, () => {
    expect(() =>
      evaluate(
        "={{ (() => { const a = 'x'.repeat(3e7); const b = 'y'.repeat(3e7); try { return 'z'.repeat(1e7) } catch (e) { return 0 } })() }}",
      ),
    ).toThrow(/allocation/);
  });

  const doubling = (body: string) =>
    `={{ (() => { let x = ['xxxxxxxxxxxxxxx']; for (let i = 0; i < 24; i++) x = [x, x]; return ${body} })() }}`;

  it('projects nested and repeated conversions before the native call', { timeout: 10_000 }, () => {
    for (const body of [
      'String(x).length',
      '`${x}`.length',
      "(x + '').length",
      "x.join('').length",
      'x.toString().length',
      'x.toLocaleString().length',
      'JSON.stringify(x).length',
      'x.flat(Infinity).length',
      "'a'.concat(x).length",
      'encodeURIComponent(x).length',
      'Number(x)',
      "x == 'a'",
      '({})[x]',
      'new Error(x).message.length',
    ]) {
      expectFastError(() => evaluate(doubling(body), {}, 1000), /allocation|exceeds|time limit/, 2000);
    }
    expectFastError(
      () => evaluate('={{ String.raw({ raw: { length: 5e7 } }).length }}'),
      /allocation|exceeds|time limit/,
    );
    expectFastError(
      () =>
        evaluate(
          "={{ (() => { const s = 'x'.repeat(3e7); return Array.from({ length: 17 }, () => s).join('').length })() }}",
        ),
      /allocation|exceeds|time limit/,
    );
    expectFastError(
      () =>
        evaluate(
          "={{ (() => { const s = 'x'.repeat(3e7); return [s, s, s].flatMap(() => [s, s]).join('').length })() }}",
        ),
      /allocation|exceeds|time limit/,
    );
    expectFastError(
      () =>
        evaluate(
          "={{ (() => { const s = 'é'.repeat(6e6); return encodeURIComponent(s).length })() }}",
          {},
          1000,
        ),
      /allocation|exceeds/,
    );
    expectFastError(() => evaluate(doubling('x')), /too large|allocation|exceeds/, 2000);
  });

  it('projects conversions inside extensions and default sorts', { timeout: 60_000 }, () => {
    for (const body of [
      '[x].sum()',
      '[x].average()',
      '[x].max()',
      '[x].unique().length',
      '[x, 1].difference([x]).length',
      '[1].union([x]).length',
      'x.toJsonString().length',
      '({ k: x }).toJsonString().length',
      "[{ k: x }].smartJoin('k', 'v')",
      "[{ k: x }, { k: 1 }].sortBy('k').length",
      "['a'].pluck(x)",
      '({ a: 1 }).hasField(x)',
      "'a'.quote(x)",
      '(1).round(x)',
      'DateTime.now().isBetween(x, x)',
      '[x, x].sort().length',
      '[x].toSorted().length',
      "$jmespath(x, 'to_string(@)').length",
    ]) {
      expectFastError(() => evaluate(doubling(body), {}, 1000), /allocation|exceeds/, 2000);
    }
  });

  it('refuses arguments that repeat shared parts beyond the budget, whatever the native', {
    timeout: 60_000,
  }, () => {
    for (const body of [
      '[1].at(x)',
      '[1, 2].slice(x).length',
      'Object.fromEntries([[x, 1]])',
      'Object.hasOwn({}, [x])',
      'DateTime.now().set({ year: x }).year',
      'new Intl.NumberFormat([x])',
      'new URLSearchParams({ k: x }).toString().length',
      'Object.fromEntries(new Map([[x, 1]]))',
      "(() => { const s = 'x'.repeat(3e7); return Object.fromEntries([[[s, s, s], 1]]) })()",
      // guarded globals handed to natives keep their checks
      '[x].map(Number)',
      '[x].map(String)',
      'Array.from([x], String)',
      'Number.call(null, x)',
      'String.apply(null, [x])',
    ]) {
      expectFastError(() => evaluate(doubling(body), {}, 1000), /allocation|exceeds/, 2000);
    }
    expect(
      evaluate(
        '={{ (() => { const row = { a: 1 }; const rows = [row, row, [row]]; return [].concat(rows).length })() }}',
      ),
    ).toBe(3);
    expect(evaluate("={{ Object.fromEntries([['a', [1, [2]]]]).a[1][0] + [5, 6].at([1]) }}")).toBe(8);
  });

  it('keeps extension and default sort results unchanged within the budget', () => {
    expect(evaluate('={{ [[2, 1], [10], 3, undefined, [1, [0]]].sort() }}')).toEqual([
      [1, [0]],
      [10],
      [2, 1],
      3,
      undefined,
    ]);
    expect(evaluate("={{ (() => { const a = [[2], 'b', [1]]; a.sort(); return a })() }}")).toEqual([
      [1],
      [2],
      'b',
    ]);
    expect(evaluate('={{ [[2], [1, 1]].toSorted() }}')).toEqual([[1, 1], [2]]);
    expect(evaluate('={{ [[1, 2], 3].sum() + [[4]].max() + [[2], [4]].average() }}')).toBe(Number.NaN);
    expect(evaluate('={{ [[4]].max() + [[2], [4]].average() + [[7]].sum() }}')).toBe(14);
    expect(evaluate('={{ [{ a: [1] }, { a: [1] }, { a: 2 }].unique().length }}')).toBe(2);
    expect(evaluate("={{ [{ k: ['a', 'b'], v: 1 }].smartJoin('k', 'v') }}")).toEqual({ 'a,b': 1 });
    expect(evaluate("={{ [{ k: [2] }, { k: [10] }].sortBy('k').map((o) => o.k[0]) }}")).toEqual([10, 2]);
    expect(
      evaluate("={{ ['a', 'b'].toJsonString() + ({ a: [1] }).toJsonString() + 'x'.toJsonString() }}"),
    ).toBe('["a","b"]{"a":[1]}"x"');
    expect(evaluate('={{ [1, 2, 3].chunk(2) }}')).toEqual([[1, 2], [3]]);
    expect(evaluate("={{ new Date('2024-03-05T00:00:00Z').extract('month') }}")).toBe(3);
  });

  it('rejects a chunk size that is not a positive integer', { timeout: 5000 }, () => {
    expectFastError(() => evaluate('={{ [1].chunk(1e-300) }}'), /chunk size/);
    expectFastError(() => evaluate('={{ [1, 2].chunk(0.5) }}'), /chunk size/);
  });

  it('shares one budget across the segments of a template', { timeout: 10_000 }, () => {
    const busy = '{{ (() => { const t = Date.now(); while (Date.now() - t < 120) {} return 1 })() }}';
    expectFastError(
      () => evaluate(`=${busy.repeat(10)}`, {}, 200),
      /time limit|maximum number of steps/,
      1000,
    );
    expectFastError(() => evaluateSimple(`=${'{{ big }}'.repeat(40)}`, { big: 'x'.repeat(1e6) }), /exceeds/);
    expect(evaluate('=a{{ 1 }}b{{ [2] }}c')).toBe('a1b[2]c');
  });

  it('keeps nested conversions working within the budget', () => {
    expect(evaluate("={{ [[1, [2, null]], undefined, 'a'].join('-') }}")).toBe('1,2,--a');
    expect(evaluate('={{ String([1, [2, 3]]) + `${[4, [5]]}` }}')).toBe('1,2,34,5');
    expect(evaluate('={{ [1, [2]] + 1 }}')).toBe('1,21');
    expect(evaluate("={{ [1] == '1' && ({ a: 1 })[['a']] === 1 }}")).toBe(true);
    expect(evaluate('={{ (() => { const a = [1]; a.push(a); return String(a) })() }}')).toBe('1,');
    expect(
      evaluate(
        '={{ JSON.stringify({ a: [1, { b: "x" }], d: DateTime.fromISO("2020-01-02T00:00:00Z").toUTC() }) }}',
      ),
    ).toBe('{"a":[1,{"b":"x"}],"d":"2020-01-02T00:00:00.000Z"}');
    expect(evaluate('={{ JSON.stringify({ a: [1] }, null, 2) }}')).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(evaluate('={{ JSON.stringify({ a: 1, b: 2 }, ["b"]) }}')).toBe('{"b":2}');
    expect(
      evaluate(
        '={{ JSON.stringify({ a: 1, b: { toJSON: () => 3 } }, (k, v) => (k === "a" ? undefined : v)) }}',
      ),
    ).toBe('{"b":3}');
    expect(evaluate('={{ [[1, 2], [3]].flat(Infinity) }}')).toEqual([1, 2, 3]);
    expect(evaluate('={{ [1, 2].flatMap((x) => [x, x * 10]) }}')).toEqual([1, 10, 2, 20]);
    expect(evaluate('={{ String.raw`a${1}b${[2, 3]}c` }}')).toBe('a1b2,3c');
    expect(evaluate("={{ encodeURIComponent('a b/é') + btoa('hi') }}")).toBe('a%20b%2F%C3%A9aGk=');
  });

  it('does not let try/catch repeat an oversized allocation', { timeout: 10_000 }, () => {
    expectFastError(
      () =>
        evaluate(
          "={{ (() => { const s = 'x'.repeat(2e7); for (let i = 0; i < 100; i++) { try { s.padEnd(4e7) } catch (e) {} } return 1 })() }}",
        ),
      /exceeds/,
    );
  });

  it('does not charge loops that build output incrementally', () => {
    expect(
      evaluate(
        "={{ (() => { let s = ''; const a = []; for (let i = 0; i < 5000; i++) { s += 'x'.repeat(4000); a.push(...[i, i]) } return s.length + a.length })() }}",
        {},
        10_000,
      ),
    ).toBe(20_010_000);
  });
});

describe('opt-in mutation and luxon facades (R20)', () => {
  const minutesInTwoHours = () => Duration.fromObject({ hours: 2 }).as('minutes');
  const mondayIsWeekend = () => DateTime.fromISO('2026-10-26', { locale: 'en-US' }).isWeekend;

  const attacks = [
    '={{ (() => { const m = Duration.fromObject({ hours: 1 }).matrix; m.hours.minutes = 1; return 1 })() }}',
    '={{ (() => { const m = ({ ...Duration.fromObject({ hours: 1 }) }).matrix; m.hours.minutes = 1; return 1 })() }}',
    '={{ (() => { const m = Object.values(Duration.fromObject({ hours: 1 })).find((v) => v && v.hours && v.hours.minutes); m.hours.minutes = 1; return 1 })() }}',
    '={{ (() => { const { matrix } = Duration.fromObject({ hours: 1 }); matrix.hours.minutes = 1; return 1 })() }}',
    "={{ DateTime.now().setLocale('en-US').loc.getWeekSettings().weekend = [1, 2, 3, 4, 5, 6, 7] }}",
    "={{ DateTime.now().setLocale('en-US').loc.getWeekSettings().weekend.push(1, 2, 3, 4, 5) }}",
    "={{ $jmespath(DateTime.now().setLocale('en-US'), 'loc').getWeekSettings().weekend.push(1, 2, 3, 4, 5) }}",
    "={{ (() => { const h = $jmespath({ d: Duration.fromObject({ hours: 1 }) }, 'd.matrix.hours'); h.minutes = 1; return 1 })() }}",
    "={{ Object.assign($jmespath({ d: Duration.fromObject({ hours: 1 }) }, 'd.matrix.hours'), { minutes: 1 }) }}",
    '={{ Object.assign(Duration.fromObject({ hours: 1 }).matrix.hours, { minutes: 1 }) }}',
    "={{ DateTime.DATE_SHORT.month = 'long' }}",
    "={{ Object.assign(DateTime.DATE_SHORT, { month: 'long' }) }}",
    '={{ [DateTime.DATE_SHORT].forEach(Object.assign) }}',
    '={{ DateTime.now().c.year = 1 }}',
    "={{ (() => { const m = JSON.parse('0', () => $jmespath(Duration.fromObject({ hours: 1 }), 'matrix')); m.hours.minutes = 1; return 1 })() }}",
    "={{ (() => { const m = JSON.parse('[0]', (k, v) => (k === '0' ? $jmespath(Duration.fromObject({ hours: 1 }), 'matrix') : v))[0]; m.hours.minutes = 1; return 1 })() }}",
    "={{ (() => { const m = [$jmespath(Duration.fromObject({ hours: 1 }), 'matrix')].first(); m.hours.minutes = 1; return 1 })() }}",
  ];

  for (const expression of attacks) {
    it(`blocks ${expression} and leaves host luxon untouched`, () => {
      expect(() => evaluate(expression)).toThrow(ExpressionError);
      expect(minutesInTwoHours()).toBe(120);
      expect(mondayIsWeekend()).toBe(false);
      expect(DateTime.DATE_SHORT).toEqual({ year: 'numeric', month: 'numeric', day: 'numeric' });
    });
  }

  it('blocks mutating natives reached through call indirection on shared data', () => {
    const shared = { list: [1, 2], map: new Map([['k', 1]]) };
    expect(() => evaluate('={{ shared.list.push(3) }}', { shared })).toThrow(ExpressionError);
    expect(() => evaluate('={{ [shared.list].forEach((() => 0).call, [].push) }}', { shared })).toThrow(
      ExpressionError,
    );
    expect(() => evaluate('={{ [].push.call(shared.list, 3) }}', { shared })).toThrow(ExpressionError);
    expect(() => evaluate("={{ shared.map.set('k', 2) }}", { shared })).toThrow(ExpressionError);
    expect(() => evaluate('={{ shared.list.sort((a, b) => b - a) }}', { shared })).toThrow(ExpressionError);
    expect(() => evaluate('={{ delete shared.list[0] }}', { shared })).toThrow(ExpressionError);
    expect(() => evaluate('={{ shared.extra = 1 }}', { shared })).toThrow(ExpressionError);
    expect(shared.list).toEqual([1, 2]);
    expect(shared.map.get('k')).toBe(1);
    expect(shared).not.toHaveProperty('extra');
  });

  it('freezes luxon format presets', () => {
    expect(Object.isFrozen(DateTime.DATE_SHORT)).toBe(true);
    expect(Object.isFrozen(DateTime.DATETIME_FULL)).toBe(true);
  });

  it('still allows mutation of values the expression created', () => {
    expect(evaluate('={{ (() => { const o = { a: 1 }; o.b = 2; delete o.a; return o })() }}')).toEqual({
      b: 2,
    });
    expect(evaluate('={{ (() => { const a = [3, 1, 2]; a.sort(); a.push(4); return a })() }}')).toEqual([
      1, 2, 3, 4,
    ]);
    expect(evaluate("={{ 'c,a,b'.split(',').sort().reverse() }}")).toEqual(['c', 'b', 'a']);
    expect(evaluate('={{ list.map((x) => x * 2).reverse() }}', { list: [1, 2] })).toEqual([4, 2]);
    expect(evaluate('={{ Object.keys({ b: 1, a: 2 }).sort() }}')).toEqual(['a', 'b']);
    expect(evaluate('={{ Object.assign({}, { a: 1 }) }}')).toEqual({ a: 1 });
    expect(
      evaluate('={{ (() => { const o = JSON.parse(\'{"a":{"b":[1]}}\'); o.a.b.push(2); return o })() }}'),
    ).toEqual({
      a: { b: [1, 2] },
    });
    expect(evaluate("={{ (() => { const m = new Map(); m.set('a', 1); return m.get('a') })() }}")).toBe(1);
    expect(
      evaluate('={{ (() => { const [first, ...rest] = [1, 2, 3]; rest.push(4); return rest })() }}'),
    ).toEqual([2, 3, 4]);
    expect(evaluate('={{ DateTime.fromISO("2020-01-02").toObject().year }}')).toBe(2020);
    expect(evaluate('={{ Duration.fromObject({ hours: 1 }).as("minutes") }}')).toBe(60);
    expect(
      evaluate(`={{ JSON.parse('{"a":1,"b":[2]}', (k, v) => (typeof v === 'number' ? v * 10 : v)) }}`),
    ).toEqual({
      a: 10,
      b: [20],
    });
    expect(evaluate("={{ (() => { const t = ['b', 'a'].unique(); t.sort(); return t })() }}")).toEqual([
      'a',
      'b',
    ]);
    expect(evaluate('={{ ({ b: 1, a: 2 }).keys().sort() }}')).toEqual(['a', 'b']);
  });
});

describe('input data stays writable (n8n parity, R20)', () => {
  const ev = new ExpressionEvaluator({ timeoutMs: 1000 });
  const matrix = "$jmespath(Duration.fromObject({ hours: 1 }), 'matrix')";

  function context(): ExpressionDataContext {
    const items: Item[] = [
      { json: { id: 'b', n: 2, tags: ['y', 'x'], list: [1], nested: { deep: [3] } } },
      { json: { id: 'a', n: 1, tags: [], list: [], nested: { deep: [] } } },
    ];
    return {
      workflow: {
        id: 'wf1',
        name: 'Test',
        active: false,
        nodes: {
          Start: { id: '1', name: 'Start', type: 't', typeVersion: 1, position: [0, 0], parameters: {} },
          Set: {
            id: '2',
            name: 'Set',
            type: 't',
            typeVersion: 1,
            position: [0, 0],
            parameters: { opts: { a: 1 } },
          },
        },
      },
      runData: {
        Start: [
          { startTime: 0, executionTime: 0, data: { main: [[{ json: { v: 2 } }, { json: { v: 1 } }]] } },
        ],
      },
      activeNodeName: 'Set',
      connectionInputData: items,
      itemIndex: 0,
      runIndex: 0,
      mode: 'manual',
      executionId: 'ex1',
      timezone: 'UTC',
      nodeParameters: { opts: { a: 1 }, list: [] },
      extra: {
        // host helpers that hand back what they are given ($fromAI returns its default)
        $pick: (value: unknown) => value,
        $Make: function (this: unknown, value: unknown) {
          return value;
        },
      },
    } as unknown as ExpressionDataContext;
  }

  it('sorts, reverses, pushes into and assigns on input data and parameters', () => {
    const ctx = context();
    expect(ev.evaluate("={{ $json.tags.sort().join(', ') }}", ctx)).toBe('x, y');
    expect(ev.evaluate('={{ $json.list.push(1) }}', ctx)).toBe(2);
    expect(ev.evaluate('={{ ($json.extra = { k: [1] }).k.length }}', ctx)).toBe(1);
    expect(ev.evaluate('={{ $json.extra.k.push(2) }}', ctx)).toBe(2);
    expect(ev.evaluate("={{ Object.assign($json, { more: 'x' }).more }}", ctx)).toBe('x');
    expect(ev.evaluate('={{ $input.all().sort((a, b) => a.json.n - b.json.n)[0].json.id }}', ctx)).toBe('a');
    expect(ev.evaluate("={{ $('Start').all().reverse()[0].json.v }}", ctx)).toBe(1);
    expect(ev.evaluate('={{ $items().map((i) => i.json.nested).forEach((n) => n.deep.push(9)) }}', ctx)).toBe(
      undefined,
    );
    expect(
      ev.evaluate('={{ (() => { for (const i of $input.all()) i.json.seen = true; return 1 })() }}', ctx),
    ).toBe(1);
    expect(ev.evaluate('={{ ($parameter.opts.b = 2) + $parameter.list.push(1) }}', ctx)).toBe(3);
    expect(ev.evaluate('={{ $node["Start"].json.v }}', ctx)).toBe(1);
    expect(ctx.connectionInputData[0].json).toMatchObject({ id: 'a', seen: true });
    expect(ctx.connectionInputData[1].json).toMatchObject({
      tags: ['x', 'y'],
      list: [1, 1],
      extra: { k: [1, 2] },
    });
    expect(ctx.connectionInputData[1].json.nested).toEqual({ deep: [3, 9] });
    expect(ctx.nodeParameters).toEqual({ opts: { a: 1, b: 2 }, list: [1] });
  });

  it('never turns host or library objects into data', () => {
    const attacks = [
      `$json.m = ${matrix}`,
      `$json.list.push(${matrix})`,
      `$json.list.splice(0, 0, ${matrix})`,
      `$json.list.unshift([${matrix}])`,
      `$json.list.fill(${matrix})`,
      `Object.assign($json, { m: ${matrix} })`,
      `(() => { const o = {}; $json.o = o; o.m = ${matrix}; return 1 })()`,
      `(() => { const o = { a: [] }; $json.o = o; o.a.push(${matrix}); return 1 })()`,
      `($json.f = JSON)`,
      `($json.d = DateTime.DATE_SHORT)`,
      `(() => { const m = $input.all().map(() => ${matrix})[0]; m.hours.minutes = 1; return 1 })()`,
      `(() => { const m = [${matrix}].concat($input.all())[0]; m.hours.minutes = 1; return 1 })()`,
      `(() => { const m = $now.toObject(); m.year = 1; return $now.year })()`,
      `(() => { const m = $json.list.concat([${matrix}]).last(); m.hours.minutes = 1; return 1 })()`,
      // inherited methods of frozen proxy objects are not data proxy functions
      `(() => { $input.valueOf; const m = ${matrix}; m.valueOf().hours.minutes = 1; return 1 })()`,
      `(() => { $execution.customData.valueOf; const m = ${matrix}; m.valueOf().hours.minutes = 1; return 1 })()`,
      // data helpers and constructors that return their argument do not launder it
      `(() => { const m = $pick(${matrix}); m.hours.minutes = 1; return 1 })()`,
      `$pick({ m: ${matrix} }).m.hours.minutes = 1`,
      `(() => { const m = new $Make(${matrix}); m.hours.minutes = 1; return 1 })()`,
      `Error.captureStackTrace(${matrix}.hours)`,
    ];
    for (const attack of attacks) {
      const ctx = context();
      expect(() => ev.evaluate(`={{ ${attack} }}`, ctx), attack).toThrow(ExpressionError);
      expect(Duration.fromObject({ hours: 2 }).as('minutes')).toBe(120);
    }
    const ctx = context();
    expect(() => ev.evaluate('={{ ($json.list = [JSON])[0].x = 1 }}', ctx)).toThrow(ExpressionError);
    expect(ev.evaluate('={{ ($json.when = $now) && 1 }}', ctx)).toBe(1);
    expect(() => ev.evaluate('={{ $json.when.c.year = 1 }}', ctx)).toThrow(ExpressionError);
    const hours = (Duration.fromObject({ hours: 1 }) as unknown as { matrix: { hours: object } }).matrix
      .hours;
    expect(Object.getOwnPropertyNames(hours)).not.toContain('stack');
  });

  it('never lets input data hold an object twice or grow beyond the budget', { timeout: 10_000 }, () => {
    const attacks = [
      // doubling through new containers, through containers already in the data, and through fill/copyWithin
      "(() => { $json.a = ['x'.repeat(1e5)]; for (let i = 0; i < 40; i++) $json.a = [$json.a, $json.a]; return 1 })()",
      '(() => { for (let i = 0; i < 40; i++) { const c = {}; $json.t = c; c.l = $json.a; c.r = $json.a; $json.a = c } return 1 })()',
      '(() => { const o = { s: [1] }; $json.list.push(o, o); return 1 })()',
      '(() => { $json.list.push(0, 0, 0); $json.list.fill({ a: 1 }); return 1 })()',
      '(() => { $json.list[0] = { a: 1 }; $json.list.push(0); $json.list.copyWithin(1, 0); return 1 })()',
      'Object.assign($json, { n: $json.nested })',
      '($json.copy = $json.nested)',
      // the same long string stored again and again
      "(() => { const s = 'x'.repeat(3e7); for (let i = 0; i < 100; i++) $json['k' + i] = s; return 1 })()",
      "(() => { const s = 'x'.repeat(3e7); for (let i = 0; i < 100; i++) $json.list.push(s); return 1 })()",
    ];
    for (const attack of attacks) {
      const ctx = context();
      const start = Date.now();
      expect(() => ev.evaluate(`={{ ${attack} }}`, ctx), attack).toThrow(ExpressionError);
      expect(Date.now() - start, attack).toBeLessThan(2000);
      expect(JSON.stringify(ctx.connectionInputData).length, attack).toBeLessThan(1e8);
    }
    const ctx = context();
    expect(
      ev.evaluate('={{ ($json.fresh = JSON.parse(JSON.stringify($json.nested))).deep.length }}', ctx),
    ).toBe(1);
    expect(ev.evaluate("={{ $json.list.push('x'.repeat(10)) + $json.tags.concat(['z']).length }}", ctx)).toBe(
      5,
    );
  });

  it('counts input data repeated in the result', { timeout: 10_000 }, () => {
    const ctx = context();
    ctx.connectionInputData[0].json.big = { text: 'x'.repeat(1e6) };
    expectFastError(
      () => ev.evaluate('={{ Array.from({ length: 1000 }, () => $json.big) }}', ctx),
      /too large/,
    );
    expect(ev.evaluate('={{ [$json.big].length }}', ctx)).toBe(1);
    expect(ev.evaluate('={{ $input.all().map((i) => i.json) }}', ctx)).toHaveLength(2);
  });

  it('keeps evaluateSimple variables read-only', () => {
    expect(() => evaluate('={{ items.sort((a, b) => a - b) }}', { items: [3, 1, 2] })).toThrow(
      ExpressionError,
    );
    expect(evaluate('={{ items.toSorted((a, b) => a - b) }}', { items: [3, 1, 2] })).toEqual([1, 2, 3]);
  });
});

describe('bounded native parsing (R19)', () => {
  it('rejects luxon formats that compile to backtracking regexes', { timeout: 5000 }, () => {
    expectFastError(
      () => evaluate("={{ DateTime.fromFormat('1'.repeat(43) + 'x', 'dH'.repeat(11)).isValid }}", {}, 200),
      /not allowed/,
      500,
    );
    expectFastError(
      () => evaluate("={{ DateTime.fromString('1'.repeat(43) + 'x', 'dH'.repeat(11)) }}"),
      /not allowed/,
      500,
    );
    expectFastError(
      () => evaluate("={{ DateTime.fromFormatExplain('1'.repeat(43) + 'x', 'dH'.repeat(11)) }}"),
      /not allowed/,
      500,
    );
    expectFastError(
      () =>
        evaluate(
          "={{ DateTime.fromFormatParser('1'.repeat(43) + 'x', DateTime.buildFormatParser('dH'.repeat(11))) }}",
        ),
      /not allowed/,
      500,
    );
    expectFastError(
      () => evaluate("={{ ('1'.repeat(43) + 'x').toDateTime('dH'.repeat(11)) }}"),
      /not allowed/,
      500,
    );
    expect(
      evaluate("={{ DateTime.fromFormat('2024-03-05 10:07', 'yyyy-MM-dd HH:mm').toFormat('d/M') }}"),
    ).toBe('5/3');
    expect(evaluate("={{ DateTime.fromFormat('5 Mar 2024', 'd MMM yyyy').month }}")).toBe(3);
    expect(evaluate("={{ '20240305'.toDateTime('yyyyMMdd').day }}")).toBe(5);
  });

  it('caps the formats luxon expands token by token', { timeout: 30_000 }, () => {
    for (const call of [
      "DateTime.now().toFormat('yyyy'.repeat(8e6))",
      "Duration.fromObject({ hours: 1 }).toFormat('h'.repeat(3e7))",
      "Interval.after(DateTime.now(), { hours: 1 }).toFormat('yyyy'.repeat(8e6))",
      "DateTime.now().format('yyyy'.repeat(8e6))",
      "new Date().format('yyyy'.repeat(8e6))",
      "DateTime.expandFormat('D'.repeat(3e7))",
    ]) {
      expectFastError(() => evaluate(`={{ ${call}.length }}`), /format is longer/, 1000);
    }
    expect(evaluate("={{ DateTime.fromISO('2024-03-05').toFormat(\"'Day' d 'of' MMMM yyyy\") }}")).toBe(
      'Day 5 of March 2024',
    );
  });

  it('runs the built-in extension scans in linear time', { timeout: 10_000 }, () => {
    const extension = (name: string) => findExtension('', name) as (s: string, ...args: unknown[]) => unknown;
    for (const [name, input] of [
      ['extractEmail', 'a'.repeat(2e5)],
      ['extractEmail', 'a@'.repeat(1e5)],
      ['removeTags', '<'.repeat(2e5)],
      ['removeMarkdown', '['.repeat(2e5)],
      ['removeMarkdown', '!['.repeat(1e5)],
      ['removeMarkdown', '[a]'.repeat(7e4)],
      ['isEmail', `a@${'.'.repeat(2e5)} `],
    ] as const) {
      const start = Date.now();
      extension(name)(input);
      expect(Date.now() - start, name).toBeLessThan(150);
    }
    expect(extension('extractEmail')('Mail <ada.l@ex.co.uk>, bob@x.io')).toBe('ada.l@ex.co.uk');
    expect(extension('extractEmail')('@x a@b c@d.e')).toBe('c@d.e');
    expect(extension('extractEmail')('x@y.z.w,q')).toBe('x@y.z.w');
    expect(extension('extractEmail')('nothing here')).toBe(undefined);
    expect(extension('removeTags')('a<b>c</b>d<e')).toBe('acd<e');
    expect(extension('removeMarkdown')('# T\n![img](u) [x[y](l) [z] (n) **b** `c`')).toBe(
      'T\nimg x[y [z] (n) b c',
    );
    expect(extension('removeMarkdown')('[](u) [a](b')).toBe('[](u) [a](b');
    expect(extension('isEmail')('a@b.co')).toBe(true);
    expect(extension('isEmail')('a@b..c')).toBe(true);
    expect(extension('isEmail')('a@.c')).toBe(false);
    expect(extension('isEmail')('a@bc.')).toBe(false);
    expect(extension('isEmail')('a b@c.d')).toBe(false);
  });
});
