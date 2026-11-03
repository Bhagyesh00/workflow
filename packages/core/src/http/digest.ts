/**
 * HTTP Digest authentication (RFC 2617): builds the Authorization header that answers a
 * `WWW-Authenticate: Digest ...` challenge.
 *
 * STUB from the Phase 2 contract step (C0b): no answer is built, so HttpClient.request returns the
 * 401 unchanged. Lane L6 parses the challenge (several challenges, quoted values) and writes MD5,
 * MD5-sess and qop=auth, as n8n does.
 */

export interface DigestRequest {
  method: string;
  /** path and query of the request, as sent on the request line */
  uri: string;
  username: string;
  password: string;
}

/** the Authorization header value for `challenge`, or undefined when it cannot be answered */
export function digestAuthorization(_challenge: string, _request: DigestRequest): string | undefined {
  return undefined;
}
