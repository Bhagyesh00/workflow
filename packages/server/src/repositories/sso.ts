/**
 * P6-01 (L6): a workspace's sign-in settings (`tenant_auth_settings`: method, SAML, OIDC, LDAP and
 * provisioning config, JIT) and the links between a directory identity and a member (`auth_identities`).
 * Stub from C0 except `upsert`, which C0e's test helper `ssoOn` uses; L6 fills the rest.
 */
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { type AuthIdentityRow, type TenantAuthSettingsRow, tenantAuthSettings } from '../db/schema';

export type SsoMethod = TenantAuthSettingsRow['method'];
export type SsoProviderType = AuthIdentityRow['providerType'];

/** the columns a caller may set; `tenantId` and `updatedAt` are the repository's */
export type SsoSettingsPatch = Partial<
  Omit<typeof tenantAuthSettings.$inferInsert, 'tenantId' | 'updatedAt'>
>;

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
  async get(_tenantId: string): Promise<TenantAuthSettingsRow | undefined> {
    throw new Error('not implemented (L6)');
  }

  /** the identity a provider knows the person by, in this workspace */
  async getIdentity(
    _tenantId: string,
    _providerType: SsoProviderType,
    _providerId: string,
  ): Promise<AuthIdentityRow | undefined> {
    throw new Error('not implemented (L6)');
  }

  /** links a provider identity to a member of the workspace */
  async linkIdentity(
    _tenantId: string,
    _input: { providerType: SsoProviderType; providerId: string; userId: string },
  ): Promise<void> {
    throw new Error('not implemented (L6)');
  }

  /** deletes the workspace's identities of one provider type (`ldap:reset`, a method's config cleared) */
  async deleteIdentities(_tenantId: string, _providerType: SsoProviderType): Promise<number> {
    throw new Error('not implemented (L6)');
  }
}
