/**
 * P6-16 (L15): OAuth2 token responses encrypted as JWE (`jweEnabled` on `oAuth2Api`). Keys per workspace
 * in `oauth_jwe_keys` (RSA, made on first use, the private part encrypted with the binding tenant and
 * `jwe:<kid>`); `decryptResponse` uses jose `compactDecrypt` with `RSA-OAEP-256` and an allow list of
 * content algorithms, and refuses a plain response while the flag is on. `publicJwks` serves the public
 * part at `/.well-known/jwks/:slug.json`. The hook runs on the OAuth2 callback (services/oauth2.ts
 * `useJwe`) and on every refresh and client credentials call of a run (`oauthTokenDecrypt`).
 * Stub from C0: `decryptResponse` PASSES (the token as it came) unless `data.jweEnabled === true`, which
 * throws until L15; `publicJwks` throws until L15.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServiceDeps } from '../context';

export class OAuthJweService {
  constructor(readonly deps: ServiceDeps) {}

  async decryptResponse(_tenantId: string, token: DataObject, data: DataObject): Promise<DataObject> {
    // stub (L15): PASSES for every credential without the flag
    if (data.jweEnabled !== true) return token;
    throw new Error('not implemented (L15)');
  }

  /** the workspace's public keys as a JWK set; undefined for an unknown slug */
  async publicJwks(_slug: string): Promise<{ keys: DataObject[] } | undefined> {
    throw new Error('not implemented (L15)');
  }
}
