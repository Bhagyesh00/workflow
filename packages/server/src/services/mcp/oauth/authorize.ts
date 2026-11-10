/**
 * The authorize step of the MCP OAuth server (P5-14). The redirect URI is checked BEFORE any redirect
 * (GHSA-rc3w), against the client's list and the tenant's allowed list (empty adds no rule, non-loopback
 * exact, loopback any port). PKCE S256 required. `resource` must be this tenant's server URL (only while
 * its MCP access is on) or one of its trigger URLs (an MCP Server Trigger, or a Webhook with workspace sign-in,
 * on the MCP base URL); omitted it is the server URL; anything else
 * `invalid_target` (after the redirect check). Unknown scopes dropped. Then a flow token (`formTokens.sign`, 300 s) holding the redirect's
 * index, not the URI, and `state` capped at 1024, and a redirect to `${baseUrl}/oauth/consent?flow=<token>`.
 */
import type { DataObject } from '@workflow/workflow';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import type { TenantSettings } from '../../../plans';
import { mcpAccessEnabled } from '../settings';
import { isMcpScope, MCP_SCOPES, type McpScope, mcpOAuthIssuer, mcpServerUrl } from '../types';
import { isLoopbackHost } from './clients';
import { isTenantMcpResource } from './metadata';

/** the `kind` of a flow token; a form token of another feature is refused as a flow */
export const MCP_OAUTH_FLOW_KIND = 'mcp-oauth-flow';

/** flow token lifetime, seconds */
export const MCP_OAUTH_FLOW_TTL_S = 300;

/** the longest `state` a flow token carries */
export const MCP_OAUTH_STATE_LIMIT = 1024;

/** RFC 7636: a code challenge (S256) is 43 base64url characters; a verifier 43 to 128 unreserved ones */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

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

const errorPage = (error: string, description: string): McpAuthorizeOutcome => ({
  statusCode: 400,
  body: { error, error_description: description },
});

