/**
 * Tokens of the MCP OAuth server (P5-14): opaque, stored as SHA-256 only. Access `wfo_at_` (1 h) and
 * refresh `wfo_rt_` (30 days, rotated; an old one replayed gets `invalid_grant`), bound to the granted
 * `resource` (GHSA-cw9w). `verifyMcpOAuthToken` reads the membership on every call, so a removed user
 * loses access, and the role always comes from the membership, never the token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FormUser, McpAuthHelper } from '@workflow/workflow';
import type { ServerContext } from '../../../context';
import type { TenantRow } from '../../../db/schema';
import type { OAuthAccessTokenInsert, OAuthRefreshTokenInsert } from '../../../repositories/mcp-oauth';
import { sha256 } from '../../auth';
import { mcpAccessEnabled } from '../settings';
import { isMcpScope, type McpScope, mcpResourceMetadataUrl, mcpServerUrl } from '../types';
import { authenticateMcpOAuthClient } from './clients';
import { parseMcpTriggerResource } from './metadata';

export const MCP_OAUTH_ACCESS_PREFIX = 'wfo_at_';
export const MCP_OAUTH_REFRESH_PREFIX = 'wfo_rt_';

/** access token lifetime, seconds */
export const MCP_OAUTH_ACCESS_TTL_S = 3600;
/** refresh token lifetime, seconds */
export const MCP_OAUTH_REFRESH_TTL_S = 30 * 86_400;

/** the longest token value read; anything longer is refused unread */
const MAX_TOKEN_LENGTH = 512;

/** RFC 7636 4.1: 43 to 128 unreserved characters */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

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
  ctx: ServerContext,
  tenantId: string,
  token: string,
  resource: string,
): Promise<McpOAuthTokenInfo | null> {
  if (!isMcpOAuthToken(token) || token.length > MAX_TOKEN_LENGTH) return null;
  const row = await ctx.repos.mcpOAuth.getAccessToken(tenantId, sha256(token));
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  if (row.resource !== resource) return null;
  // read on every call: a user removed from the workspace loses access at once
  const membership = await ctx.repos.memberships.get(tenantId, row.userId);
  if (!membership) return null;
  return { userId: row.userId, scopes: row.scope.filter(isMcpScope), clientId: row.clientId };
}

/** the reply of the token endpoint (RFC 6749 section 5): a token pair, or `{ error, error_description? }` */
export interface McpOAuthTokenReply {
  statusCode: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function oauthError(error: string, description: string, statusCode = 400, basic = false): McpOAuthTokenReply {
  return {
    statusCode,
    headers: { ...NO_STORE, ...(basic ? { 'www-authenticate': 'Basic realm="MCP OAuth"' } : {}) },
    body: { error, error_description: description },
  };
}

const invalidClient = (authorization: string | undefined) =>
  oauthError(
    'invalid_client',
    'Client authentication failed',
    401,
    typeof authorization === 'string' && /^Basic\s/i.test(authorization),
  );

/** base64url(SHA-256(verifier)) equals the stored challenge, in constant time */
function pkceMatches(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

const newToken = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

/** a new access and refresh token pair for a grant, and the rows that store their hashes */
function tokenPair(grant: {
  tenantId: string;
  clientId: string;
  userId: string;
  resource: string;
  scope: string[];
}) {
  const access = newToken(MCP_OAUTH_ACCESS_PREFIX);
  const refresh = newToken(MCP_OAUTH_REFRESH_PREFIX);
  const nowMs = Date.now();
  const accessRow: OAuthAccessTokenInsert = {
    ...grant,
    tokenHash: sha256(access),
    expiresAt: new Date(nowMs + MCP_OAUTH_ACCESS_TTL_S * 1000),
  };
  const refreshRow: OAuthRefreshTokenInsert = {
    ...grant,
    tokenHash: sha256(refresh),
    expiresAt: new Date(nowMs + MCP_OAUTH_REFRESH_TTL_S * 1000),
  };
  const reply: McpOAuthTokenReply = {
    statusCode: 200,
    headers: { ...NO_STORE },
    body: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: MCP_OAUTH_ACCESS_TTL_S,
      refresh_token: refresh,
      scope: grant.scope.join(' '),
    },
  };
  return { accessRow, refreshRow, reply };
}

/**
 * `POST /mcp-oauth/:tenantSlug/token`: `authorization_code` (client authenticated first, the code's
 * client and `redirect_uri` equal to the request's, PKCE S256, `resource` equal to the code's) and
 * `refresh_token` (rotation, bound to the granted resource).
 */
export async function exchangeMcpOAuthToken(
  ctx: ServerContext,
  tenant: TenantRow,
  body: Record<string, string>,
  authorization: string | undefined,
): Promise<McpOAuthTokenReply> {
  const grantType = body.grant_type;
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
    return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }
  const client = await authenticateMcpOAuthClient(ctx, tenant.id, body, authorization);
  if (!client) return invalidClient(authorization);
  if (!client.grantTypes.includes(grantType)) {
    return oauthError('unauthorized_client', `The client may not use the ${grantType} grant`);
  }
  const repo = ctx.repos.mcpOAuth;

