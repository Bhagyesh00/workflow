/**
 * Discovery documents of the MCP OAuth server (P5-14, filled by L10). Issuer
 * `${config.mcp.baseUrl}/mcp-oauth/<slug>` (`mcpOAuthIssuer`); RFC 8414 at
 * `/.well-known/oauth-authorization-server/mcp-oauth/<slug>` (path insertion); RFC 9728 at
 * `/.well-known/oauth-protected-resource/mcp-server/<slug>/http` and
 * `/.well-known/oauth-protected-resource/<endpoint>/<slug>/<path>` (`mcpResourceMetadataUrl`).
 */
import type { Config } from '../../../config';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';

/** RFC 8414 authorization server metadata of the tenant (S256 only, the four endpoints, `MCP_SCOPES`) */
export function mcpAuthorizationServerMetadata(
  _config: Config,
  _tenantSlug: string,
): Record<string, unknown> {
  throw new Error('not implemented (L10)');
}

/**
 * RFC 9728 protected resource metadata for a resource path (`mcp-server/<slug>/http`, or a trigger's
 * `<endpoint>/<slug>/<path>`); null when the path names no resource of this tenant (404).
 */
export async function mcpProtectedResourceMetadata(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _resourcePath: string,
): Promise<Record<string, unknown> | null> {
  throw new Error('not implemented (L10)');
}
