/** The Google service account JWT bearer grant. L1 fills the assertion and the token request. */
import type { HttpRequestOptions, JwtBearerInput } from '@workflow/workflow';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function googleJwtAssertion(_input: JwtBearerInput, _now?: Date): string {
  throw new Error('not implemented (L1)');
}

export function jwtBearerRequest(_assertion: string, _tokenUrl: string): HttpRequestOptions {
  throw new Error('not implemented (L1)');
}
