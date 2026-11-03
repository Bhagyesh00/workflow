/**
 * Outbound HTTP for nodes, with SSRF protection enforced at connect time:
 * every TCP connection (including redirects and DNS re-resolution) is checked against the
 * address policy, so DNS-rebinding tricks cannot reach internal services or cloud metadata.
 */
import dns from 'node:dns';
import net from 'node:net';
import type { AllowedHost, HttpFullResponse, HttpRequestOptions, ResolvedAddress } from '@workflow/workflow';
import ipaddr from 'ipaddr.js';
import {
  Agent,
  buildConnector,
  type Dispatcher,
  FormData,
  fetch,
  type RequestInit,
  type Response as UndiciResponse,
} from 'undici';
import { fetchWithCredentialDomains } from './credential-redirects';
import { digestAuthorization } from './digest';

export class SsrfBlockedError extends Error {
  constructor(host: string, address: string) {
    super(
      `Request to ${host} (${address}) is blocked: private, loopback and link-local addresses are not allowed`,
    );
    this.name = 'SsrfBlockedError';
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly statusMessage: string,
    readonly body: unknown,
    readonly headers: Record<string, string>,
    readonly request?: { method: string; url: string },
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /** `Retry-After` in milliseconds (seconds or HTTP-date form) */
  get retryAfterMs(): number | undefined {
    const value = this.headers['retry-after'];
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
  }
}

export interface SsrfPolicy {
  /** disable only for single-tenant self-hosting */
  enabled: boolean;
  /** hostnames or CIDRs always allowed (e.g. an internal API a tenant is entitled to) */
  allow: string[];
  /** hostnames or CIDRs always denied */
  deny: string[];
}

export interface HttpClientOptions {
  ssrf?: Partial<SsrfPolicy>;
  /** maximum response size in bytes */
  maxResponseBytes?: number;
  defaultTimeoutMs?: number;
  userAgent?: string;
}

const DEFAULT_DENY_HOSTS = ['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data'];

function matchesList(host: string, address: string, list: string[]): boolean {
  for (const entry of list) {
    if (entry.includes('/')) {
      try {
        const [range, bits] = ipaddr.parseCIDR(entry);
        const addr = ipaddr.parse(address);
        if (addr.kind() === range.kind() && addr.match([range, bits] as never)) return true;
      } catch {
        /* invalid CIDR entries are ignored */
      }
    } else if (entry.toLowerCase() === host.toLowerCase() || entry === address) {
      return true;
    }
  }
  return false;
}

export function isAddressAllowed(host: string, address: string, policy: SsrfPolicy): boolean {
  if (matchesList(host, address, policy.deny) || DEFAULT_DENY_HOSTS.includes(host.toLowerCase()))
    return false;
  if (!policy.enabled) return true;
  if (matchesList(host, address, policy.allow)) return true;
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

function guardedLookup(policy: SsrfPolicy): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses as string, family: 4 }];
      for (const a of list) {
        if (!isAddressAllowed(hostname, a.address, policy)) {
          return callback(new SsrfBlockedError(hostname, a.address), '', 4);
        }
      }
      if ((options as { all?: boolean }).all) return (callback as any)(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

/**
 * A lookup that answers only from addresses already checked, so the connection never resolves the
 * name again. It hands back every address, so `autoSelectFamily` can still fall back across them.
 */
function pinnedLookup(host: string, addresses: ResolvedAddress[]): AllowedHost['lookup'] {
  return (_hostname, options, callback) => {
    const family =
      options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : Number(options.family ?? 0);
    const list = family ? addresses.filter((a) => a.family === family) : addresses;
    process.nextTick(() => {
      if (!list.length) callback(new Error(`Host "${host}" has no allowed IPv${family} address`), '', family);
      else if (options.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

function createGuardedAgent(policy: SsrfPolicy, rejectUnauthorized = true): Agent {
  const connector = buildConnector({ rejectUnauthorized, lookup: guardedLookup(policy) });
  return new Agent({
    // runs for every new connection, redirect hops included; IP literals never reach `lookup`, so check them here
    connect(options, callback) {
      const host = options.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(host) && !isAddressAllowed(host, host, policy)) {
        callback(new SsrfBlockedError(host, host), null);
        return;
      }
      connector(options, callback);
    },
  });
}

function buildUrl(url: string, qs?: Record<string, unknown>): URL {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${u.protocol}"`);
  }
  for (const [k, v] of Object.entries(qs ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const entry of v) u.searchParams.append(k, String(entry));
    else u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return u;
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`Response exceeds the maximum size of ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The body as it arrives; reading stops at the size limit, and stopping early cancels the body. */
async function* streamLimited(response: Response, limit: number): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      total += value.byteLength;
      if (total > limit) throw new Error(`Response exceeds the maximum size of ${limit} bytes`);
      yield value;
    }
  } finally {
    // releases the connection; a body that already failed rejects the cancel with that same error
    if (!finished) await reader.cancel().catch(() => undefined);
  }
}

function parseBody(
  raw: Uint8Array,
  contentType: string,
  responseType: 'json' | 'text' | 'arraybuffer' | 'auto',
): unknown {
  if (responseType === 'arraybuffer') return raw;
  const text = new TextDecoder().decode(raw);
  if (responseType === 'json' || (responseType === 'auto' && /json/i.test(contentType))) {
    try {
      return text.length ? JSON.parse(text) : {};
    } catch {
      return text;
    }
  }
  return text;
}

export class HttpClient {
  private readonly policy: SsrfPolicy;
  private readonly agent: Agent;
  private readonly insecureAgent: Agent;
  private readonly maxResponseBytes: number;
  private readonly defaultTimeoutMs: number;
  private readonly userAgent: string;

  constructor(options: HttpClientOptions = {}) {
    this.policy = { enabled: true, allow: [], deny: [], ...options.ssrf };
    this.agent = createGuardedAgent(this.policy);
    this.insecureAgent = createGuardedAgent(this.policy, false);
    this.maxResponseBytes = options.maxResponseBytes ?? 100 * 1024 * 1024;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.userAgent = options.userAgent ?? 'workflow-platform/0.1';
  }

  /** synchronous pre-check for literal IPs/hosts (connect-time check is authoritative) */
  assertUrlAllowed(url: string): void {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isAddressAllowed(host, host, this.policy)) throw new SsrfBlockedError(host, host);
    if (DEFAULT_DENY_HOSTS.includes(host.toLowerCase())) throw new SsrfBlockedError(host, host);
  }

  /** resolve and check a hostname for non-HTTP connections (databases, SMTP) */
  async assertHostAllowed(host: string): Promise<void> {
    await this.resolveAllowedHost(host);
  }

  /**
   * Resolve `host` once and check every address against the policy. Non-HTTP drivers must connect
   * through the returned `lookup`: a driver that resolves the name again could be sent elsewhere by
   * a DNS rebind between the check and the connect.
   */
  async resolveAllowedHost(host: string): Promise<AllowedHost> {
    const bare = host.trim().replace(/^\[|\]$/g, '');
    if (!bare) throw new Error('A host is required');
    // drivers such as pg treat a leading '/' as a Unix socket path on this machine
    if (this.policy.enabled && bare.startsWith('/')) throw new SsrfBlockedError(bare, 'unix socket');
    if (DEFAULT_DENY_HOSTS.includes(bare.toLowerCase())) throw new SsrfBlockedError(bare, bare);
    const resolved = net.isIP(bare)
      ? [{ address: bare, family: net.isIP(bare) }]
      : await dns.promises.lookup(bare, { all: true, verbatim: true });
    if (!resolved.length) throw new Error(`Host "${bare}" did not resolve`);
    for (const a of resolved) {
      if (!isAddressAllowed(bare, a.address, this.policy)) throw new SsrfBlockedError(bare, a.address);
    }
    const addresses = resolved.map(({ address, family }) => ({ address, family }));
    return { addresses, lookup: pinnedLookup(bare, addresses) };
  }

  async request<T = unknown>(
    options: HttpRequestOptions,
    signal?: AbortSignal,
  ): Promise<T | HttpFullResponse<T>> {
    const url = buildUrl(options.url, options.qs);
    this.assertUrlAllowed(url.toString());
    const headers: Record<string, string | string[]> = {
      'user-agent': this.userAgent,
      ...lowerKeys(options.headers ?? {}),
    };
    // the digest scheme sends no credentials until the server's challenge names its nonce
    const digest = options.auth?.scheme === 'digest';
    if (options.auth && !digest) {
      headers.authorization = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
    }

    let body: string | Uint8Array | FormData | URLSearchParams | undefined;
    const method = options.method ?? 'GET';
    if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
      const bodyType =
        options.bodyType ?? (isBinary(options.body) || typeof options.body === 'string' ? 'raw' : 'json');
      if (bodyType === 'json') {
        body = JSON.stringify(options.body);
        headers['content-type'] ??= 'application/json';
      } else if (bodyType === 'form-urlencoded') {
        body = new URLSearchParams();
        for (const [k, v] of Object.entries((options.body ?? {}) as Record<string, unknown>)) {
          for (const entry of Array.isArray(v) ? v : [v]) body.append(k, String(entry));
        }
        headers['content-type'] ??= 'application/x-www-form-urlencoded';
      } else if (bodyType === 'multipart') {
        const form = new FormData();
        for (const [k, v] of Object.entries((options.body ?? {}) as Record<string, unknown>)) {
          for (const entry of Array.isArray(v) ? v : [v]) {
            if (
              entry &&
              typeof entry === 'object' &&
              'data' in (entry as object) &&
              isBinary((entry as { data: unknown }).data)
            ) {
              const file = entry as { data: Uint8Array; fileName?: string; mimeType?: string };
              form.append(
                k,
                new Blob([Buffer.from(file.data)], { type: file.mimeType }),
                file.fileName ?? 'file',
              );
            } else {
              form.append(k, typeof entry === 'object' ? JSON.stringify(entry) : String(entry));
            }
          }
        }
        body = form;
        delete headers['content-type'];
      } else {
        body =
          typeof options.body === 'string' || isBinary(options.body)
            ? (options.body as string)
            : String(options.body);
      }
    }

    const timeout = AbortSignal.timeout(options.timeout ?? this.defaultTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const dispatcher: Dispatcher = options.skipSslCertificateValidation ? this.insecureAgent : this.agent;

    const init: RequestInit = {
      method,
      headers: Object.entries(headers).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((value) => [k, value] as [string, string]),
      ),
      body: body as RequestInit['body'],
      dispatcher,
      redirect: options.followRedirects === false ? 'manual' : 'follow',
      signal: combined,
    };
    const { allowedDomains } = options;
    const fetchOnce = (target: URL, requestInit: RequestInit) =>
      allowedDomains !== undefined
        ? fetchWithCredentialDomains(target, requestInit, allowedDomains, (u, i) => this.send(u, i))
        : this.send(target, requestInit);

    let response = await fetchOnce(url, init);
    if (digest && options.auth && response.status === 401) {
      response = await this.answerDigest(response, url, init, options.auth, fetchOnce);
    }

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    const isRedirect = response.status >= 300 && response.status < 400 && options.followRedirects === false;
    const failed =
      !options.ignoreHttpStatusErrors && (response.status < 200 || response.status >= 300) && !isRedirect;
    // a failed streamed request is read whole like any other, so the HttpError carries the parsed body
    const parsed: unknown =
      options.responseType === 'stream' && !failed
        ? streamLimited(response as unknown as Response, this.maxResponseBytes)
        : parseBody(
            await readLimited(response as unknown as Response, this.maxResponseBytes),
            responseHeaders['content-type'] ?? '',
            options.responseType === 'stream' ? 'auto' : (options.responseType ?? 'auto'),
          );

    if (failed) {
      throw new HttpError(
        `Request failed with status code ${response.status}`,
        response.status,
        response.statusText,
        parsed,
        responseHeaders,
        { method, url: `${url.origin}${url.pathname}` },
      );
    }

    if (options.returnFullResponse) {
      return {
        body: parsed as T,
        headers: responseHeaders,
        statusCode: response.status,
        statusMessage: response.statusText,
      };
    }
    return parsed as T;
  }

  /** one fetch on the guarded dispatcher; a connect-time block surfaces as the SsrfBlockedError */
  private async send(url: URL, init: RequestInit): Promise<UndiciResponse> {
    return fetch(url, init).catch((error: unknown) => {
      // a connect-time block reaches fetch as `TypeError('fetch failed')`; surface the real reason
      if (error instanceof Error && error.cause instanceof SsrfBlockedError) throw error.cause;
      throw error;
    });
  }

  /**
   * Answer a 401 Digest challenge once: the same request goes again with the Authorization header,
   * and whatever comes back is the result (never a loop). Without a Digest challenge, an answer, or
   * when a redirect ended on another origin, the 401 is returned as it is.
   */
  private async answerDigest(
    response: UndiciResponse,
    url: URL,
    init: RequestInit,
    auth: { username: string; password: string },
    fetchOnce: (target: URL, init: RequestInit) => Promise<UndiciResponse>,
  ): Promise<UndiciResponse> {
    const challenge = response.headers.get('www-authenticate');
    if (!challenge || !/(?:^|,)\s*digest\s/i.test(challenge)) return response;
    const target = response.url ? new URL(response.url) : url;
    if (target.origin !== url.origin) return response;
    const authorization = digestAuthorization(challenge, {
      method: init.method ?? 'GET',
      uri: `${target.pathname}${target.search}`,
      username: auth.username,
      password: auth.password,
    });
    if (!authorization) return response;
    await response.body?.cancel().catch(() => undefined);
    const headers = (init.headers as Array<[string, string]>).filter(([k]) => k !== 'authorization');
    return fetchOnce(target, { ...init, headers: [...headers, ['authorization', authorization]] });
  }

  async close(): Promise<void> {
    await Promise.all([this.agent.close(), this.insecureAgent.close()]);
  }
}

/**
 * lower-case the names; of names that differ only in case the later one wins, as callers override a
 * default by spreading their own headers after it. A repeated header comes as an array under one name.
 */
function lowerKeys(h: Record<string, string | string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function isBinary(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}
