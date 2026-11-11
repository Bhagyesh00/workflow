/** Phase 6 S4 contract step, C0a: the cli package skeleton, the CliIo contract and the real node io. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { CliIo } from '../src/index';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: vi.fn(actual.chmod),
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
    writeFile: vi.fn(actual.writeFile),
  };
});

const fsp = await import('node:fs/promises');
const { run } = await import('../src/index');
const { nodeIo } = await import('../src/io');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'p6s4-cli-'));

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(fsp.writeFile).mockClear();
  vi.mocked(fsp.mkdir).mockClear();
  vi.mocked(fsp.chmod).mockClear();
  vi.mocked(fsp.rename).mockClear();
});

describe('cli skeleton', () => {
  it('exports run as a function with the final signature', () => {
    expect(typeof run).toBe('function');
    expectTypeOf(run).toEqualTypeOf<(argv: string[], io: CliIo) => Promise<number>>();
  });

  it('CliIo has the final shape', () => {
    expectTypeOf<keyof CliIo>().toEqualTypeOf<
      | 'stdout'
      | 'stderr'
      | 'env'
      | 'home'
      | 'fetch'
      | 'stdin'
      | 'isTTY'
      | 'readFile'
      | 'writeFile'
      | 'removeFile'
    >();
    expectTypeOf<CliIo['writeFile']>().toEqualTypeOf<
      (path: string, data: string, options: { mode?: number }) => Promise<void>
    >();
    expectTypeOf<CliIo['readFile']>().toEqualTypeOf<(path: string) => Promise<string | undefined>>();
    expectTypeOf<CliIo['fetch']>().toEqualTypeOf<typeof fetch>();
  });

  it('package.json is @workflow/cli with the workflow bin and names no workspace package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@workflow/cli');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.bin).toEqual({ workflow: './bin/workflow.mjs' });
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    for (const [name, spec] of Object.entries(deps)) {
      expect(name.startsWith('@workflow/')).toBe(false);
      expect(String(spec).startsWith('workspace:')).toBe(false);
    }
    expect(pkg.dependencies).toEqual({ tsx: '4.23.15' });
  });

  it('no source file imports another workspace package', () => {
    const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(ROOT, 'src', f));
    files.push(join(ROOT, 'bin', 'workflow.mjs'));
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from\s+['"]@workflow\/|import\(\s*['"]@workflow\//);
    }
  });

  it('bin/workflow.mjs registers tsx and runs src/index.ts with nodeIo', () => {
    const bin = readFileSync(join(ROOT, 'bin', 'workflow.mjs'), 'utf8');
    expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bin).toMatch(/from 'tsx\/esm\/api'/);
    expect(bin).toMatch(/register\(\)/);
    expect(bin).toMatch(/'\.\.\/src\/index\.ts'/);
    expect(bin).toMatch(/nodeIo\(\)/);
  });
});

describe('nodeIo', () => {
  it('answers the process values', () => {
    const io = nodeIo();
    expect(io.env).toBe(process.env);
    expect(io.home).toBe(homedir());
    expect(typeof io.fetch).toBe('function');
    expect(typeof io.stdin).toBe('function');
    expect(typeof io.isTTY).toBe('boolean');
  });

  it('readFile answers undefined for a missing file', async () => {
    expect(await nodeIo().readFile(join(tmp, 'missing.json'))).toBeUndefined();
  });

  it('readFile rethrows other errors', async () => {
    await expect(nodeIo().readFile(tmp)).rejects.toThrow();
  });

  it('writeFile makes the folder, writes the text and reads back', async () => {
    const io = nodeIo();
    const path = join(tmp, 'a', 'b', 'plain.txt');
    await io.writeFile(path, 'hello', {});
    expect(await io.readFile(path)).toBe('hello');
    expect(fsp.mkdir).toHaveBeenCalledWith(join(tmp, 'a', 'b'), { recursive: true });
    expect(fsp.writeFile).toHaveBeenCalledWith(path, 'hello', { encoding: 'utf8' });
    expect(fsp.chmod).not.toHaveBeenCalled();
  });

  it('writeFile with a mode writes a new temp file with it (the call, not stat: win32 reports 0o666) and renames it over the target', async () => {
    const io = nodeIo();
    const folder = join(tmp, '.workflow');
    const path = join(folder, 'config.json');
    await io.writeFile(path, '{"url":"x"}', { mode: 0o600 });
    expect(fsp.mkdir).toHaveBeenCalledWith(folder, { recursive: true, mode: 0o700 });
    const [temp, text, options] = vi.mocked(fsp.writeFile).mock.calls[0] as [string, string, object];
    expect(temp).not.toBe(path);
    expect(temp.startsWith(join(folder, '.config.json.'))).toBe(true);
    expect(text).toBe('{"url":"x"}');
    expect(options).toEqual({ encoding: 'utf8', mode: 0o600, flag: 'wx' });
    expect(fsp.chmod).toHaveBeenCalledWith(temp, 0o600);
    expect(fsp.rename).toHaveBeenCalledWith(temp, path);
    await io.writeFile(path, '{"url":"y"}', { mode: 0o600 });
    expect(await io.readFile(path)).toBe('{"url":"y"}');
    expect(readdirSync(folder)).toEqual(['config.json']);
  });

  it('writeFile with a mode removes the temp file and keeps the target when the write fails', async () => {
    const io = nodeIo();
    const folder = join(tmp, 'failing');
    const path = join(folder, 'config.json');
    await io.writeFile(path, 'old', { mode: 0o600 });
    vi.mocked(fsp.rename).mockRejectedValueOnce(new Error('disk full'));
    await expect(io.writeFile(path, 'new', { mode: 0o600 })).rejects.toThrow('disk full');
    expect(await io.readFile(path)).toBe('old');
    expect(readdirSync(folder)).toEqual(['config.json']);
  });

  it('removeFile removes the file and a missing file is no error', async () => {
    const io = nodeIo();
    const path = join(tmp, 'gone.txt');
    await io.writeFile(path, 'x', {});
    await io.removeFile(path);
    expect(await io.readFile(path)).toBeUndefined();
    await expect(io.removeFile(path)).resolves.toBeUndefined();
  });
});
