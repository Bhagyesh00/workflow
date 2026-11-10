/**
 * P6-01 (L6): a workspace's sign-in method (`tenant_auth_settings`, read per request): email, SAML, OIDC
 * or LDAP. `setMethod` moves SAML to OIDC only through email, refuses a method with no saved config, and
 * turning SSO off sets `tenants.settings.scim.enabled = false` (the token is kept).
 * Stub from C0: `isSsoActive` PASSES (false: no workspace uses SSO before L6); the rest throws until L6.
 */
import type { ServiceDeps } from '../../context';
import type { TenantAuthSettingsRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import type { SsoMethod } from '../../repositories/sso';

/** a config section of `tenant_auth_settings` a protocol service saves */
export type SsoSection = 'saml' | 'oidc' | 'ldap' | 'provisioning';

export class SsoSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /** the workspace's row, or undefined (method `email`) */
  async get(_tenantId: string): Promise<TenantAuthSettingsRow | undefined> {
    throw new Error('not implemented (L6)');
  }

  async activeMethod(_tenantId: string): Promise<SsoMethod> {
    throw new Error('not implemented (L6)');
  }

  /** SAML or OIDC is the active method. Stub (L6) PASSES: false */
  async isSsoActive(_tenantId: string): Promise<boolean> {
    return false;
  }

  /** PUT /sso/method; audit `sso.method_changed` */
  async setMethod(_auth: AuthContext, _method: SsoMethod): Promise<void> {
    throw new Error('not implemented (L6)');
  }

  /** writes one config section (the protocol services check it first) */
  async saveSection(_tenantId: string, _section: SsoSection, _value: unknown): Promise<void> {
    throw new Error('not implemented (L6)');
  }
}