  if (grantType === 'authorization_code') {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = body;
    if (!code || !redirectUri || !verifier) {
      return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required');
    }
    // single use: taken (and so spent) before any other check
    const row = await repo.takeCode(tenant.id, sha256(code));
    if (!row) return oauthError('invalid_grant', 'The authorization code is not valid');
    if (row.clientId !== client.id) return oauthError('invalid_grant', 'The authorization code is not valid');
    if (row.redirectUri !== redirectUri) {
      return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (row.codeChallengeMethod !== 'S256' || !pkceMatches(verifier, row.codeChallenge)) {
      return oauthError('invalid_grant', 'The code verifier does not match the code challenge');
    }
    if (body.resource !== undefined && body.resource !== row.resource) {
      return oauthError('invalid_target', 'resource does not match the authorization request');
    }
    if (!(await ctx.repos.memberships.get(tenant.id, row.userId))) {
      return oauthError('invalid_grant', 'The authorization code is not valid');
    }
    const pair = tokenPair({
      tenantId: tenant.id,
      clientId: client.id,
      userId: row.userId,
      resource: row.resource,
      scope: row.scope,
    });
    await repo.saveTokens(pair.accessRow, pair.refreshRow);
    return pair.reply;
  }

  const refreshToken = body.refresh_token;
  if (!refreshToken) return oauthError('invalid_request', 'refresh_token is required');
  const oldHash = sha256(refreshToken);
  const row =
    refreshToken.startsWith(MCP_OAUTH_REFRESH_PREFIX) && refreshToken.length <= MAX_TOKEN_LENGTH
      ? await repo.getRefreshToken(tenant.id, oldHash)
      : undefined;
  if (!row || row.expiresAt.getTime() <= Date.now() || row.clientId !== client.id) {
    return oauthError('invalid_grant', 'The refresh token is not valid');
  }
  // GHSA-cw9w: a refresh token never yields a token for another resource
  if (body.resource !== undefined && body.resource !== row.resource) {
    return oauthError('invalid_target', 'resource does not match the granted resource');
  }
  let scope = row.scope;
  if (body.scope !== undefined) {
    const asked = [...new Set(body.scope.split(' ').filter(Boolean))];
    if (asked.length === 0 || !asked.every((s) => row.scope.includes(s))) {
      return oauthError('invalid_scope', 'scope may only narrow the granted scopes');
    }
    scope = asked;
  }
  if (!(await ctx.repos.memberships.get(tenant.id, row.userId))) {
    return oauthError('invalid_grant', 'The refresh token is not valid');
  }
  const pair = tokenPair({
    tenantId: tenant.id,
    clientId: client.id,
    userId: row.userId,
    resource: row.resource,
    scope,
  });
  if (!(await repo.rotateRefreshToken(tenant.id, oldHash, pair.accessRow, pair.refreshRow))) {
    return oauthError('invalid_grant', 'The refresh token is not valid');
  }
  return pair.reply;
}

/** `POST /mcp-oauth/:tenantSlug/revoke` (RFC 7009): immediate; an unknown token is still 200 */
export async function revokeMcpOAuthToken(
  ctx: ServerContext,
  tenant: TenantRow,
  body: Record<string, string>,
  authorization: string | undefined,
): Promise<McpOAuthTokenReply> {
  const client = await authenticateMcpOAuthClient(ctx, tenant.id, body, authorization);
  if (!client) return invalidClient(authorization);
  const token = body.token;
  if (!token) return oauthError('invalid_request', 'token is required');
  const ok: McpOAuthTokenReply = { statusCode: 200, headers: { ...NO_STORE }, body: {} };
  if (token.length > MAX_TOKEN_LENGTH) return ok;
  const hash = sha256(token);
  const repo = ctx.repos.mcpOAuth;
  // only the client the token was issued to may revoke it; another client's token reads as unknown
  const row = (await repo.getAccessToken(tenant.id, hash)) ?? (await repo.getRefreshToken(tenant.id, hash));
  if (row && row.clientId === client.id) await repo.revokeToken(tenant.id, hash);
  return ok;
}

/**
 * The resource of a trigger request rebuilt on the configured MCP base URL: the trigger sees
 * `<scheme>://<Host><path>` of the request (Host already checked), which behind a proxy may differ in
 * scheme or lack the base URL's path prefix. From the endpoint segment on, the path is the same.
 */
export function canonicalMcpResource(ctx: ServerContext, resource: string): string {
  const { config } = ctx;
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return resource;
  }
  const segments = url.pathname.split('/');
  const at = segments.findIndex(
    (segment, i) => i > 0 && (segment === config.mcp.endpoint || segment === config.mcp.endpointTest),
  );
  if (at < 0) return resource;
  return `${config.mcp.baseUrl}/${segments.slice(at).join('/')}`;
}

