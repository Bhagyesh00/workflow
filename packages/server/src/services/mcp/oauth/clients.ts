/**
 * OAuth clients of the MCP OAuth server (P5-14, filled by L10). Dynamic registration (RFC 7591): at most
 * 10 redirect URIs of 2048 characters, a name of 255, http only on loopback; `javascript:`, `data:`,
 * `vbscript:`, `file:` and any URI with a fragment refused; `MCP_MAX_REGISTERED_CLIENTS` per tenant.
 * Public clients plus `client_secret_post` and `client_secret_basic`; secrets stored as SHA-256 and
 * compared with `timingSafeEqual`.
 */
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import type { OAuthClientRow } from '../../../repositories/mcp-oauth';

export const MCP_OAUTH_MAX_REDIRECT_URIS = 10;
export const MCP_OAUTH_MAX_REDIRECT_URI_LENGTH = 2048;
export const MCP_OAUTH_MAX_CLIENT_NAME_LENGTH = 255;

/** the reply of the registration endpoint: the client's metadata (201), or `{ error, error_description }` */
export interface McpOAuthRegisterReply {
  statusCode: number;
  body: Record<string, unknown>;
}

/** `POST /mcp-oauth/:tenantSlug/register` */
export async function registerMcpOAuthClient(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _body: unknown,
): Promise<McpOAuthRegisterReply> {
  throw new Error('not implemented (L10)');
}

/** why a redirect URI is refused (at register and in the allowed list), or null when it is fine */
export function redirectUriProblem(_uri: string): string | null {
  throw new Error('not implemented (L10)');
}

/**
 * The client of a token or revoke request: `client_secret_basic` (the Authorization header),
 * `client_secret_post` (the body) or a public client (`client_id` only); undefined is `invalid_client`.
 */
export async function authenticateMcpOAuthClient(
  _ctx: ServerContext,
  _tenantId: string,
  _body: Record<string, string>,
  _authorization: string | undefined,
): Promise<OAuthClientRow | undefined> {
  throw new Error('not implemented (L10)');
}
