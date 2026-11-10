/**
 * P6-01 (L6): a workspace's sign-in method (`tenant_auth_settings`, read per request, never cached): email,
 * SAML, OIDC or LDAP. One method is active at a time, as n8n. `setMethod` moves between two of SAML, OIDC and
 * LDAP only through email, refuses a method with no saved config, and turning SAML or OIDC off sets
 * `tenants.settings.scim.enabled = false` (the SCIM token is kept), as n8n turns SCIM off with SSO.
 */
import type { ServiceDeps } from '../../context';
import type { TenantAuthSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { createRepositories } from '../../repositories';
import type { SsoMethod, SsoSettingsPatch } from '../../repositories/sso';

/** a config section of `tenant_auth_settings` a protocol service saves */
export type SsoSection = 'saml' | 'oidc' | 'ldap' | 'provisioning';

/** the names a method has in a user text */
export const SSO_METHOD_NAMES: Readonly<Record<SsoMethod, string>> = {
  email: 'Email',
  saml: 'SAML',
  oidc: 'OIDC',
  ldap: 'LDAP',
};

/** SAML and OIDC are single sign-on: password sign-in is fenced while one is active */
export function isSsoMethod(method: SsoMethod): method is 'saml' | 'oidc' {
  return method === 'saml' || method === 'oidc';
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** what an LDAP sign-in cannot work without (as `REQUIRED_TO_RUN` in services/sso/ldap.ts) */
const LDAP_REQUIRED = ['connectionUrl', 'baseDn', 'emailAttribute', 'loginIdAttribute', 'ldapIdAttribute'];

/**
 * whether the workspace saved what the method needs to sign anyone in: the identity provider's metadata
 * (SAML, XML or URL), the client and discovery endpoint (OIDC), the directory URL, base DN and the email,
 * login ID and LDAP ID attributes (LDAP)
 */
export function hasSavedConfig(row: TenantAuthSettingsRow | undefined, method: SsoMethod): boolean {
  if (method === 'email') return true;
  if (!row) return false;
  if (method === 'saml') {
    return filled(row.samlMetadata) || filled(row.saml?.metadata) || filled(row.saml?.metadataUrl);
  }
  if (method === 'oidc') return filled(row.oidc?.clientId) && filled(row.oidc?.discoveryEndpoint);
  const ldap = row.ldap;
  return !!ldap && LDAP_REQUIRED.every((key) => filled(ldap[key]));
}

export class SsoSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workspace's row, or undefined (method `email`) */
  async get(tenantId: string): Promise<TenantAuthSettingsRow | undefined> {
    return this.deps.repos.sso.get(tenantId);
  }

  async activeMethod(tenantId: string): Promise<SsoMethod> {
    return (await this.get(tenantId))?.method ?? 'email';
  }

  /** SAML or OIDC is the active method */
  async isSsoActive(tenantId: string): Promise<boolean> {
    return isSsoMethod(await this.activeMethod(tenantId));
  }

  /** PUT /sso/method; audit `sso.method_changed` */
  async setMethod(auth: AuthContext, method: SsoMethod): Promise<void> {
    const tenantId = auth.tenant.id;
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const row = await repos.sso.get(tenantId);
      const current = row?.method ?? 'email';
      if (current === method) return;
      if (current !== 'email' && method !== 'email') {
        throw new ApiError(
          400,
          'sso_switch_through_email',
          `Turn ${SSO_METHOD_NAMES[current]} off first. A workspace moves from one sign-in method to another through email sign-in.`,
        );
      }
      if (!hasSavedConfig(row, method)) {
        throw new ApiError(
          400,
          'sso_config_missing',
          `Save the ${SSO_METHOD_NAMES[method]} settings before turning ${SSO_METHOD_NAMES[method]} on.`,
        );
      }
      await repos.sso.upsert(tenantId, { method });
      // n8n turns SCIM off with SSO; the token stays, so turning SCIM on again needs no new one
      if (isSsoMethod(current)) await repos.sso.disableScim(tenantId);
      await repos.audit.add(tenantId, {
        userId: auth.user.id,
        action: 'sso.method_changed',
        resourceType: 'tenant',
        resourceId: tenantId,
        metadata: { from: current, to: method },
      });
    });
  }

  /** writes one config section (the protocol services check it first); null clears it */
  async saveSection(tenantId: string, section: SsoSection, value: unknown): Promise<void> {
    if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
      throw ApiError.badRequest(`The ${section} settings must be an object`);
    }
    const patch: SsoSettingsPatch = {};
    patch[section] = value as Record<string, unknown> | null;
    await this.deps.repos.sso.upsert(tenantId, patch);
  }
}
