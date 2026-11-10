/**
 * P6-18 (L2): the enforced MFA gate of the session load. When the workspace enforces MFA
 * (`tenants.settings.mfa.enforced`) and the session did not pass the MFA step, a request answers 401
 * `mfa_enrollment_required`, except `/rest/auth/*` and GET `/rest/settings` (so the person can set MFA up
 * or verify). An SSO session is stored with `mfa_verified = true` and passes.
 */
import type { FastifyRequest } from 'fastify';
import type { TenantRow } from '../db/schema';
import { ApiError } from '../http/errors';

/** the session row fields the gate reads */
export interface MfaGateSession {
  id: string;
  userId: string;
  tenantId: string;
  authMethod: 'password' | 'saml' | 'oidc' | 'ldap';
  mfaVerified: boolean;
}

export const MFA_ENROLLMENT_REQUIRED_MESSAGE =
  'This workspace requires two-factor sign-in. Set it up under Settings > Your account.';

/** the workspace requires two-factor sign-in (`tenants.settings.mfa.enforced`) */
export function isMfaEnforced(tenant: Pick<TenantRow, 'settings'>): boolean {
  const mfa = (tenant.settings as { mfa?: { enforced?: unknown } } | null)?.mfa;
  return mfa?.enforced === true;
}

export async function assertMfaSatisfied(
  request: FastifyRequest,
  tenant: TenantRow,
  session: MfaGateSession,
): Promise<void> {
  if (!isMfaEnforced(tenant) || session.mfaVerified) return;
  const path = request.url.split('?')[0];
  if (path.startsWith('/rest/auth/')) return;
  if (request.method === 'GET' && path === '/rest/settings') return;
  throw new ApiError(401, 'mfa_enrollment_required', MFA_ENROLLMENT_REQUIRED_MESSAGE);
}
