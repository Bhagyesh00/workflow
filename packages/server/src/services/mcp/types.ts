/**
 * Shared types of the tenant MCP server (P5-04), its tools (P5-04, P5-13) and its OAuth server
 * (P5-14). A caller comes from an MCP key (audience `mcp-server-api`) or an OAuth access token.
 * A tool is listed and called only when the OAuth grant holds one of its `scopes` (the client's
 * grant, a second gate) AND the user holds its `access` scope, workspace wide or in a project (P6-35);
 * each resource a tool touches is checked again on its own project.
 */
import type { DataObject, Scope } from '@workflow/workflow';
import type { z } from 'zod';
import type { Config } from '../../config';
import type { ServerContext } from '../../context';
import type { Role, TenantRow, UserRow } from '../../db/schema';

/** the scopes an OAuth client can ask for; an MCP key holds all of them */
export const MCP_SCOPES = [
  'workflow:read',
  'workflow:write',
  'workflow:execute',
  'execution:read',
  'credential:read',
  'tag:read',
  'dataTable:read',
  'dataTable:write',
  'project:read',
  'project:write',
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/** `api_keys.audience` of the MCP Server API key: never accepted on the public API, and the reverse */
export const MCP_KEY_AUDIENCE = 'mcp-server-api';

/** the name of the MCP key row (one per user) */
export const MCP_KEY_LABEL = 'MCP Server API Key';

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === 'string' && (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * Who calls the tenant MCP server. `role` and `globalScopes` are the membership's current ones, read on
 * every request, never the token's: a removed member or a narrowed role takes effect on the next call.
 */
export interface McpCaller {
  user: UserRow;
  tenant: TenantRow;
  role: Role;
  /** the caller's workspace wide scopes (`AccessService.globalScopes`); project scopes are read per target */
  globalScopes: ReadonlySet<Scope>;
  scopes: McpScope[];
  via: 'key' | 'oauth';
  /** the OAuth client, when `via` is `oauth` */
  clientId?: string;
  /** the MCP key row, when `via` is `key` */
  apiKeyId?: string;
}

/** one tool of the tenant MCP server */
export interface McpToolDefinition<I = unknown> {
  name: string;
  description: string;
  /** any one of them unlocks the tool */
  scopes: McpScope[];
  /**
   * the scope the matching REST route needs: held workspace wide or in at least one project (the list
   * and the call check this); the handler checks it again on the project of every resource it touches
   */
  access: Scope;
  /** the arguments; its JSON Schema is the tool's `inputSchema` */
  input: z.ZodType<I>;
  /** MCP tool annotations (`readOnlyHint`, `destructiveHint`, ...) */
  annotations?: DataObject;
  handler(ctx: ServerContext, caller: McpCaller, input: I): Promise<unknown>;
}

/** `<mcp base>/mcp-server/<slug>/http`: the tenant server's URL, the `resource` its tokens are bound to */
export function mcpServerUrl(config: Config, tenantSlug: string): string {
  return `${config.mcp.baseUrl}/mcp-server/${encodeURIComponent(tenantSlug)}/http`;
}

/** `<mcp base>/mcp-oauth/<slug>`: the tenant's OAuth issuer */
export function mcpOAuthIssuer(config: Config, tenantSlug: string): string {
  return `${config.mcp.baseUrl}/mcp-oauth/${encodeURIComponent(tenantSlug)}`;
}

/**
 * The RFC 9728 metadata URL of a protected resource (path insertion):
 * `https://h/mcp-server/acme/http` gives `https://h/.well-known/oauth-protected-resource/mcp-server/acme/http`.
 * The `resource_metadata` of a 401's `WWW-Authenticate`.
 */
export function mcpResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
