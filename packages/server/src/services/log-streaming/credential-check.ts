/**
 * P6-06 (S5 C0 stub, L3 fills it): the credential a webhook destination authenticates with, as n8n's
 * destination-credentials-access: in the tenant (else 404), one of the generic HTTP auth types (else 400), and the
 * caller holds `credential:read` on it through `ctx.access.scopesFor` (else 403).
 */
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';

/** the credential types a destination may use */
export const DESTINATION_CREDENTIAL_TYPES = Object.freeze([
  'httpBasicAuth',
  'httpDigestAuth',
  'httpHeaderAuth',
  'httpQueryAuth',
  'httpCustomAuth',
] as const);

/** stub (L3): throws the 404, 400 or 403 */
export function assertDestinationCredential(
  _deps: ServiceDeps,
  _auth: AuthContext,
  _credentialId: string,
): Promise<void> {
  throw new Error('not implemented (L3)');
}
