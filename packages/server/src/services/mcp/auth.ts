/**
 * Bearer auth of the tenant MCP server (P5-04). `wfo_at_` tokens go to the OAuth server
 * (`verifyMcpOAuthToken`, P5-14), `wfk_` keys to `authenticateApiKey(key, 'mcp-server-api')`; a public
 * API key (audience `public-api`) is refused like an unknown key. The key or token must belong to the
 * slug's tenant, and the role is the membership's current one, so a removed member loses access at once.
 * No cookie and no session are read.
 */
import type { ServerContext } from '../../context';
import { isMcpOAuthToken, verifyMcpOAuthToken } from './oauth/tokens';
import { isMcpScope, MCP_KEY_AUDIENCE, MCP_SCOPES, type McpCaller } from './types';

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

/** the most characters a Bearer value may have before it is refused unread */
const MAX_TOKEN_LENGTH = 4096;

/**
 * The caller of a `Authorization: Bearer ...` header for `resource` (the tenant server's URL);
 * null when the header is missing or the key or token is not valid for this tenant (401).
 */
export async function authenticateMcpBearer(
  ctx: ServerContext,
  tenantSlug: string,
  header: string | undefined,
  resource: string,
): Promise<McpCaller | null> {
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header);
  const token = match?.[1];
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;
  const tenant = await ctx.repos.tenants.getBySlug(tenantSlug);
  if (!tenant) return null;

  if (isMcpOAuthToken(token)) {
    const info = await verifyMcpOAuthToken(ctx, tenant.id, token, resource);
    if (!info) return null;
    const [membership, user] = await Promise.all([
      ctx.repos.memberships.get(tenant.id, info.userId),
      ctx.repos.users.get(info.userId),
    ]);
    if (!membership || !user) return null;
    return {
      user,
      tenant,
      role: membership.role,
      scopes: [...new Set(info.scopes.filter(isMcpScope))],
      via: 'oauth',
      clientId: info.clientId,
    };
  }

  if (!token.startsWith('wfk_')) return null;
  // audience 'mcp-server-api' only: a public API key is not an MCP key
  const auth = await ctx.auth.authenticateApiKey(token, MCP_KEY_AUDIENCE);
  if (!auth || auth.tenant.id !== tenant.id) return null;
  return {
    user: auth.user,
    tenant: auth.tenant,
    role: auth.role,
    scopes: [...MCP_SCOPES],
    via: 'key',
    apiKeyId: auth.apiKeyId,
  };
}
