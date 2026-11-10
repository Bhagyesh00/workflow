/**
 * /rest/auth/sso-options, /rest/sso/method and /rest/members/:userId/sso-settings (P6-01, L6).
 * `sso-options` is public (the sign-in page asks it before anyone signs in) and rate limited; it answers the
 * workspace's method, the button's label and whether the page goes straight to the identity provider
 * (`SSO_REDIRECT_LOGIN_TO_SSO`), and `email` for an unknown slug. Reading the method needs any of
 * `saml:manage`, `oidc:manage`, `ldap:manage`; changing it needs the scope of the method turned on, or of the
 * current method when turning it off (as each protocol's own toggle); a member's manual login flag needs
 * `user:update`.
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { TenantAuthSettingsRow } from '../db/schema';
import { requireAnyScope, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import type { SsoMethod } from '../repositories/sso';
import { isSsoMethod } from '../services/sso/settings';

const MANAGE_SSO: readonly Scope[] = ['saml:manage', 'oidc:manage', 'ldap:manage'];
const MANAGE_SCOPE: Readonly<Record<Exclude<SsoMethod, 'email'>, Scope>> = {
  saml: 'saml:manage',
  oidc: 'oidc:manage',
  ldap: 'ldap:manage',
};
const userParams = z.object({ userId: z.uuid() });
const optionsQuery = z.object({ workspace: z.string().trim().max(64).optional() });
const methodBody = z.object({ method: z.enum(['email', 'saml', 'oidc', 'ldap']) });
const memberSettingsBody = z.object({ allowSsoManualLogin: z.boolean() });

/** what the sign-in page needs before anyone signs in (no config, no secret) */
export interface SsoOptionsDTO {
  method: SsoMethod;
  /** the button's text; null = the page's default */
  label: string | null;
  /** send the sign-in page straight to the identity provider */
  redirect: boolean;
}

function loginLabel(row: TenantAuthSettingsRow): string | null {
  const method = row.method;
  if (method === 'email') return null;
  const label = (row[method] as { loginLabel?: unknown } | null)?.loginLabel;
  return typeof label === 'string' && label.trim() ? label.trim().slice(0, 128) : null;
}

export function registerSsoSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, config } = ctx;

  // public: the sign-in page shows the workspace's SSO button before anyone signs in
  app.get(
    '/auth/sso-options',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
          keyGenerator: (request: FastifyRequest) => `sso-options:${request.ip}`,
        },
      },
    },
    async (request) => {
      const { workspace } = parse(optionsQuery, request.query);
      const tenant = workspace ? await repos.tenants.getBySlug(workspace) : undefined;
      const row = tenant ? await ctx.ssoSettings.get(tenant.id) : undefined;
      // an unknown workspace answers as a workspace that signs in by email
      const method = row?.method ?? 'email';
      const data: SsoOptionsDTO = {
        method,
        label: row ? loginLabel(row) : null,
        redirect: config.ssoRedirectLogin && isSsoMethod(method),
      };
      return { data };
    },
  );

  app.get('/sso/method', async (request) => {
    const auth = await requireAnyScope(request, MANAGE_SSO);
    return { data: { method: await ctx.ssoSettings.activeMethod(auth.tenant.id) } };
  });

  app.put('/sso/method', async (request) => {
    const auth = await requireAnyScope(request, MANAGE_SSO);
    const { method } = parse(methodBody, request.body);
    // the scope of the method this turns on, or of the one it turns off
    const changed = method === 'email' ? await ctx.ssoSettings.activeMethod(auth.tenant.id) : method;
    if (changed !== 'email') await requireScope(request, MANAGE_SCOPE[changed]);
    await ctx.ssoSettings.setMethod(auth, method);
    return { data: { method: await ctx.ssoSettings.activeMethod(auth.tenant.id) } };
  });

  // n8n PATCH /users/:id/settings `allowSSOManualLogin`: this member may still sign in with a password
  app.patch('/members/:userId/sso-settings', async (request) => {
    const auth = await requireScope(request, 'user:update');
    const { userId } = parse(userParams, request.params);
    const { allowSsoManualLogin } = parse(memberSettingsBody, request.body);
    const membership = await repos.memberships.getIncludingDisabled(auth.tenant.id, userId);
    const user = membership ? await repos.users.get(userId) : undefined;
    if (!membership || !user) throw ApiError.notFound('Member');
    await repos.memberships.setAllowSsoManualLogin(auth.tenant.id, userId, allowSsoManualLogin);
    return {
      data: {
        userId,
        email: user.email,
        name: user.name,
        role: membership.role,
        status: membership.disabledAt ? 'disabled' : 'active',
        allowSsoManualLogin,
      },
    };
  });
}
