/**
 * The Assistant's web search (P5-73, lane L10): the provider call behind the `web_search` tool.
 *
 * The provider is the workspace's own search credential (`settings.searchCredentialId`; no instance key):
 * Brave Search at its one fixed host, or a SearXNG instance at the credential's `apiUrl` with
 * `format=json`. Both go through the guarded `ctx.http` with `allowedDomains` of exactly that host, over
 * https (or http on a loopback host name, which only a test server reaches: the SSRF guard refuses it in
 * production). The credential is read under the tenant; its key goes into the Brave request header and
 * nowhere else, and no error text carries a URL, a header or a body of the request. Results are outside
 * text: the tool wraps them as untrusted.
 *
 * The cache holds the provider's answer for 15 minutes, 100 entries, keyed by tenant, credential and query;
 * `maxResults` and `includeDomains` are applied after it.
 */
import type { HttpFullResponse } from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { CredentialRow } from '../../db/schema';

export const BRAVE_SEARCH_HOST = 'api.search.brave.com';
export const BRAVE_SEARCH_URL = `https://${BRAVE_SEARCH_HOST}/res/v1/web/search`;

export const WEB_SEARCH_LIMITS = {
  defaultResults: 5,
  maxResults: 20,
  cacheMs: 15 * 60_000,
  cacheEntries: 100,
  timeoutMs: 15_000,
  maxBytes: 1_048_576,
  titleChars: 300,
  snippetChars: 600,
} as const;

export const WEB_SEARCH_NO_PROVIDER =
  'No web search provider is set up for this workspace, so nothing was searched. An admin can choose a Brave Search or SearXNG credential in the Assistant settings.';

/** `includeDomains` was given, but no entry is a host name: nothing was searched */
export const WEB_SEARCH_NO_VALID_DOMAIN =
  'None of the domains is a valid host name, so nothing was searched.';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** a refusal or failure whose text is safe for the model and the person */
export class WebSearchError extends Error {}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  results: WebSearchResult[];
  /** set when nothing was searched or the list is empty for a reason the model should know */
  note?: string;
}

/**
 * The URL of a search endpoint when it may be called: https, or http on a loopback host name; no user name
 * or password. With `expectedHost` the host must be that name exactly (`===`), so
 * `api.search.brave.com.evil.test` is not Brave.
 */
export function checkSearchUrl(raw: string, expectedHost?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebSearchError('The search provider address is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new WebSearchError('A search provider address with a user name or password is refused.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new WebSearchError('The search provider must be reached over https.');
  }
  if (expectedHost !== undefined && url.hostname !== expectedHost) {
    throw new WebSearchError('The search provider address is not the expected host.');
  }
  return url;
}

/** `hostname` is `domain` or a subdomain of it (a `.` boundary, never a bare suffix) */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const wanted = domain.toLowerCase();
  return host === wanted || host.endsWith(`.${wanted}`);
}

/** a domain filter entry as a host name: a bare name or a URL, lower case; empty when it is neither */
export function normalizeDomain(raw: string): string {
  const text = raw.trim().toLowerCase();
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `https://${text}`).hostname;
  } catch {
    return '';
  }
}

function plain(text: unknown, max: number): string {
  const value = typeof text === 'string' ? text : '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function asList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function toResult(item: Record<string, unknown>, snippet: unknown): WebSearchResult | null {
  const raw = typeof item.url === 'string' ? item.url : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return {
    title: plain(item.title, WEB_SEARCH_LIMITS.titleChars),
    url: url.toString(),
    snippet: plain(snippet, WEB_SEARCH_LIMITS.snippetChars),
  };
}

function parseBrave(body: unknown): WebSearchResult[] {
  const web = (body as { web?: { results?: unknown } } | null)?.web;
  return asList(web?.results)
    .map((item) => toResult(item, item.description))
    .filter((item): item is WebSearchResult => item !== null);
}

function parseSearXng(body: unknown): WebSearchResult[] {
  return asList((body as { results?: unknown } | null)?.results)
    .map((item) => toResult(item, item.content))
    .filter((item): item is WebSearchResult => item !== null);
}

async function readCappedJson(body: unknown, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new WebSearchError('The search provider answered with too much data.');
      chunks.push(Buffer.from(chunk));
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new WebSearchError('The search provider did not answer with JSON.');
  }
}

