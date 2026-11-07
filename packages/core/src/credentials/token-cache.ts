/** Short-lived access tokens, kept per secret and scope. L1 fills the cache. */
import type { AccessToken } from '@workflow/workflow';

export class TokenCache {
  get(_secret: string, _scope: string, _fetch: () => Promise<AccessToken>): Promise<string> {
    throw new Error('not implemented (L1)');
  }
}

/** the one cache `createCredentialHelpers` uses */
export const sharedTokenCache = new TokenCache();
