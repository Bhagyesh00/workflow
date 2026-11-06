/**
 * Request authentication and authorization helpers.
 * - `/rest`: session cookie (`wf_session`), sliding 14-day expiry, CSRF checks.
 * - `/api/v1`: `X-API-KEY`.
 */
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Role, TenantRow, UserRow } from '../db/schema';
import type { Repositories } from '../repositories';
import {
  type AuthService,
  hasRole,
  SESSION_COOKIE,
  SESSION_REFRESH_MS,
  SESSION_TTL_MS,
  sha256,
} from '../services/auth';
import { ApiError } from './errors';

export interface AuthContext {
  user: UserRow;
  tenant: TenantRow;
  role: Role;
  sessionId?: string;
  apiKeyId?: string;
  /** the key's scopes; empty = every route the role allows (checked by assertApiKeyScope) */
  apiKeyScopes?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
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

export function requireRole(request: FastifyRequest, minimum: Role): AuthContext {
  const auth = requireAuth(request);
  if (!hasRole(auth.role, minimum)) throw ApiError.forbidden();
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
