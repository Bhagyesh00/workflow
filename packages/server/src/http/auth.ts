/**
 * Request authentication and authorization helpers.
 * - `/rest`: session cookie (`wf_session`), sliding 14-day expiry, CSRF checks.
 * - `/api/v1`: `X-API-KEY`.
 */
import type {} from '@fastify/cookie';
import type { Scope } from '@workflow/workflow';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Role, TenantRow, UserRow } from '../db/schema';
import type { Repositories } from '../repositories';
import { type AccessService, type AccessTarget, MISSING_SCOPE_MESSAGE } from '../services/access';
import {
  type AuthService,
  SESSION_COOKIE,
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
  sha256,
} from '../services/auth';
import { ApiError } from './errors';

export interface AuthContext {
  user: UserRow;
  tenant: TenantRow;
  /** the workspace role: a system slug (owner, admin, member) or a custom global role slug */
  role: Role;
  sessionId?: string;
  apiKeyId?: string;
  /** the key's scopes; empty = every route the role allows (checked by assertApiKeyScope) */
  apiKeyScopes?: string[];
  /**
   * P6-03: the caller's scopes per target (`accessTargetKey`), filled by `AccessService.scopesForAuth`.
   * It lives on this request only and is never shared or stored.
   */
  scopeCache?: Map<string, ReadonlySet<Scope>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    /** P6-03: the scope checks (`ctx.access`), decorated in buildApp; `requireScope` reads it */
    access: AccessService;
  }
}

/**
 * The cookie is scoped to `/rest`: browsers never send it to webhook URLs, which serve
 * tenant-controlled content on the same origin.
 */
export const SESSION_COOKIE_PATH = '/rest';

export function setSessionCookie(reply: FastifyReply, config: Config, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: SESSION_COOKIE_PATH,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: SESSION_COOKIE_PATH,
  });
}

/** Resolve the session cookie (if any) into `request.auth`; extends the session when due. */
export async function loadSession(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
  repos: Repositories,
): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token || token.length > 128) return;
  const sessionId = sha256(token);
  const session = await repos.sessions.get(sessionId);
  if (!session) return;
  const [user, tenant, membership] = await Promise.all([
    repos.users.get(session.userId),
    repos.tenants.get(session.tenantId),
    repos.memberships.get(session.tenantId, session.userId),
  ]);
  if (!user || !tenant || !membership) return;
  request.auth = { user, tenant, role: membership.role, sessionId };
  if (session.expiresAt.getTime() - Date.now() < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    await repos.sessions.extend(sessionId, new Date(Date.now() + SESSION_TTL_MS));
    setSessionCookie(reply, config, token);
  }
}

/** The workspace an editor tab was rendered for; the session's tenant is shared by every tab. */
export const TENANT_HEADER = 'x-tenant-id';

/**
 * A tab still showing workspace A must not act on B after the session was switched in another
 * tab. Auth calls (`/rest/auth/*`) are exempt: they read or change the session itself. The push
 * stream names the workspace in `?tenantId=`, because EventSource cannot set headers.
 */
export function checkTenant(request: FastifyRequest): void {
  if (!request.auth || request.url.startsWith('/rest/auth/')) return;
  const fromUrl =
    request.url.split('?')[0] === '/rest/push'
      ? (request.query as { tenantId?: string | string[] } | undefined)?.tenantId
      : undefined;
  const raw = request.headers[TENANT_HEADER] ?? fromUrl;
  const expected = Array.isArray(raw) ? raw[0] : raw;
  if (expected && expected !== request.auth.tenant.id) {
    throw new ApiError(409, 'tenant_changed', 'The workspace was switched in another tab');
  }
}

export async function loadApiKey(request: FastifyRequest, auth: AuthService): Promise<void> {
  const raw = request.headers['x-api-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) throw ApiError.unauthorized('An API key is required (X-API-KEY header)');
  const result = await auth.authenticateApiKey(key);
  if (!result) throw ApiError.unauthorized('The API key is invalid');
  request.auth = result;
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw ApiError.unauthorized();
  return request.auth;
}

/**
 * P6-03: the scope gate. 401 without a session; with a target, the target is looked up first (another
 * workspace's id or a non-uuid id is the service's 404); 403 with n8n's text when the caller's scopes on
 * the target (or the global scopes, with no target) hold none of `scope`. An array passes when any one
 * is held (n8n's `anyOf`, e.g. `role:manage` or `role:manageProject`). The scopes are cached on the
 * request (`auth.scopeCache`). API key scopes stay checked by `assertApiKeyScope` on the public routes.
 */
export async function requireScope(
  request: FastifyRequest,
  scope: Scope | readonly Scope[],
  target?: AccessTarget,
): Promise<AuthContext> {
  const auth = requireAuth(request);
  const access = request.server?.access;
  // fail closed: an app built without the decorator refuses rather than allows
  if (!access) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
  const held = await access.scopesForAuth(auth, target);
  const wanted: readonly Scope[] = typeof scope === 'string' ? [scope] : scope;
  if (!wanted.some((s) => held.has(s))) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
  return auth;
}

/** P6-03: the workspace owner only (`DELETE /tenant`; n8n has no tenants, so no scope names it) */
export function requireOwner(request: FastifyRequest): AuthContext {
  const auth = requireAuth(request);
  if (auth.role !== 'owner') throw ApiError.forbidden();
  return auth;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF protection for cookie-authenticated requests: mutating requests must come from an
 * allowed origin and carry JSON (a body-less request may omit the content type).
 */
export function checkCsrf(request: FastifyRequest, config: Config): void {
  if (!MUTATING.has(request.method)) return;
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new ApiError(403, 'csrf_origin', 'The request origin is not allowed');
  }
  const contentType = request.headers['content-type'];
  if (contentType) {
    if (!/^application\/json\s*(;|$)/i.test(contentType)) {
      throw new ApiError(415, 'unsupported_media_type', 'Requests must use content-type application/json');
    }
  } else {
    const length = Number(request.headers['content-length'] ?? 0);
    if (length > 0 || request.headers['transfer-encoding']) {
      throw new ApiError(415, 'unsupported_media_type', 'Requests must use content-type application/json');
    }
  }
}

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}