/** one query value: a repeated parameter is not one (RFC 6749 3.1) */
function single(query: Record<string, unknown>, name: string): string | undefined | null {
  const value = query[name];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

/** the client's redirect URI with `params` added (an error or a code), plus `iss` (RFC 9207) */
export function redirectWith(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * The tenant's allowed list (MCP settings): empty adds no rule; a loopback entry matches the same
 * scheme, host and path on any port; any other entry must equal the URI exactly.
 */
export function redirectAllowedByTenant(allowed: readonly string[], redirectUri: string): boolean {
  if (allowed.length === 0) return true;
  let target: URL | undefined;
  try {
    target = new URL(redirectUri);
  } catch {
    target = undefined;
  }
  return allowed.some((entry) => {
    if (entry === redirectUri) return true;
    if (!target || !isLoopbackHost(target.hostname)) return false;
    try {
      const rule = new URL(entry);
      return (
        isLoopbackHost(rule.hostname) &&
        rule.protocol === target.protocol &&
        rule.hostname === target.hostname &&
        rule.pathname === target.pathname &&
        rule.search === target.search
      );
    } catch {
      return false;
    }
  });
}

/** the tenant's allowed redirect URIs (MCP settings) */
export function tenantAllowedRedirectUris(tenant: Pick<TenantRow, 'settings'>): string[] {
  const list = ((tenant.settings ?? {}) as TenantSettings).mcp?.allowedRedirectUris;
  return Array.isArray(list) ? list.filter((uri): uri is string => typeof uri === 'string') : [];
}

export async function startMcpAuthorization(
  ctx: ServerContext,
  tenant: TenantRow,
  query: Record<string, unknown>,
): Promise<McpAuthorizeOutcome> {
  const { config } = ctx;

  // 1. the client and its redirect URI, before anything may redirect (GHSA-rc3w)
  const clientId = single(query, 'client_id');
  if (!clientId) return errorPage('invalid_request', 'client_id is required');
  const client = await ctx.repos.mcpOAuth.getClient(tenant.id, clientId);
  if (!client) return errorPage('invalid_client', 'The client is not registered with this workspace');
  const requested = single(query, 'redirect_uri');
  if (requested === null) return errorPage('invalid_request', 'redirect_uri must be given once');
  let redirectIndex: number;
  if (requested === undefined) {
    if (client.redirectUris.length !== 1) {
      return errorPage('invalid_request', 'redirect_uri is required for a client with several redirect URIs');
    }
    redirectIndex = 0;
  } else {
    redirectIndex = client.redirectUris.indexOf(requested);
    if (redirectIndex < 0) {
      return errorPage('invalid_request', 'redirect_uri is not registered for this client');
    }
  }
  const redirectUri = client.redirectUris[redirectIndex];
  if (!redirectAllowedByTenant(tenantAllowedRedirectUris(tenant), redirectUri)) {
    return errorPage(
      'invalid_request',
      "redirect_uri is not on this workspace's list of allowed redirect URIs",
    );
  }

  // 2. from here on, errors go back to the client
  const rawState = single(query, 'state');
  const iss = mcpOAuthIssuer(config, tenant.slug);
  const back = (error: string, description: string, state?: string): McpAuthorizeOutcome => ({
    redirect: redirectWith(redirectUri, { error, error_description: description, state, iss }),
  });
  if (rawState === null) return back('invalid_request', 'state must be given once');
  if (rawState !== undefined && rawState.length > MCP_OAUTH_STATE_LIMIT) {
    return back('invalid_request', `state may have at most ${MCP_OAUTH_STATE_LIMIT} characters`);
  }
  const state = rawState;
  if (single(query, 'response_type') !== 'code') {
    return back('unsupported_response_type', 'response_type must be code', state);
  }
  if (!client.grantTypes.includes('authorization_code')) {
    return back('unauthorized_client', 'The client may not use the authorization code grant', state);
  }
  const method = single(query, 'code_challenge_method');
  const challenge = single(query, 'code_challenge');
  if (!challenge) return back('invalid_request', 'PKCE is required: send code_challenge with S256', state);
  if (method !== 'S256') {
    return back('invalid_request', 'code_challenge_method must be S256', state);
  }
  if (!CODE_CHALLENGE.test(challenge)) {
    return back('invalid_request', 'code_challenge is not a valid S256 challenge', state);
  }

  // 3. the resource (RFC 8707): omitted means this tenant's server
  const rawResource = single(query, 'resource');
  if (rawResource === null) return back('invalid_target', 'resource must be given once', state);
  const resource = rawResource ?? mcpServerUrl(config, tenant.slug);
  // the access switch gates only the tenant server; a trigger's sign-in keeps working while it is off
  if (resource === mcpServerUrl(config, tenant.slug) && !mcpAccessEnabled(config, tenant)) {
    return back('invalid_target', 'MCP access is not available for this workspace', state);
  }
  if (!(await isTenantMcpResource(ctx, tenant, resource))) {
    return back('invalid_target', 'The resource is not an MCP server of this workspace', state);
  }

  // 4. scopes: unknown ones are dropped; none asked for means all of them
  const rawScope = single(query, 'scope');
  const asked = typeof rawScope === 'string' ? rawScope.split(' ').filter(isMcpScope) : [];
  const scopes: McpScope[] = asked.length > 0 ? [...new Set(asked)] : [...MCP_SCOPES];

  const flow: McpOAuthFlow = {
    kind: MCP_OAUTH_FLOW_KIND,
    tenantId: tenant.id,
    clientId: client.id,
    redirectIndex,
    codeChallenge: challenge,
    resource,
    scopes,
    ...(state !== undefined ? { state } : {}),
  };
  const token = ctx.formTokens.sign(flow as unknown as DataObject, MCP_OAUTH_FLOW_TTL_S);
  return { redirect: `${config.baseUrl}/oauth/consent?flow=${encodeURIComponent(token)}` };
}

/** the flow of a flow token, or null when it is invalid, expired or of another kind */
export function readMcpOAuthFlow(ctx: ServerContext, token: string): McpOAuthFlow | null {
  if (typeof token !== 'string' || !token) return null;
  const payload = ctx.formTokens.verify(token);
  if (!payload || payload.kind !== MCP_OAUTH_FLOW_KIND) return null;
  const { tenantId, clientId, redirectIndex, codeChallenge, resource, scopes, state } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof clientId !== 'string' ||
    typeof redirectIndex !== 'number' ||
    !Number.isInteger(redirectIndex) ||
    redirectIndex < 0 ||
    typeof codeChallenge !== 'string' ||
    !CODE_CHALLENGE.test(codeChallenge) ||
    typeof resource !== 'string' ||
    !Array.isArray(scopes) ||
    (state !== undefined && typeof state !== 'string')
  ) {
    return null;
  }
  return {
    kind: MCP_OAUTH_FLOW_KIND,
    tenantId,
    clientId,
    redirectIndex,
    codeChallenge,
    resource,
    scopes: scopes.filter(isMcpScope),
    ...(typeof state === 'string' ? { state } : {}),
  };
}
