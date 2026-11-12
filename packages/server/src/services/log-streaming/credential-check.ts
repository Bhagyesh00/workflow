/**
 * P6-06 (S5 L3): the credential a webhook destination authenticates with, as n8n's destination-credentials-access:
 * in the workspace (else 404), one of the generic HTTP auth types (else 400), and the caller holds `credential:read`
 * on it through `ctx.access.scopesFor` (else 403, n8n's text).
 */
import type { ServiceDeps } from '../../context';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import { MISSING_SCOPE_MESSAGE } from '../access';

/** the credential types a destination may use */
export const DESTINATION_CREDENTIAL_TYPES = Object.freeze([
  'httpBasicAuth',
  'httpDigestAuth',
  'httpHeaderAuth',
  'httpQueryAuth',
  'httpCustomAuth',
] as const);

/** throws the 404, 400 or 403; returns when the caller may attach the credential to a destination */
export async function assertDestinationCredential(
  deps: ServiceDeps,
  auth: AuthContext,
  credentialId: string,
): Promise<void> {
  const row = await deps.repos.credentials.get(auth.tenant.id, credentialId);
  if (!row) throw ApiError.notFound('Credential');
  if (!(DESTINATION_CREDENTIAL_TYPES as readonly string[]).includes(row.type)) {
    throw ApiError.badRequest(
      "Couldn't use this credential for a log destination: it must be a generic HTTP authentication credential (basic, digest, header, query or custom).",
    );
  }
  const scopes = await deps.context().access.scopesFor(auth.tenant.id, auth.user.id, { credentialId });
  if (!scopes.has('credential:read')) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
}
