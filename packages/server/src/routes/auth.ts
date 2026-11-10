/** /rest/auth/* and invitation acceptance */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { clearSessionCookie, requireAuth, setSessionCookie } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { type AuthResult, tenantDTO, userDTO } from '../services/auth';
import { OIDC_ID_TOKEN_COOKIE } from '../services/sso/oidc';

const signupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(128),
  workspaceName: z.string().trim().min(1).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(256),
  /** P6-01: the workspace slug of the sign-in page */
  workspace: z.string().trim().min(1).max(64).optional(),
  /** P6-18: the second step; a missing code answers 401 `mfa_required` when MFA is on */
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'The MFA code must be 6 digits')
    .optional(),
  mfaRecoveryCode: z.string().trim().min(1).max(64).optional(),
});

const acceptSchema = z.object({
  name: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(256),
  /** P6-18: an existing account with MFA on sends its code */
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'The MFA code must be 6 digits')
    .optional(),
  mfaRecoveryCode: z.string().trim().min(1).max(64).optional(),
});

const meta = (request: FastifyRequest) => ({ ip: request.ip, userAgent: request.headers['user-agent'] });

export function authResponse(result: Pick<AuthResult, 'user' | 'tenant' | 'role'>) {
  return { data: { user: userDTO(result.user), tenant: tenantDTO(result.tenant), role: result.role } };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { config, auth, repos, access } = ctx;

  app.post(
    '/auth/signup',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 3_600_000,
          keyGenerator: (request: FastifyRequest) => `signup:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const body = parse(signupSchema, request.body);
      const result = await auth.signup(body, meta(request));
      setSessionCookie(reply, config, result.token);
      return authResponse(result);
    },
  );

  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: config.loginRateLimit.max,
          timeWindow: config.loginRateLimit.windowMs,
          hook: 'preHandler',
          keyGenerator: (request: FastifyRequest) => {
            const email = String((request.body as { email?: unknown } | undefined)?.email ?? '')
              .trim()
              .toLowerCase()
              .slice(0, 254);
            return `login:${request.ip}:${email}`;
          },
        },
      },
    },
    async (request, reply) => {
      const body = parse(loginSchema, request.body);
      const result = await auth.login(body, meta(request));
      setSessionCookie(reply, config, result.token);
      return authResponse(result);
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const current = request.auth;
    if (current?.sessionId)
      await auth.logout(current.sessionId, current.tenant.id, current.user.id, request.ip);
    clearSessionCookie(reply, config);
    // an OIDC id token kept for the identity provider's logout goes too
    reply.clearCookie(OIDC_ID_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/rest',
    });
    return { data: { ok: true } };
  });

  /** P6-03: the scopes of the workspace role (sorted), which the editor's `can()` reads */
  const globalScopes = async (tenantId: string, role: Role): Promise<Scope[]> =>
    [...(await access.globalScopes(tenantId, role))].sort();

  app.get('/auth/me', async (request) => {
    const current = requireAuth(request);
    const [tenants, mfaEnabled] = await Promise.all([
      repos.memberships.listForUser(current.user.id),
      repos.userMfa.isEnabled(current.user.id),
    ]);
    const authMethod = current.authMethod ?? 'password';
    return {
      data: {
        ...authResponse(current).data,
        tenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, role: t.role })),
        globalScopes: await globalScopes(current.tenant.id, current.role),
        /** P6-01: how this session signed in */
        authMethod,
        /** P6-18 */
        mfaEnabled,
        /** P6-01: account-wide changes are refused (`assertGlobalAccountChange`) */
        ssoFenced: authMethod !== 'password',
      },
    };
  });

  app.post('/auth/switch-tenant', async (request) => {
    const current = requireAuth(request);
    const { tenantId } = parse(z.object({ tenantId: z.uuid() }), request.body);
    if (!current.sessionId) throw ApiError.unauthorized();
    const { tenant, role } = await auth.switchTenant(current, tenantId);
    const response = authResponse({ user: current.user, tenant, role });
    return { data: { ...response.data, globalScopes: await globalScopes(tenant.id, role) } };
  });

  app.post('/invitations/:token/accept', { logLevel: 'warn' }, async (request, reply) => {
    const { token } = parse(z.object({ token: z.string().min(16).max(128) }), request.params);
    const body = parse(acceptSchema, request.body);
    const result = await auth.acceptInvitation(token, body, meta(request));
    setSessionCookie(reply, config, result.token);
    return authResponse(result);
  });
}
