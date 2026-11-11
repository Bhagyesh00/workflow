import { describe, expect, it, vi } from 'vitest';
import { parseArgs, UsageError } from '../src/args';
import {
  clearConfig,
  configPath,
  maskKey,
  normalizeUrl,
  readConfig,
  resolveConfig,
  writeConfig,
} from '../src/config';
import type { CliIo } from '../src/index';

function ioWith(files: Record<string, string>, env: Record<string, string> = {}) {
  const store = new Map(Object.entries(files));
  const writeFile = vi.fn(async (path: string, data: string, _options: { mode?: number }) => {
    store.set(path, data);
  });
  const removeFile = vi.fn(async (path: string) => {
    store.delete(path);
  });
  const io: CliIo = {
    stdout: () => {},
    stderr: () => {},
    env,
    home: '/home/me',
    fetch: globalThis.fetch,
    stdin: async () => '',
    isTTY: false,
    readFile: async (path) => store.get(path),
    writeFile,
    removeFile,
  };
  return { io, store, writeFile, removeFile };
}

const FILE = '/home/me/.workflow/config.json';

describe('config order: flags, env, file', () => {
  it('a flag beats the environment, the environment beats the file', async () => {
    const file = JSON.stringify({ url: 'https://file.example.com', apiKey: 'file-key' });
    const { io } = ioWith(
      { [FILE]: file },
      { WORKFLOW_URL: 'https://env.example.com', WORKFLOW_API_KEY: 'env-key' },
    );
    const all = await resolveConfig(
      parseArgs(['--url', 'https://flag.example.com', '--api-key', 'flag-key']),
      io,
    );
    expect(all).toMatchObject({
      url: 'https://flag.example.com',
      apiKey: 'flag-key',
      source: { url: 'flag', apiKey: 'flag' },
    });
    const env = await resolveConfig(parseArgs([]), io);
    expect(env).toMatchObject({
      url: 'https://env.example.com',
      apiKey: 'env-key',
      source: { url: 'env', apiKey: 'env' },
    });
    const only = await resolveConfig(parseArgs([]), ioWith({ [FILE]: file }).io);
    expect(only).toMatchObject({
      url: 'https://file.example.com',
      apiKey: 'file-key',
      source: { url: 'file', apiKey: 'file' },
    });
    const mixed = await resolveConfig(
      parseArgs(['--api-key', 'flag-key']),
      ioWith({ [FILE]: file }, { WORKFLOW_URL: 'https://env.example.com' }).io,
    );
    expect(mixed).toMatchObject({ url: 'https://env.example.com', apiKey: 'flag-key' });
  });

  it('uses the WORKFLOW_ names, not the bare ones', async () => {
    const { io } = ioWith({}, { URL: 'https://bare.example.com', API_KEY: 'bare', N8N_API_KEY: 'n8n' });
    expect(await resolveConfig(parseArgs([]), io)).toMatchObject({ url: undefined, apiKey: undefined });
  });

  it('nothing set gives an empty answer', async () => {
    const config = await resolveConfig(parseArgs([]), ioWith({}).io);
    expect(config).toMatchObject({
      url: undefined,
      apiKey: undefined,
      source: { url: 'none', apiKey: 'none' },
    });
  });
});

describe('the config file', () => {
  it('is at ~/.workflow/config.json and written with mode 0600', async () => {
    const { io, writeFile, store } = ioWith({});
    expect(configPath(io)).toBe(FILE);
    await writeConfig(io, { url: 'https://a.example.com', apiKey: 'k-123' });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(FILE, expect.any(String), { mode: 0o600 });
    expect(JSON.parse(store.get(FILE) ?? '{}')).toEqual({ url: 'https://a.example.com', apiKey: 'k-123' });
  });

  it('a broken or odd file reads as empty, and logout removes it', async () => {
    for (const text of ['{nope', '[]', '"x"', '', '{"url":5,"apiKey":null}']) {
      expect(await readConfig(ioWith({ [FILE]: text }).io)).toEqual({});
    }
    const { io, store, removeFile } = ioWith({ [FILE]: '{"url":"https://a.example.com"}' });
    await clearConfig(io);
    expect(removeFile).toHaveBeenCalledWith(FILE);
    expect(store.has(FILE)).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('keeps the origin and drops a trailing slash and /api/v1', () => {
    expect(normalizeUrl('https://x.example.com/', false)).toBe('https://x.example.com');
    expect(normalizeUrl('https://x.example.com/api/v1/', false)).toBe('https://x.example.com');
    expect(normalizeUrl('https://x.example.com/base/api/v1', false)).toBe('https://x.example.com/base');
    expect(normalizeUrl('http://localhost:5678', false)).toBe('http://localhost:5678');
    expect(normalizeUrl('http://127.0.0.1:5678/?x=1#y', false)).toBe('http://127.0.0.1:5678');
  });

  it('refuses other schemes, user info, and plain http to another host unless allowed', () => {
    expect(() => normalizeUrl('ftp://x.example.com', false)).toThrow(UsageError);
    expect(() => normalizeUrl('not a url', false)).toThrow(UsageError);
    expect(() => normalizeUrl('https://u:p@x.example.com', false)).toThrow(/user name/);
    expect(() => normalizeUrl('http://x.example.com', false)).toThrow(/plain http/);
    expect(normalizeUrl('http://x.example.com', true)).toBe('http://x.example.com');
  });
});

describe('maskKey', () => {
  it('shows the length and no character of the key', () => {
    const masked = maskKey('abcd1234efgh5678');
    expect(masked).toContain('16 characters');
    expect(masked).not.toMatch(/abcd|5678/);
    expect(maskKey(undefined)).toBe('(not set)');
  });
});
