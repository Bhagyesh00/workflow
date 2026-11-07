/**
 * Vendor requests. Every call goes through the guarded client: `vendorRequest` with the node's credential
 * (so the credential's allowed domains apply), `downloadMedia` with the credential only on the vendor's
 * own host. Errors never carry a key or a token. L1 fills these; the signatures are final.
 */
import type { ExecuteContext, HttpRequestOptions } from '@workflow/workflow';

/**
 * One request with the credential of `credentialType` applied (`httpRequestWithAuthentication` at
 * `itemIndex`); a failure becomes a `vendorError` with secrets redacted.
 */
export async function vendorRequest<T>(
  _ctx: ExecuteContext,
  _credentialType: string,
  _itemIndex: number,
  _request: HttpRequestOptions,
): Promise<T> {
  throw new Error('not implemented (L1)');
}

/**
 * A node error for a failed vendor call: the vendor's message with secrets redacted (`redactSecrets`),
 * or a fixed text from `texts` keyed by the vendor's error code (OpenAI's `insufficient_quota`).
 */
export function vendorError(
  _ctx: ExecuteContext,
  _error: unknown,
  _itemIndex: number,
  _texts?: Record<string, string>,
): Error {
  throw new Error('not implemented (L1)');
}

/**
 * Download a generated file. The credential goes only when `new URL(url).hostname === authHost`, on a hop
 * that never follows a redirect (a 3xx is fetched again with plain `httpRequest`); any other host gets a
 * plain guarded `httpRequest` with no credential. `maxBytes` caps the body.
 */
export async function downloadMedia(
  _ctx: ExecuteContext,
  _itemIndex: number,
  _url: string,
  _options?: { credentialType?: string; authHost?: string; maxBytes?: number },
): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  throw new Error('not implemented (L1)');
}
