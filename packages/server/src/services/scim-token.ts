/**
 * P6-02 (L13): the workspace's SCIM token: `wfs_scim_` and 43 base64url characters, shown once, stored as a
 * SHA-256 hash with its last four characters, compared with `timingSafeEqual`, one per workspace; the
 * workspace of a request comes from the token alone. Stub from C0: throws until L13.
 */
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';

export const SCIM_TOKEN_PREFIX = 'wfs_scim_';

/** a new token for the workspace (the old one stops working); the raw token is answered once */
export async function mintScimToken(
  _deps: ServiceDeps,
  _tenantId: string,
  _actorId: string,
): Promise<{ token: string; hint: string }> {
  throw new Error('not implemented (L13)');
}

/** the workspace a raw `Authorization: Bearer` token belongs to, or undefined */
export async function tenantOfScimToken(_deps: ServiceDeps, _token: string): Promise<TenantRow | undefined> {
  throw new Error('not implemented (L13)');
}
