/**
 * Requests made with a credential that allows only some domains (`HttpRequestOptions.allowedDomains`):
 * the first URL and every redirect hop must be inside the list, so a redirect cannot carry the
 * credential to another host.
 *
 * STUB from the Phase 2 contract step (C0b): checks the first URL, then lets `send` follow redirects
 * as the request asks. Lane L7 makes this the per-hop loop (manual redirects, at most 20 hops or
 * maxRedirects, every hop re-checked, 301/302/303 method rewrite, Authorization dropped cross-origin).
 */
import { assertCredentialUrlAllowed } from '@workflow/workflow';
import type { RequestInit, Response } from 'undici';

/** one fetch on the SSRF-guarded dispatcher, as HttpClient sends it */
export type SendRequest = (url: URL, init: RequestInit) => Promise<Response>;

/** fetch `url` with `init`, refusing any URL outside `allowedDomains` before it is requested */
export async function fetchWithCredentialDomains(
  url: URL,
  init: RequestInit,
  allowedDomains: string[],
  send: SendRequest,
): Promise<Response> {
  assertCredentialUrlAllowed(url.toString(), allowedDomains);
  return send(url, init);
}
