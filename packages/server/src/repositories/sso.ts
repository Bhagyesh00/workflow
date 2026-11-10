/**
 * P6-01 (L6): a workspace's sign-in settings (`tenant_auth_settings`: method, SAML, OIDC, LDAP and
 * provisioning config, JIT) and the links between a directory identity and a member (`auth_identities`).
 * Every query filters `tenant_id` with a bound value (both tables are under RLS as well); the password rules
 * of a user read the memberships with each workspace's method in one join.
 */
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type AuthIdentityRow,
  authIdentities,
  invitations,
  memberships,
  type Role,
  type TenantAuthSettingsRow,
  tenantAuthSettings,
  tenants,
} from '../db/schema';
import { isUuid } from './util';

export type SsoMethod = TenantAuthSettingsRow['method'];
export type SsoProviderType = AuthIdentityRow['providerType'];

/** the columns a caller may set; `tenantId` and `updatedAt` are the repository's */
export type SsoSettingsPatch = Partial<
  Omit<typeof tenantAuthSettings.$inferInsert, 'tenantId' | 'updatedAt'>
>;

/** one enabled membership of a user with its workspace's sign-in method (email when none is saved) */
export interface MembershipSignInRule {
  tenantId: string;
  role: Role;
  method: SsoMethod;
  allowSsoManualLogin: boolean;
}

/** a pending invitation of an email in one workspace */
export interface PendingInvitation {
  id: string;
  role: Role;
}

export class SsoRepository {
  constructor(private readonly db: DbOrTx) {}

  /**
   * FULL: creates the workspace's row or changes the given columns, in one insert on conflict; the row.
   * It does not check the method's config (`SsoSettingsService.setMethod` does).
   */
  async upsert(tenantId: string, patch: SsoSettingsPatch): Promise<TenantAuthSettingsRow> {
    const [row] = await this.db
      .insert(tenantAuthSettings)
      .values({ ...patch, tenantId })
      .onConflictDoUpdate({ target: tenantAuthSettings.tenantId, set: { ...patch, updatedAt: sql`now()` } })
      .returning();
    return row;
  }

  /** the row, or undefined when the workspace never saved one (method `email`) */
  async get(tenantId: string): Promise<TenantAuthSettingsRow | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select()
      .from(tenantAuthSettings)
      .where(eq(tenantAuthSettings.tenantId, tenantId));
    return row;
  }

  /** the identity a provider knows the person by, in this workspace */
  async getIdentity(
    tenantId: string,
    providerType: SsoProviderType,
    providerId: string,
  ): Promise<AuthIdentityRow | undefined> {
    if (!isUuid(tenantId) || !providerId) return undefined;
    const [row] = await this.db
      .select()
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.tenantId, tenantId),
          eq(authIdentities.providerType, providerType),
          eq(authIdentities.providerId, providerId),
        ),
      );
    return row;
  }

  /**
   * links a provider identity to a member of the workspace (the membership must exist: the foreign key);
   * an identity the provider already linked stays as it is
   */
  async linkIdentity(
    tenantId: string,
    input: { providerType: SsoProviderType; providerId: string; userId: string },
  ): Promise<void> {
    await this.db
      .insert(authIdentities)
      .values({ tenantId, ...input })
      .onConflictDoNothing({
        target: [authIdentities.tenantId, authIdentities.providerType, authIdentities.providerId],
      });
  }

  /** deletes the workspace's identities of one provider type (`ldap:reset`, a method's config cleared) */
  async deleteIdentities(tenantId: string, providerType: SsoProviderType): Promise<number> {
    if (!isUuid(tenantId)) return 0;
    const rows = await this.db
      .delete(authIdentities)
      .where(and(eq(authIdentities.tenantId, tenantId), eq(authIdentities.providerType, providerType)))
      .returning({ providerId: authIdentities.providerId });
    return rows.length;
  }

  /** the user's enabled memberships, each with its workspace's sign-in method and the manual login flag */
  async signInRules(userId: string, tenantId?: string): Promise<MembershipSignInRule[]> {
    if (!isUuid(userId) || (tenantId !== undefined && !isUuid(tenantId))) return [];
    const rows = await this.db
      .select({
        tenantId: memberships.tenantId,
        role: memberships.role,
        method: tenantAuthSettings.method,
        allowSsoManualLogin: memberships.allowSsoManualLogin,
      })
      .from(memberships)
      .leftJoin(tenantAuthSettings, eq(tenantAuthSettings.tenantId, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
          tenantId === undefined ? undefined : eq(memberships.tenantId, tenantId),
        ),
      );
    return rows.map((row) => ({ ...row, method: row.method ?? 'email' }));
  }

  /** how many workspaces besides `tenantId` the user belongs to (disabled memberships count) */
  async otherMembershipCount(userId: string, tenantId: string): Promise<number> {
    if (!isUuid(userId) || !isUuid(tenantId)) return 0;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), ne(memberships.tenantId, tenantId)));
    return row?.n ?? 0;
  }

  /** the newest pending (not accepted, not expired) invitation of `email` in the workspace */
  async pendingInvitation(tenantId: string, email: string): Promise<PendingInvitation | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const [row] = await this.db
      .select({ id: invitations.id, role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.tenantId, tenantId),
          eq(invitations.email, email.toLowerCase()),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(invitations.createdAt))
      .limit(1);
    return row;
  }

  /**
   * P6-01: SSO turned off turns SCIM off (`tenants.settings.scim.enabled = false`), in one UPDATE that keeps
   * the rest of the SCIM settings (and the token, which lives elsewhere); nothing changes without them
   */
  async disableScim(tenantId: string): Promise<void> {
    if (!isUuid(tenantId)) return;
    await this.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(${tenants.settings}, '{scim,enabled}', 'false'::jsonb, true)`,
      })
      .where(and(eq(tenants.id, tenantId), sql`jsonb_typeof(${tenants.settings} -> 'scim') = 'object'`));
  }
}
