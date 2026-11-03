/**
 * OAuth 1.0a request signing (RFC 5849) with node:crypto.
 *
 * STUB from the Phase 2 contract step (C0a); lane L8 writes the signer and the parser.
 */
import type { HttpRequestOptions } from '@workflow/workflow';

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

/** the request with its query merged into the URL and an OAuth Authorization header */
export function signOAuth1Request(
  _request: HttpRequestOptions,
  _options: OAuth1SignOptions,
): HttpRequestOptions {
  throw new Error('OAuth1 signing is not built yet');
}

/** a form-urlencoded token response (`oauth_token=...&oauth_token_secret=...`) as an object */
export function parseOAuthResponse(_body: string): Record<string, string> {
  throw new Error('OAuth1 response parsing is not built yet');
}
