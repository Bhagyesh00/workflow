/**
 * Security settings (P6-33, L12): the personal space policy, `tenants.settings.securityPolicy`
 * (`TenantSettings.securityPolicy`; absent flags are on). Publishing and sharing in personal projects
 * work by adding or removing scopes of `project:personalOwner` (`personalOwnerScopes`); turning a flag off
 * undoes nothing that exists, the counts say how much exists. C0 stub: the constructor is real, every
 * method throws until L12. The public `/settings/security-policy` is L13's (P6-34).
 */
import type { ServiceDeps } from '../context';

const notImplemented = (): never => {
  throw new Error('not implemented (L12)');
};

/** what exists today in personal projects (shown before a flag is turned off) */
export interface SecurityPolicyCounts {
  publishedPersonalWorkflowsCount: number;
  sharedPersonalWorkflowsCount: number;
  sharedPersonalCredentialsCount: number;
}

/** GET /settings/security: the flags (resolved, absent = on) with the counts */
export interface SecurityPolicyDTO extends SecurityPolicyCounts {
  personalSpacePublishing: boolean;
  personalSpaceSharing: boolean;
}

/** POST /settings/security */
export interface SecurityPolicyPatch {
  personalSpacePublishing?: boolean;
  personalSpaceSharing?: boolean;
}

export class SecuritySettingsService {
  constructor(readonly deps: ServiceDeps) {}

  async get(_tenantId: string): Promise<SecurityPolicyDTO> {
    return notImplemented();
  }

  /** `actorId` for the audit log */
  async update(
    _tenantId: string,
    _patch: SecurityPolicyPatch,
    _actorId?: string,
  ): Promise<SecurityPolicyDTO> {
    return notImplemented();
  }

  async counts(_tenantId: string): Promise<SecurityPolicyCounts> {
    return notImplemented();
  }
}
