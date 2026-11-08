/**
 * Bearer auth of the tenant MCP server (P5-04, filled by L8). `wfo_at_` tokens go to the OAuth
 * server (`verifyMcpOAuthToken`, P5-14), `wfk_` keys to `authenticateApiKey(key, 'mcp-server-api')`;
 * a public API key is refused. The key or token must belong to the slug's tenant, and the role is
 * the membership's current one.
 */
import type { ServerContext } from '../../context';
import type { McpCaller } from './types';

/**
 * The caller of a `Authorization: Bearer ...` header for `resource` (the tenant server's URL);
 * null when the header is missing or the key or token is not valid for this tenant (401).
 */
export async function authenticateMcpBearer(
  _ctx: ServerContext,
  _tenantSlug: string,
  _header: string | undefined,
  _resource: string,
): Promise<McpCaller | null> {
  throw new Error('not implemented (L8)');
}
