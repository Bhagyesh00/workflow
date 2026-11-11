import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/args';
import { type OutputOptions, outputOptions, pickPath, render } from '../src/output';

const table: OutputOptions = { format: 'table', quiet: false, header: true };
const rows = [
  {
    id: 'a1',
    name: 'First',
    active: true,
    tags: [
      { id: 't', name: 'x' },
      { id: 'u', name: 'y' },
    ],
  },
  { id: 'b2', name: 'Second', active: false, tags: [] },
];

describe('outputOptions', () => {
  it('json when piped, table in a terminal, --format and --json win', () => {
    expect(outputOptions(parseArgs([]), false).format).toBe('json');
    expect(outputOptions(parseArgs([]), true).format).toBe('table');
    expect(outputOptions(parseArgs(['--format', 'id-only']), false).format).toBe('id-only');
    expect(outputOptions(parseArgs(['--json']), true).format).toBe('json');
    expect(outputOptions(parseArgs(['--quiet', '--no-header']), true)).toMatchObject({
      quiet: true,
      header: false,
    });
    expect(() => outputOptions(parseArgs(['--format', 'xml']), true)).toThrow(UsageError);
  });
});

describe('render', () => {
  it('a table has an upper-case header and padded columns', () => {
    const text = render(rows, table, ['id', 'name', 'active']);
    expect(text.split('\n')).toEqual(['ID  NAME    ACTIVE', 'a1  First   true', 'b2  Second  false', '']);
  });

  it('--no-header drops the header line; tags show their names', () => {
    const text = render(rows, { ...table, header: false }, ['id', 'tags']);
    expect(text).toBe('a1  x,y\nb2\n');
  });

  it('a single object is a field and value table', () => {
    expect(render({ id: 'a1', ok: true }, table)).toBe('FIELD  VALUE\nid     a1\nok     true\n');
  });

  it('json is pretty and ends with a newline; id-only prints one id per line', () => {
    expect(render(rows[0], { ...table, format: 'json' })).toBe(`${JSON.stringify(rows[0], null, 2)}\n`);
    expect(render(rows, { ...table, format: 'id-only' })).toBe('a1\nb2\n');
    expect(render(rows[0], { ...table, format: 'id-only' })).toBe('a1\n');
    expect(render([], { ...table, format: 'id-only' })).toBe('');
  });

  it('an empty list says so in a table and is [] in json', () => {
    expect(render([], table)).toBe('No results.\n');
    expect(render([], { ...table, format: 'json' })).toBe('[]\n');
  });

  it('control characters in a value cannot drive the terminal', () => {
    const text = render([{ id: '1', name: 'a\u001b[31mred\nline' }], table, ['name']);
    expect(text).not.toContain('\u001b');
    expect(text.trimEnd().split('\n')).toHaveLength(2);
  });

  it('a long value is cut', () => {
    const text = render([{ name: 'x'.repeat(200) }], table, ['name']);
    expect(text.split('\n')[1].length).toBeLessThanOrEqual(60);
  });

  it('--pick keeps one part before the format', () => {
    expect(render({ data: rows }, { ...table, format: 'json', pick: 'data[0].id' })).toBe('"a1"\n');
    expect(render({ data: rows }, { ...table, format: 'id-only', pick: 'data' })).toBe('a1\nb2\n');
  });
});

describe('pickPath', () => {
  const value = { data: [{ id: 1, n: { m: 'deep' } }, { id: 2 }], x: 'y' };
  it('walks keys, indexes and [] over arrays', () => {
    expect(pickPath(value, 'x')).toBe('y');
    expect(pickPath(value, 'data[0].n.m')).toBe('deep');
    expect(pickPath(value, 'data[].id')).toEqual([1, 2]);
    expect(pickPath(value, 'data.5')).toBeUndefined();
    expect(pickPath(value, 'nope.more')).toBeUndefined();
  });
  it('never reads the prototype', () => {
    expect(pickPath(value, 'constructor')).toBeUndefined();
    expect(pickPath(value, '__proto__')).toBeUndefined();
  });
  it('a path with no steps is a usage error', () => {
    expect(() => pickPath(value, '...')).toThrow(UsageError);
  });
});
