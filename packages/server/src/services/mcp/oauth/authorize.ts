/**
 * The authorize step of the MCP OAuth server (P5-14, filled by L10). The redirect URI is checked BEFORE
 * any redirect (GHSA-rc3w), against the client's list and the tenant's allowed list (empty adds no rule,
 * non-loopback exact, loopback any port). PKCE S256 required. `resource` must be this tenant's server URL
 * or one of its trigger URLs; omitted it is the server URL; anything else `invalid_target` (after the
 * redirect check). Unknown scopes dropped. Then a flow token (`formTokens.sign`, 300 s) holding the
 * redirect's index, not the URI, and `state` capped at 1024, and a redirect to
 * `${baseUrl}/oauth/consent?flow=<token>`.
 */
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import type { McpScope } from '../types';

/** the `kind` of a flow token; a form token of another feature is refused as a flow */
export const MCP_OAUTH_FLOW_KIND = 'mcp-oauth-flow';

/** flow token lifetime, seconds */
export const MCP_OAUTH_FLOW_TTL_S = 300;

/** the longest `state` a flow token carries */
export const MCP_OAUTH_STATE_LIMIT = 1024;

/** what a flow token holds */
export interface McpOAuthFlow {
  kind: typeof MCP_OAUTH_FLOW_KIND;
  tenantId: string;
  clientId: string;
  /** index into the client's `redirect_uris` */
  redirectIndex: number;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  state?: string;
}

/**
 * The answer to `GET /mcp-oauth/:tenantSlug/authorize`: a redirect (to the consent page, or back to the
 * client with an error once its redirect URI passed), or an error page with no redirect.
 */
export type McpAuthorizeOutcome =
  | { redirect: string }
  | { statusCode: number; body: Record<string, unknown> };

export async function startMcpAuthorization(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _query: Record<string, unknown>,
): Promise<McpAuthorizeOutcome> {
  throw new Error('not implemented (L10)');
}

/** the flow of a flow token, or null when it is invalid, expired or of another kind */
export function readMcpOAuthFlow(_ctx: ServerContext, _token: string): McpOAuthFlow | null {
  throw new Error('not implemented (L10)');
}
