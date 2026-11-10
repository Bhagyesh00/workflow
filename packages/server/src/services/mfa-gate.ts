/**
 * P6-18 (L2): the enforced MFA gate of the session load. When the workspace enforces MFA
 * (`tenants.settings.mfa.enforced`) and the session did not pass the MFA step, a request answers 401
 * `mfa_enrollment_required`, except `/rest/auth/*` and GET `/rest/settings` (so the person can set MFA up).
 * Stub from C0: it PASSES every session; L2 fills it.
 */
import type { FastifyRequest } from 'fastify';
import type { TenantRow } from '../db/schema';

/** the session row fields the gate reads */
export interface MfaGateSession {
  id: string;
  userId: string;
  tenantId: string;
  authMethod: 'password' | 'saml' | 'oidc' | 'ldap';
  mfaVerified: boolean;
}

export async function assertMfaSatisfied(
  _request: FastifyRequest,
  _tenant: TenantRow,
  _session: MfaGateSession,
): Promise<void> {
  // stub (L2): PASSES until L2 adds the enforcement
}
