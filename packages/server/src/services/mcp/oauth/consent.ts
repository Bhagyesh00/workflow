/**
 * The consent step of the MCP OAuth server (P5-14, filled by L10), behind the session of
 * `/rest/consent/*`. Details need a membership in the flow's tenant, whatever the session's current
 * tenant (else 403). Approve keeps the intersection of the scopes picked with the flow token's list,
 * stores the consent, makes a code (SHA-256, 10 minutes, single use through `takeCode`) and returns the
 * redirect with `code`, `state` and `iss` (RFC 9207); deny returns it with `access_denied`.
 */
import type { ServerContext } from '../../../context';
import type { AuthContext } from '../../../http/auth';
import type { McpScope } from '../types';

/** authorization code lifetime, seconds */
export const MCP_OAUTH_CODE_TTL_S = 600;

/** what the consent page shows */
export interface McpConsentDetails {
  clientName: string;
  /** the workspace that grants access */
  tenantName: string;
  /** the server or trigger URL the token will be bound to */
  resource: string;
  scopes: McpScope[];
  /** the host the browser goes back to */
  redirectHost: string;
}

export interface McpConsentDecision {
  flow: string;
  approved: boolean;
  /** the scopes the user kept; only those in the flow token count */
  scopes?: string[];
}

/** `GET /rest/consent/details?flow=` */
export async function mcpConsentDetails(
  _ctx: ServerContext,
  _auth: AuthContext,
  _flow: string,
): Promise<McpConsentDetails> {
  throw new Error('not implemented (L10)');
}

/** `POST /rest/consent/approve`: where the browser goes next (the client's redirect URI) */
export async function approveMcpConsent(
  _ctx: ServerContext,
  _auth: AuthContext,
  _decision: McpConsentDecision,
): Promise<{ redirectUrl: string }> {
  throw new Error('not implemented (L10)');
}
