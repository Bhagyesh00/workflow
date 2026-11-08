/**
 * The consent step of the MCP OAuth server (P5-14), behind the session of `/rest/consent/*`. Details
 * need a membership in the flow's tenant, whatever the session's current tenant (else 403). Approve
 * keeps the intersection of the scopes picked with the flow token's list, stores the consent, makes a
 * code (SHA-256, 10 minutes, single use through `takeCode`) and returns the redirect with `code`,
 * `state` and `iss` (RFC 9207); deny returns it with `access_denied`.
 */
import { randomBytes } from 'node:crypto';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import type { AuthContext } from '../../../http/auth';
import { ApiError } from '../../../http/errors';
import type { OAuthClientRow } from '../../../repositories/mcp-oauth';
import { sha256 } from '../../auth';
import { mcpAccessEnabled } from '../settings';
import { type McpScope, mcpOAuthIssuer, mcpServerUrl } from '../types';
import {
  type McpOAuthFlow,
  readMcpOAuthFlow,
  redirectAllowedByTenant,
  redirectWith,
  tenantAllowedRedirectUris,
} from './authorize';

/** authorization code lifetime, seconds */
export const MCP_OAUTH_CODE_TTL_S = 600;

export const MCP_CONSENT_TEXTS = {
  invalidFlow: 'This sign-in request has expired or is not valid. Start again from your MCP client.',
  notMember: "You aren't a member of the workspace this MCP client asks to access",
  noScopes: 'Pick at least one permission to grant',
} as const;

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

interface LoadedFlow {
  flow: McpOAuthFlow;
  tenant: TenantRow;
  client: OAuthClientRow;
  redirectUri: string;
}

/** the flow, its tenant, client and redirect URI, for a member of the flow's tenant */
async function loadFlow(ctx: ServerContext, auth: AuthContext, token: string): Promise<LoadedFlow> {
  const flow = readMcpOAuthFlow(ctx, token);
  if (!flow) throw ApiError.badRequest(MCP_CONSENT_TEXTS.invalidFlow);
  // the flow's workspace, not the session's current one
  const membership = await ctx.repos.memberships.get(flow.tenantId, auth.user.id);
  if (!membership) throw ApiError.forbidden(MCP_CONSENT_TEXTS.notMember);
  const tenant = await ctx.repos.tenants.get(flow.tenantId);
  if (!tenant) throw ApiError.badRequest(MCP_CONSENT_TEXTS.invalidFlow);
  // the access switch gates only the tenant server's resource, not a trigger's
  if (flow.resource === mcpServerUrl(ctx.config, tenant.slug) && !mcpAccessEnabled(ctx.config, tenant)) {
    throw ApiError.badRequest(MCP_CONSENT_TEXTS.invalidFlow);
  }
  const client = await ctx.repos.mcpOAuth.getClient(flow.tenantId, flow.clientId);
  const redirectUri = client?.redirectUris[flow.redirectIndex];
  // the client went, or its list changed since: no redirect anywhere
  if (!client || !redirectUri || !redirectAllowedByTenant(tenantAllowedRedirectUris(tenant), redirectUri)) {
    throw ApiError.badRequest(MCP_CONSENT_TEXTS.invalidFlow);
  }
  return { flow, tenant, client, redirectUri };
}

/** `GET /rest/consent/details?flow=` */
export async function mcpConsentDetails(
  ctx: ServerContext,
  auth: AuthContext,
  flow: string,
): Promise<McpConsentDetails> {
  const loaded = await loadFlow(ctx, auth, flow);
  return {
    clientName: loaded.client.name,
    tenantName: loaded.tenant.name,
    resource: loaded.flow.resource,
    scopes: loaded.flow.scopes,
    redirectHost: new URL(loaded.redirectUri).host,
  };
}

/** `POST /rest/consent/approve`: where the browser goes next (the client's redirect URI) */
export async function approveMcpConsent(
  ctx: ServerContext,
  auth: AuthContext,
  decision: McpConsentDecision,
): Promise<{ redirectUrl: string }> {
  const { flow, tenant, client, redirectUri } = await loadFlow(ctx, auth, decision.flow);
  const iss = mcpOAuthIssuer(ctx.config, tenant.slug);
  if (!decision.approved) {
    return {
      redirectUrl: redirectWith(redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied access',
        state: flow.state,
        iss,
      }),
    };
  }
  const picked =
    decision.scopes === undefined ? flow.scopes : flow.scopes.filter((s) => decision.scopes?.includes(s));
  if (picked.length === 0) throw ApiError.badRequest(MCP_CONSENT_TEXTS.noScopes);

  const repo = ctx.repos.mcpOAuth;
  await repo.saveConsent({ tenantId: tenant.id, userId: auth.user.id, clientId: client.id, scope: picked });
  const code = randomBytes(32).toString('base64url');
  await repo.saveCode({
    codeHash: sha256(code),
    tenantId: tenant.id,
    clientId: client.id,
    userId: auth.user.id,
    redirectUri,
    codeChallenge: flow.codeChallenge,
    codeChallengeMethod: 'S256',
    state: flow.state ?? null,
    resource: flow.resource,
    scope: picked,
    expiresAt: new Date(Date.now() + MCP_OAUTH_CODE_TTL_S * 1000),
  });
  await ctx.repos.audit.add(tenant.id, {
    userId: auth.user.id,
    action: 'mcp.oauth_consent_granted',
    resourceType: 'oauth_client',
    resourceId: client.id,
    metadata: { scopes: picked, resource: flow.resource },
  });
  return { redirectUrl: redirectWith(redirectUri, { code, state: flow.state, iss }) };
}
