/**
 * Tokens of the MCP OAuth server (P5-14, filled by L10): opaque, stored as SHA-256 only. Access
 * `wfo_at_` (1 h) and refresh `wfo_rt_` (30 days, rotated; an old one replayed gets `invalid_grant`),
 * bound to the granted `resource` (GHSA-cw9w). `verifyMcpOAuthToken` reads the membership on every call,
 * so a removed user loses access, and the role always comes from the membership, never the token.
 *
 * C0: `isMcpOAuthToken` is final; `verifyMcpOAuthToken` returns null and `createMcpAuthHelper`
 * refuses every token (no throw), so the trigger and the tenant server answer 401 until L10.
 */
import type { McpAuthHelper } from '@workflow/workflow';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import { type McpScope, mcpResourceMetadataUrl } from '../types';

export const MCP_OAUTH_ACCESS_PREFIX = 'wfo_at_';
export const MCP_OAUTH_REFRESH_PREFIX = 'wfo_rt_';

/** access token lifetime, seconds */
export const MCP_OAUTH_ACCESS_TTL_S = 3600;
/** refresh token lifetime, seconds */
export const MCP_OAUTH_REFRESH_TTL_S = 30 * 86_400;

/** whether a Bearer value is an MCP OAuth access token (`wfo_at_...`), not an MCP key (`wfk_...`) */
export function isMcpOAuthToken(token: string): boolean {
  return typeof token === 'string' && token.startsWith(MCP_OAUTH_ACCESS_PREFIX);
}

export interface McpOAuthTokenInfo {
  userId: string;
  scopes: McpScope[];
  clientId: string;
}

/**
 * The grant behind a valid, unexpired access token of this tenant for exactly `resource`, whose user
 * is still a member; null otherwise.
 */
export async function verifyMcpOAuthToken(
  _ctx: ServerContext,
  _tenantId: string,
  _token: string,
  _resource: string,
): Promise<McpOAuthTokenInfo | null> {
  return null;
}

/** the reply of the token endpoint (RFC 6749 section 5): a token pair, or `{ error, error_description? }` */
export interface McpOAuthTokenReply {
  statusCode: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * `POST /mcp-oauth/:tenantSlug/token`: `authorization_code` (client authenticated first, the code's
 * client and `redirect_uri` equal to the request's, PKCE S256, `resource` equal to the code's) and
 * `refresh_token` (rotation, bound to the granted resource).
 */
export async function exchangeMcpOAuthToken(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _body: Record<string, string>,
  _authorization: string | undefined,
): Promise<McpOAuthTokenReply> {
  throw new Error('not implemented (L10)');
}

/** `POST /mcp-oauth/:tenantSlug/revoke` (RFC 7009): immediate; an unknown token is still 200 */
export async function revokeMcpOAuthToken(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _body: Record<string, string>,
  _authorization: string | undefined,
): Promise<McpOAuthTokenReply> {
  throw new Error('not implemented (L10)');
}

/**
 * The trigger's sign-in helper (`ExecutionServices.mcpAuth`, `WebhookContext.getMcpAuth`). The tenant
 * comes from the `resource` URL's slug. Takes the context or a getter of it, so it can be built before
 * the context is ready. C0: every token refused, nobody may execute.
 */
export function createMcpAuthHelper(_ctx: ServerContext | (() => ServerContext)): McpAuthHelper {
  return {
    verifyAccessToken: async () => null,
    canExecute: async () => false,
    challenge: (resource: string) => `Bearer resource_metadata="${mcpResourceMetadataUrl(resource)}"`,
  };
}
