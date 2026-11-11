/**
 * Where the CLI finds the server URL and the API key (P6-77). Order: flags (`--url`, `--api-key`), then the
 * environment (`WORKFLOW_URL`, `WORKFLOW_API_KEY`), then `~/.workflow/config.json`. n8n's prefix is replaced by
 * `WORKFLOW_` on purpose: the bare names would clash with common shell variables. The file is written with mode
 * 0600 (owner only); on Windows the mode does nothing and the file takes the folder's rights.
 */
import { type Args, flagText, UsageError } from './args';
import type { CliIo } from './index';

export const ENV_URL = 'WORKFLOW_URL';
export const ENV_API_KEY = 'WORKFLOW_API_KEY';

export interface StoredConfig {
  url?: string;
  apiKey?: string;
}

export interface ResolvedConfig {
  url?: string;
  apiKey?: string;
  allowHttp: boolean;
  /** where each value came from, for `config show` */
  source: { url: 'flag' | 'env' | 'file' | 'none'; apiKey: 'flag' | 'env' | 'file' | 'none' };
}

export function configPath(io: CliIo): string {
  return `${io.home.replace(/[\\/]+$/, '')}/.workflow/config.json`;
}

/** the stored file; a missing, empty or broken file is an empty config (the next save replaces it) */
export async function readConfig(io: CliIo): Promise<StoredConfig> {
  const text = await io.readFile(configPath(io));
  if (!text?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const { url, apiKey } = parsed as Record<string, unknown>;
    return {
      ...(typeof url === 'string' && url ? { url } : {}),
      ...(typeof apiKey === 'string' && apiKey ? { apiKey } : {}),
    };
  } catch {
    return {};
  }
}

/** writes the file with mode 0600 */
export async function writeConfig(io: CliIo, config: StoredConfig): Promise<void> {
  const body: StoredConfig = {
    ...(config.url ? { url: config.url } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  };
  await io.writeFile(configPath(io), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

export async function clearConfig(io: CliIo): Promise<void> {
  await io.removeFile(configPath(io));
}

/**
 * The server address as the API base: http or https only, no user info, no query or fragment, no trailing
 * slash, and a trailing `/api/v1` is dropped (the CLI adds it). Plain `http://` is for the machine itself
 * (localhost, 127.0.0.1, [::1]); any other host needs `--allow-http`, because the key travels in a header.
 */
export function normalizeUrl(raw: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UsageError('The server URL is not a valid URL (for example https://workflow.example.com)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError('The server URL must start with https:// or http://');
  }
  if (url.username || url.password)
    throw new UsageError('The server URL must not hold a user name or password');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback && !allowHttp) {
    throw new UsageError(
      'The API key would travel over plain http. Use https://, or pass --allow-http for a trusted network',
    );
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${url.origin}${path}`;
}

/** flags, then env, then the file */
export async function resolveConfig(args: Args, io: CliIo): Promise<ResolvedConfig> {
  const file = await readConfig(io);
  const pick = (flag: string | undefined, env: string | undefined, stored: string | undefined) => {
    if (flag) return { value: flag, source: 'flag' as const };
    if (env) return { value: env, source: 'env' as const };
    if (stored) return { value: stored, source: 'file' as const };
    return { value: undefined, source: 'none' as const };
  };
  const url = pick(flagText(args, 'url'), io.env[ENV_URL], file.url);
  const key = pick(flagText(args, 'api-key'), io.env[ENV_API_KEY], file.apiKey);
  return {
    url: url.value,
    apiKey: key.value,
    allowHttp: args.flags['allow-http'] === true || io.env.WORKFLOW_ALLOW_HTTP === '1',
    source: { url: url.source, apiKey: key.source },
  };
}

/** shows that a key is set without showing any of it: only its length */
export function maskKey(key: string | undefined): string {
  if (!key) return '(not set)';
  return `******** (${key.length} characters)`;
}
