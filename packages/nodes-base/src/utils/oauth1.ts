/**
 * OAuth 1.0a request signing (RFC 5849) with node:crypto. HMAC-SHA1, -SHA256 and -SHA512 only.
 *
 * The query string (URL plus `qs`) is merged into the URL first, so the URL that is signed is the
 * URL that is sent. Signed parameters: query, form-urlencoded body fields and the oauth_* fields.
 * JSON, multipart and raw bodies are not signed (RFC 5849 section 3.4.1.3.1). Headers the caller set
 * are kept; only Authorization is replaced.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { formEntries, type HttpRequestOptions } from '@workflow/workflow';

export type OAuth1SignatureMethod = 'HMAC-SHA1' | 'HMAC-SHA256' | 'HMAC-SHA512';

export interface OAuth1SignOptions {
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  signatureMethod?: OAuth1SignatureMethod;
  /** request-token step: sent as `oauth_callback` in the Authorization header */
  callback?: string;
  /** access-token step */
  verifier?: string;
  /** fixed values for tests */
  nonce?: string;
  timestamp?: number;
}

const HASH: Record<OAuth1SignatureMethod, string> = {
  'HMAC-SHA1': 'sha1',
  'HMAC-SHA256': 'sha256',
  'HMAC-SHA512': 'sha512',
};

/** RFC 3986 percent-encoding (RFC 5849 section 3.6) */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function mergeQuery(url: string, qs?: Record<string, unknown>): URL {
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

/** the body pairs the HTTP client will send (none for GET and HEAD, which send no body) */
function formFields(request: HttpRequestOptions): Array<[string, string]> {
  if (request.bodyType !== 'form-urlencoded') return [];
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return [];
  return formEntries(request.body);
}

/** the signature base string (RFC 5849 section 3.4.1) */
export function oauth1BaseString(input: {
  method: string;
  url: string;
  bodyFields: Array<[string, string]>;
  oauth: Record<string, string>;
}): string {
  const u = new URL(input.url);
  const params: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) params.push([k, v]);
  params.push(...input.bodyFields);
  for (const [k, v] of Object.entries(input.oauth)) if (k !== 'oauth_signature') params.push([k, v]);
  const normalized = params
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // URL already lower-cases scheme and host and drops a default port; the query is not part of it
  const baseUri = `${u.protocol}//${u.host}${u.pathname || '/'}`;
  return `${input.method.toUpperCase()}&${percentEncode(baseUri)}&${percentEncode(normalized)}`;
}

/** the request with its query merged into the URL and an OAuth Authorization header */
export function signOAuth1Request(
  request: HttpRequestOptions,
  options: OAuth1SignOptions,
): HttpRequestOptions {
  const method: OAuth1SignatureMethod = options.signatureMethod ?? 'HMAC-SHA1';
  if (!HASH[method]) throw new Error(`Unsupported OAuth1 signature method "${String(method)}"`);
  const url = mergeQuery(request.url, request.qs).toString();
  const oauth: Record<string, string> = {
    oauth_consumer_key: options.consumerKey,
    oauth_nonce: options.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: method,
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
  };
  if (options.token) oauth.oauth_token = options.token;
  if (options.callback) oauth.oauth_callback = options.callback;
  if (options.verifier) oauth.oauth_verifier = options.verifier;
  const base = oauth1BaseString({
    method: request.method ?? 'GET',
    url,
    bodyFields: formFields(request),
    oauth,
  });
  const key = `${percentEncode(options.consumerSecret)}&${percentEncode(options.tokenSecret ?? '')}`;
  oauth.oauth_signature = createHmac(HASH[method], key).update(base).digest('base64');
  const header = `OAuth ${Object.keys(oauth)
    .sort()
    .map((k) => `${k}="${percentEncode(oauth[k])}"`)
    .join(', ')}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers ?? {})) {
    if (k.toLowerCase() !== 'authorization') headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers.Authorization = header;
  const { qs: _qs, ...rest } = request;
  return { ...rest, url, headers };
}

/** a form-urlencoded token response (`oauth_token=...&oauth_token_secret=...`) as an object */
export function parseOAuthResponse(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(body).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
