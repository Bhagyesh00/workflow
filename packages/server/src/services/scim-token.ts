/**
 * P6-02 (L13): the workspace's SCIM token: `wfs_scim_` and 43 base64url characters, shown once, stored as a
 * SHA-256 hash with its last four characters, compared with `timingSafeEqual`, one per workspace; the
 * workspace of a request comes from the token alone.
 */
import { timingSafeEqual } from 'node:crypto';
import type { ServiceDeps } from '../context';
import type { TenantRow } from '../db/schema';
import { createRepositories } from '../repositories';
import { randomToken, sha256 } from './auth';

export const SCIM_TOKEN_PREFIX = 'wfs_scim_';

/** 32 random bytes are 43 base64url characters */
const TOKEN_BYTES = 32;

/** a new token for the workspace (the old one stops working); the raw token is answered once */
export async function mintScimToken(
  deps: ServiceDeps,
  tenantId: string,
  actorId: string,
): Promise<{ token: string; hint: string }> {
  const token = `${SCIM_TOKEN_PREFIX}${randomToken(TOKEN_BYTES)}`;
  const hint = token.slice(-4);
  await deps.database.db.transaction(async (tx) => {
    const repos = createRepositories(tx);
    await repos.scim.save(tenantId, { tokenHash: sha256(token), tokenHint: hint, createdBy: actorId });
    await repos.audit.add(tenantId, {
      userId: actorId,
      action: 'scim.token_created',
      resourceType: 'tenant',
      resourceId: tenantId,
    });
  });
  return { token, hint };
}

/** the workspace a raw `Authorization: Bearer` token belongs to, or undefined */
export async function tenantOfScimToken(deps: ServiceDeps, token: string): Promise<TenantRow | undefined> {
  if (!token.startsWith(SCIM_TOKEN_PREFIX) || token.length > 256) return undefined;
  const hash = sha256(token);
  const row = await deps.repos.scim.getByHash(hash);
  if (!row) return undefined;
  const a = Buffer.from(hash);
  const b = Buffer.from(row.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return deps.repos.tenants.get(row.tenantId);
}
