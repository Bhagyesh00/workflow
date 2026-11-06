/**
 * Shared pieces of the six providers (P4-08): fixed error texts, the one way a provider calls its
 * vault, and a base class that holds the secrets in memory. A response body never reaches an error:
 * a body echo would let a tenant admin read internal hosts through the test button.
 */
import { SsrfBlockedError } from '@workflow/core';
import type { HttpRequestOptions } from '@workflow/workflow';
import type {
  SecretProvider,
  SecretProviderDeps,
  SecretProviderSettings,
  SecretProviderTestResult,
} from '../types';

/** the manager shows the message of an error with this name, and nothing else */
export class SecretProviderError extends Error {
  override name = 'SecretProviderError';
}

export const TEXT_BAD_SETTINGS = 'The connection settings are not valid';
export const TEXT_BLOCKED = 'Blocked by the network rules';
export const TEXT_BAD_ANSWER = 'The vault sent an answer that could not be read';

const NETWORK_REASONS: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host not found',
  EAI_AGAIN: 'host not found',
  ETIMEDOUT: 'timed out',
  UND_ERR_CONNECT_TIMEOUT: 'timed out',
  UND_ERR_HEADERS_TIMEOUT: 'timed out',
  UND_ERR_BODY_TIMEOUT: 'timed out',
  ECONNRESET: 'connection reset',
  UND_ERR_SOCKET: 'connection reset',
  CERT_HAS_EXPIRED: 'certificate not valid',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate not valid',
  SELF_SIGNED_CERT_IN_CHAIN: 'certificate not valid',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate not valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate not valid',
};

/** a fixed text for anything a call can throw; the error's own message is never used */
export function fixedErrorText(error: unknown): string {
  if (error instanceof SecretProviderError) return error.message;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof SsrfBlockedError) return TEXT_BLOCKED;
    const e = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return "Couldn't reach the vault: timed out";
    if (typeof e.code === 'string' && NETWORK_REASONS[e.code]) {
      return `Couldn't reach the vault: ${NETWORK_REASONS[e.code]}`;
    }
    current = e.cause;
  }
  return "Couldn't reach the vault";
}

export function toProviderError(error: unknown): SecretProviderError {
  return error instanceof SecretProviderError ? error : new SecretProviderError(fixedErrorText(error));
}

export interface VaultAnswer<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

/**
 * One call to a vault through the guarded client. Redirects are not followed (the request carries a
 * token), a status outside 200-299 becomes "The vault answered <status>", and every other failure
 * becomes a fixed text. `allow` lists statuses the caller handles itself.
 */
export async function vaultCall<T = unknown>(
  deps: SecretProviderDeps,
  options: HttpRequestOptions,
  timeoutMs: number,
  allow: number[] = [],
): Promise<VaultAnswer<T>> {
  let answer: { body: T; headers: Record<string, string>; statusCode: number };
  try {
    answer = (await deps.http.request<T>({
      responseType: 'auto',
      ...options,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
      followRedirects: false,
      timeout: timeoutMs,
    })) as typeof answer;
  } catch (error) {
    throw toProviderError(error);
  }
  const ok = answer.statusCode >= 200 && answer.statusCode < 300;
  if (!ok && !allow.includes(answer.statusCode)) {
    throw new SecretProviderError(`The vault answered ${answer.statusCode}`);
  }
  return { status: answer.statusCode, body: answer.body, headers: answer.headers };
}

/** the body as an object; a text or an empty answer where JSON was expected is an error */
export function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new SecretProviderError(TEXT_BAD_ANSWER);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** runs `work` over `items`, at most `limit` at a time, results in the order of the list; the first failure stops it */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed: unknown;
  let hasFailed = false;
  const runner = async (): Promise<void> => {
    while (!hasFailed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        if (!hasFailed) {
          hasFailed = true;
          failed = error;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  if (hasFailed) throw failed;
  return results;
}

export function settingString(settings: SecretProviderSettings, key: string, fallback = ''): string {
  const value = settings[key];
  return typeof value === 'string' ? value.trim() : fallback;
}

/** a header value or path part with no control characters */
export function isPlain(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function requireSettings(...values: string[]): void {
  if (values.some((v) => !v || !isPlain(v))) throw new SecretProviderError(TEXT_BAD_SETTINGS);
}

/** an http(s) URL typed by the admin: no credentials in it, the query and fragment dropped */
export function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretProviderError(TEXT_BAD_SETTINGS);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new SecretProviderError(TEXT_BAD_SETTINGS);
  }
  url.search = '';
  url.hash = '';
  return url;
}

/** base + segments; every segment is encoded, a segment with slashes is split first */
export function joinUrl(base: URL, ...segments: string[]): string {
  const prefix = base.pathname.replace(/\/+$/, '');
  const tail = segments
    .flatMap((s) => s.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${base.origin}${prefix}/${tail}`;
}

/**
 * The part every provider shares: the secrets sit in a map that a refresh swaps whole, so a read
 * during a refresh sees the old list or the new one. A subclass reads the vault in `readAll`.
 */
export abstract class MemoryProvider implements SecretProvider {
  protected secrets = new Map<string, unknown>();

  constructor(
    protected readonly settings: SecretProviderSettings,
    protected readonly deps: SecretProviderDeps,
  ) {}

  abstract init(): Promise<void>;
  /** prove the settings work: sign in, or read one entry */
  abstract connect(): Promise<void>;
  protected abstract readAll(): Promise<Map<string, unknown>>;
  /** drop tokens held in memory */
  protected abstract forget(): void;

  async update(): Promise<void> {
    this.secrets = await this.readAll();
  }

  async test(): Promise<SecretProviderTestResult> {
    try {
      await this.init();
      await this.connect();
      return { success: true };
    } catch (error) {
      return { success: false, error: fixedErrorText(error) };
    }
  }

  getSecret(name: string): unknown {
    return this.secrets.get(name);
  }

  hasSecret(name: string): boolean {
    return this.secrets.has(name);
  }

  getSecretNames(): string[] {
    return [...this.secrets.keys()];
  }

  async disconnect(): Promise<void> {
    this.secrets = new Map();
    this.forget();
  }
}
