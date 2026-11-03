/**
 * Requests made with a credential that allows only some domains (`HttpRequestOptions.allowedDomains`):
 * the first URL and every redirect hop must be inside the list, so a redirect cannot carry the
 * credential to another host.
 *
 * Redirects are followed here, one `send` per hop with `redirect: 'manual'`, instead of by fetch:
 * - at most 20 hops (or `options.maxRedirects`); one more redirect is an error;
 * - each hop's URL is checked against the list BEFORE it is requested (the SSRF-guarded dispatcher
 *   behind `send` still checks every connection);
 * - 301/302 turn a POST into a GET and 303 turns anything but HEAD into a GET, dropping the body and
 *   its headers; 307/308 keep the method and the body;
 * - `Authorization`, `Cookie` and `Proxy-Authorization` are dropped when a hop changes the origin.
 *   The credential's other headers stay: the list says those hosts may receive the credential.
 * A request that asks not to follow redirects (`redirect: 'manual'`) gets the 3xx back as it is.
 */
import { assertCredentialUrlAllowed } from '@workflow/workflow';
import type { RequestInit, Response } from 'undici';

/** one fetch on the SSRF-guarded dispatcher, as HttpClient sends it */
export type SendRequest = (url: URL, init: RequestInit) => Promise<Response>;

const DEFAULT_MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** headers that describe a request body, dropped when a redirect turns the request into a bodyless GET */
const BODY_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
]);
/** headers that carry the user's identity to the host that was asked */
const ORIGIN_BOUND_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

/** fetch `url` with `init`, refusing any URL outside `allowedDomains` before it is requested */
export async function fetchWithCredentialDomains(
  url: URL,
  init: RequestInit,
  allowedDomains: string[],
  send: SendRequest,
  options: { maxRedirects?: number } = {},
): Promise<Response> {
  assertCredentialUrlAllowed(url.toString(), allowedDomains);
  if (init.redirect === 'manual') return send(url, init);

  const maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  let current = url;
  let method = init.method ?? 'GET';
  let body = init.body;
  let headers = (init.headers ?? []) as Array<[string, string]>;
  for (let hop = 0; ; hop++) {
    const response = await send(current, { ...init, method, body, headers, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    // the redirect is not followed any further: release its connection
    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) throw new Error(`Maximum number of redirects exceeded (${maxRedirects})`);

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      // the Location value is not echoed: it can carry a secret
      throw new Error('The server redirected to a location that is not a valid URL');
    }
    assertCredentialUrlAllowed(next.toString(), allowedDomains);

    const toGet =
      response.status === 303
        ? method !== 'GET' && method !== 'HEAD'
        : (response.status === 301 || response.status === 302) && method === 'POST';
    if (toGet) {
      method = 'GET';
      body = undefined;
      headers = headers.filter(([name]) => !BODY_HEADERS.has(name.toLowerCase()));
    }
    if (next.origin !== current.origin) {
      headers = headers.filter(([name]) => !ORIGIN_BOUND_HEADERS.has(name.toLowerCase()));
    }
    current = next;
  }
}
