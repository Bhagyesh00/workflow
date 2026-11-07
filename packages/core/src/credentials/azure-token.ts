/** The client credentials token request and the token answer every grant shares. L1 fills both. */
import type { AccessToken, ClientCredentialsInput, HttpRequestOptions } from '@workflow/workflow';

export function clientCredentialsRequest(_input: ClientCredentialsInput): HttpRequestOptions {
  throw new Error('not implemented (L1)');
}

export function parseAccessToken(_body: unknown): AccessToken {
  throw new Error('not implemented (L1)');
}