/** the tenant slug a resource URL names (a trigger URL or the tenant server's URL) */
function slugOfResource(ctx: ServerContext, resource: string): string | undefined {
  const trigger = parseMcpTriggerResource(ctx.config, resource);
  if (trigger) return trigger.slug;
  const prefix = `${ctx.config.mcp.baseUrl}/mcp-server/`;
  if (!resource.startsWith(prefix)) return undefined;
  const [slug, rest, ...more] = resource.slice(prefix.length).split('/');
  if (rest !== 'http' || more.length > 0) return undefined;
  try {
    const decoded = decodeURIComponent(slug);
    return resource === mcpServerUrl(ctx.config, decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function formUserOf(user: { id: string; email: string; name: string }): FormUser {
  const [firstName = '', ...rest] = user.name.trim().split(/\s+/);
  return { id: user.id, email: user.email, firstName, lastName: rest.join(' ') };
}

/**
 * The trigger's sign-in helper (`ExecutionServices.mcpAuth`, `WebhookContext.getMcpAuth`). The tenant
 * comes from the `resource` URL's slug. Takes the context or a getter of it, so it can be built before
 * the context is ready.
 */
export function createMcpAuthHelper(ctxOrGetter: ServerContext | (() => ServerContext)): McpAuthHelper {
  const context = typeof ctxOrGetter === 'function' ? ctxOrGetter : () => ctxOrGetter;
  return {
    async verifyAccessToken(token: string, resource: string) {
      const ctx = context();
      if (!isMcpOAuthToken(token)) return null;
      const canonical = canonicalMcpResource(ctx, resource);
      const slug = slugOfResource(ctx, canonical);
      if (!slug) return null;
      const tenant = await ctx.repos.tenants.getBySlug(slug);
      if (!tenant || !mcpAccessEnabled(ctx.config, tenant)) return null;
      const info = await verifyMcpOAuthToken(ctx, tenant.id, token, canonical);
      if (!info) return null;
      const [user, membership] = await Promise.all([
        ctx.repos.users.get(info.userId),
        ctx.repos.memberships.get(tenant.id, info.userId),
      ]);
      if (!user || !membership) return null;
      return { user: formUserOf(user), role: membership.role };
    },
    // editor or above in the workflow's workspace: the rule of form user auth (services/form-auth.ts)
    canExecute: (userId: string, workflowId: string) => context().formAuth.canExecute(userId, workflowId),
    challenge: (resource: string) =>
      `Bearer realm="MCP Server", resource_metadata="${mcpResourceMetadataUrl(canonicalMcpResource(context(), resource))}"`,
  };
}