/** closes a body that is not read (leaving the loop early closes the connection) */
async function closeBody(body: unknown): Promise<void> {
  if (!body || typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') return;
  try {
    for await (const _chunk of body as AsyncIterable<Uint8Array>) break;
  } catch {
    // nothing to read
  }
}

/** one guarded GET; the answer's body as JSON. Nothing of the request is put in an error. */
async function getJson(
  ctx: ServerContext,
  url: URL,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: HttpFullResponse<AsyncIterable<Uint8Array>>;
  try {
    response = (await ctx.http.request<AsyncIterable<Uint8Array>>(
      {
        url: url.toString(),
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        responseType: 'stream',
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: WEB_SEARCH_LIMITS.timeoutMs,
        followRedirects: false,
        allowedDomains: [url.hostname],
      },
      signal,
    )) as HttpFullResponse<AsyncIterable<Uint8Array>>;
  } catch {
    throw new WebSearchError('The search provider could not be reached.');
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    await closeBody(response.body);
    throw new WebSearchError(`The search provider answered with status ${response.statusCode}.`);
  }
  return readCappedJson(response.body, WEB_SEARCH_LIMITS.maxBytes);
}

// ---------------------------------------------------------------------------------------------------------
// cache

interface CacheEntry {
  at: number;
  results: WebSearchResult[];
}

/** the cache of one process: 15 minutes, 100 entries (the oldest goes first), tenant in every key */
export class SearchCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = WEB_SEARCH_LIMITS.cacheMs,
    private readonly max: number = WEB_SEARCH_LIMITS.cacheEntries,
  ) {}

  static key(tenantId: string, credentialId: string, query: string): string {
    return JSON.stringify([tenantId, credentialId, query.trim().toLowerCase()]);
  }

  get(key: string): WebSearchResult[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.results;
  }

  set(key: string, results: WebSearchResult[]): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), results });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const searchCache = new SearchCache();

// ---------------------------------------------------------------------------------------------------------
// providers

async function runProvider(
  ctx: ServerContext,
  row: CredentialRow,
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  let data: Record<string, unknown>;
  try {
    data = (await ctx.credentials.readResolved(row)) as Record<string, unknown>;
  } catch {
    throw new WebSearchError('The search credential could not be read.');
  }
  if (row.type === 'braveSearchApi') {
    const apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
    if (!apiKey) throw new WebSearchError('The search credential has no key.');
    const url = checkSearchUrl(BRAVE_SEARCH_URL, BRAVE_SEARCH_HOST);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(WEB_SEARCH_LIMITS.maxResults));
    return parseBrave(await getJson(ctx, url, { 'x-subscription-token': apiKey }, signal));
  }
  // SearXNG
  const apiUrl = typeof data.apiUrl === 'string' ? data.apiUrl.trim().replace(/\/+$/, '') : '';
  if (!apiUrl) throw new WebSearchError('The SearXNG credential has no API URL.');
  const url = checkSearchUrl(`${apiUrl}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  return parseSearXng(await getJson(ctx, url, {}, signal));
}

export interface WebSearchRequest {
  tenantId: string;
  query: string;
  maxResults?: number;
  includeDomains?: string[];
  searchCredentialId: string | null;
  searchDisabled: boolean;
  signal?: AbortSignal;
}

/** the provider's results for `query` (cached), cut to `maxResults` and filtered to `includeDomains` */
export async function webSearch(
  ctx: ServerContext,
  request: WebSearchRequest,
  cache: SearchCache = searchCache,
): Promise<WebSearchOutcome> {
  if (request.searchDisabled || !request.searchCredentialId) {
    return { results: [], note: WEB_SEARCH_NO_PROVIDER };
  }
  const row = await ctx.repos.credentials.get(request.tenantId, request.searchCredentialId);
  if (!row || (row.type !== 'braveSearchApi' && row.type !== 'searXngApi')) {
    return { results: [], note: WEB_SEARCH_NO_PROVIDER };
  }
  const wanted = (request.includeDomains ?? []).map(normalizeDomain).filter(Boolean);
  // a filter of only bad entries matches nothing; it never turns into no filter
  if ((request.includeDomains?.length ?? 0) > 0 && wanted.length === 0) {
    return { results: [], note: WEB_SEARCH_NO_VALID_DOMAIN };
  }
  const key = SearchCache.key(request.tenantId, row.id, request.query);
  let all = cache.get(key);
  if (!all) {
    all = await runProvider(ctx, row, request.query, request.signal);
    cache.set(key, all);
  }
  const filtered = wanted.length
    ? all.filter((result) => {
        try {
          const host = new URL(result.url).hostname;
          return wanted.some((domain) => hostMatchesDomain(host, domain));
        } catch {
          return false;
        }
      })
    : all;
  const limit = Math.min(
    Math.max(1, request.maxResults ?? WEB_SEARCH_LIMITS.defaultResults),
    WEB_SEARCH_LIMITS.maxResults,
  );
  const results = filtered.slice(0, limit);
  return results.length ? { results } : { results, note: 'The search found no results.' };
}
