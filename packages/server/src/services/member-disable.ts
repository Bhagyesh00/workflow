/**
 * Member state changes that S2's lanes share (C0, FULL): disable and enable a membership (P6-02 SCIM,
 * P6-12 LDAP sync), change a member's workspace role (REST PATCH /members/:userId, the public
 * PATCH /users/:id/role, provisioning at sign-in) and the grant check of the invite and role paths.
 *
 * A disabled membership stays (work, projects and API keys are kept) but `memberships.get` no longer finds
 * it, so its sessions, API keys, MCP keys and push stream are refused at their next request; its sessions and
 * MCP OAuth grants in that workspace are deleted at once. Other workspaces of the person are untouched.
 */
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';

export const LAST_OWNER_MESSAGE = 'A workspace needs at least one owner';
/** an owner is never disabled (`disableMember` refuses one), so a disabled member is not made an owner either */
export const DISABLED_OWNER_MESSAGE =
  "Couldn't change the role: enable the member before making them an owner";

/**
 * A caller gives a workspace role only when it holds every scope of that role itself (an owner holds them
 * all). So a custom role with `user:changeRole` or `user:create` cannot hand out admin or a wider custom role.
 * `member` is the floor every workspace user starts from, so it can always be given.
 */
export async function assertGrantable(
  ctx: ServerContext,
  auth: AuthContext,
  role: string,
  action: string,
): Promise<void> {
  if (auth.role === 'owner' || role === 'member') return;
  const mine = await ctx.access.scopesForAuth(auth);
  const given = await ctx.access.globalScopes(auth.tenant.id, role);
  if ([...given].some((scope) => !mine.has(scope))) {
    throw ApiError.forbidden(`Couldn't ${action}: the role gives scopes you don't have`);
  }
}

/**
 * Disables the member in this workspace: refuses an owner (403), sets `disabled_at`, deletes the member's
 * sessions and MCP OAuth grants in this workspace, audits `member.disabled`. API keys stay and are refused
 * through `memberships.get`. False when the member was disabled already (nothing written); 404 when there is
 * no such member. `actorId` null = the system (SCIM, LDAP sync).
 */
export async function disableMember(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  actorId: string | null,
): Promise<boolean> {
  const current = await ctx.repos.memberships.getIncludingDisabled(tenantId, userId);
  if (!current) throw ApiError.notFound('Member');
  if (current.role === 'owner')
    throw ApiError.forbidden("Couldn't disable the member: an owner can't be disabled");
  if (current.disabledAt) return false;
  const changed = await ctx.database.db.transaction(async (tx) => {
    const repos = createRepositories(tx);
    if (!(await repos.memberships.disable(tenantId, userId))) return false;
    await repos.sessions.deleteForUserInTenant(tenantId, userId);
    await repos.mcpOAuth.deleteTokensForUser(tenantId, userId);
    await repos.audit.add(tenantId, {
      userId: actorId,
      action: 'member.disabled',
      resourceType: 'user',
      resourceId: userId,
    });
    return true;
  });
  return changed;
}

/** Enables a disabled member again, audits `member.enabled`; false when it was enabled already; 404 when none. */
export async function enableMember(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  actorId: string | null,
): Promise<boolean> {
  const current = await ctx.repos.memberships.getIncludingDisabled(tenantId, userId);
  if (!current) throw ApiError.notFound('Member');
  if (!(await ctx.repos.memberships.enable(tenantId, userId))) return false;
  await ctx.repos.audit.add(tenantId, {
    userId: actorId,
    action: 'member.enabled',
    resourceType: 'user',
    resourceId: userId,
  });
  return true;
}

/**
 * Changes the member's workspace role. The caller's own checks come first (route: `assertMemberRole`, owner
 * rules, own role, `assertGrantable`; this takes a tenant id, not a session, because provisioning changes
 * roles at sign-in). Here: the provisioning lock unless `source` is provisioning, the last owner kept (409,
 * under a lock on the owners), the update, a disabled member never made owner (409, read after the update so a
 * disable that committed meanwhile is seen), the audit `member.role_changed`, then the API key scopes above the
 * new role are stripped and private credential entries the member lost are cleaned up. Finds a disabled
 * member too. 404 when there is no such member.
 */
export async function changeMemberRole(
  ctx: ServerContext,
  tenantId: string,
  userId: string,
  role: Role,
  options: { source?: 'provisioning'; actorId?: string; ip?: string } = {},
): Promise<void> {
  if (options.source !== 'provisioning') {
    // P6-11: refused while role provisioning manages the workspace roles
    await ctx.provisioning.assertInstanceRolesEditable(tenantId);
  }
  await ctx.database.db.transaction(async (tx) => {
    const repos = createRepositories(tx);
    const current = await repos.memberships.getIncludingDisabled(tenantId, userId);
    if (!current) throw ApiError.notFound('Member');
    if (current.role === 'owner' && role !== 'owner' && (await repos.memberships.lockOwners(tenantId)) <= 1) {
      throw ApiError.conflict(LAST_OWNER_MESSAGE);
    }
    if (!(await repos.memberships.updateRole(tenantId, userId, role))) throw ApiError.notFound('Member');
    if (role === 'owner' && (await repos.memberships.getIncludingDisabled(tenantId, userId))?.disabledAt) {
      throw ApiError.conflict(DISABLED_OWNER_MESSAGE);
    }
    await repos.audit.add(tenantId, {
      userId: options.actorId ?? null,
      action: 'member.role_changed',
      resourceType: 'user',
      resourceId: userId,
      metadata: { from: current.role, to: role, ...(options.source ? { source: options.source } : {}) },
      ip: options.ip,
    });
  });
  // P6-21: strips the key scopes the new role does not give
  await ctx.apiKeys.onRoleChange(tenantId, userId, role);
  // P6-15: deletes private credential entries the member can no longer reach
  await ctx.privateCredentials.afterAccessChange(tenantId, { userId });
}
