import { describe, expect, it } from 'vitest';
import { flagInt, flagOn, flagRequired, flagText, parseArgs, UsageError, wordRequired } from '../src/args';

describe('parseArgs', () => {
  it('splits words and flags, with --name value and --name=value', () => {
    const a = parseArgs(['workflow', 'get', 'abc', '--format', 'json', '--limit=5']);
    expect(a.positionals).toEqual(['workflow', 'get', 'abc']);
    expect(a.flags).toEqual({ format: 'json', limit: '5' });
  });

  it('a switch never takes the next word', () => {
    const a = parseArgs(['workflow', 'list', '--all', 'extra', '--quiet', '--no-header']);
    expect(a.positionals).toEqual(['workflow', 'list', 'extra']);
    expect(flagOn(a, 'all')).toBe(true);
    expect(flagOn(a, 'quiet')).toBe(true);
    expect(flagOn(a, 'no-header')).toBe(true);
  });

  it('--active=false is false, not on', () => {
    const a = parseArgs(['--active=false']);
    expect(a.flags.active).toBe(false);
    expect(flagOn(a, 'active')).toBe(false);
    expect(() => parseArgs(['--active=maybe'])).toThrow(UsageError);
  });

  it('knows the short flags and refuses others', () => {
    const a = parseArgs(['-q', '-h']);
    expect(a.flags).toEqual({ quiet: true, help: true });
    expect(() => parseArgs(['-z'])).toThrow(/Unknown flag -z/);
  });

  it('a flag that needs a value and has none is a usage error', () => {
    expect(() => parseArgs(['x', '--format'])).toThrow(/--format needs a value/);
    expect(() => parseArgs(['x', '--format', '--json'])).toThrow(/--format needs a value/);
  });

  it('keeps a value that starts with one dash, and everything after --', () => {
    const a = parseArgs(['variable', 'create', '--value', '-5', '--', '--not-a-flag']);
    expect(a.flags.value).toBe('-5');
    expect(a.positionals).toEqual(['variable', 'create', '--not-a-flag']);
  });

  it('flag helpers', () => {
    const a = parseArgs(['--limit', '12', '--name', 'x', '--bad', '1.5']);
    expect(flagText(a, 'name')).toBe('x');
    expect(flagInt(a, 'limit', 1, 250)).toBe(12);
    expect(flagInt(a, 'missing', 1, 250)).toBeUndefined();
    expect(() => flagInt(a, 'bad', 1, 250)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--limit', '999']), 'limit', 1, 250)).toThrow(UsageError);
    expect(flagRequired(a, 'name')).toBe('x');
    expect(() => flagRequired(a, 'nope')).toThrow(/Missing --nope/);
    expect(() => wordRequired(a, 0, 'id')).toThrow(/Missing <id>/);
  });
});
