/**
 * /rest/auth/mfa/* and /rest/settings/mfa-enforce (P6-18, L2). Setup, enable, disable and verify need a
 * session (the caller's own account) and, except verify, a password session (`assertGlobalAccountChange`);
 * enforcing MFA for the workspace needs `user:enforceMfa`. The gate that blocks an unverified session of an
 * enforcing workspace is services/mfa-gate.ts, run by `loadSession`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clientIp, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { INVALID_MFA_MESSAGE } from '../services/mfa';
import { isMfaEnforced } from '../services/mfa-gate';

const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'The MFA code must be 6 digits');

const enableSchema = z.object({ mfaCode: codeSchema });
const verifySchema = z.object({ mfaCode: codeSchema });
const disableSchema = z.object({
  mfaCode: codeSchema.optional(),
  mfaRecoveryCode: z.string().trim().min(1).max(64).optional(),
});
const enforceSchema = z.object({ enforce: z.boolean() });

export const MFA_BEFORE_ENFORCE_MESSAGE =
  'You must turn on two-factor sign-in for your own account before requiring it for the workspace';

export function registerMfaRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, mfa } = ctx;

  app.get('/auth/mfa/setup', async (request) => {
    const auth = requireAuth(request);
    ctx.auth.assertGlobalAccountChange(auth);
    return { data: await mfa.setup(auth.user) };
  });

  app.post('/auth/mfa/enable', async (request) => {
    const auth = requireAuth(request);
    ctx.auth.assertGlobalAccountChange(auth);
    if (!auth.sessionId) throw ApiError.unauthorized();
    const { mfaCode } = parse(enableSchema, request.body);
    await mfa.enable(auth.user, mfaCode, auth.sessionId);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'auth.mfa_enabled',
      ip: clientIp(request),
    });
    return { data: { ok: true } };
  });

  app.post('/auth/mfa/disable', async (request) => {
    const auth = requireAuth(request);
    ctx.auth.assertGlobalAccountChange(auth);
    const body = parse(disableSchema, request.body);
    await mfa.disable(auth.user, body);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'auth.mfa_disabled',
      ip: clientIp(request),
    });
    return { data: { ok: true } };
  });

  // a code check for the signed-in user; a good code also marks this session verified (an enrolled user whose
  // session began before the workspace enforced MFA)
  app.post('/auth/mfa/verify', async (request) => {
    const auth = requireAuth(request);
    const { mfaCode } = parse(verifySchema, request.body);
    if (!(await mfa.verify(auth.user, mfaCode))) {
      throw new ApiError(401, 'invalid_mfa', INVALID_MFA_MESSAGE);
    }
    if (auth.sessionId) await repos.sessions.setMfaVerified(auth.sessionId);
    return { data: { ok: true } };
  });

  app.post('/settings/mfa-enforce', async (request) => {
    const auth = await requireScope(request, 'user:enforceMfa');
    const { enforce } = parse(enforceSchema, request.body);
    if (enforce) {
      if (!ctx.config.mfaEnabled) {
        throw ApiError.badRequest('Two-factor sign-in is turned off on this server');
      }
      if (!(await mfa.isEnabled(auth.user.id))) throw ApiError.badRequest(MFA_BEFORE_ENFORCE_MESSAGE);
    }
    const tenant = await repos.tenants.get(auth.tenant.id);
    if (!tenant) throw ApiError.notFound('Workspace');
    if (isMfaEnforced(tenant) !== enforce) {
      const settings = (tenant.settings ?? {}) as Record<string, unknown>;
      const current = (settings.mfa ?? {}) as Record<string, unknown>;
      await repos.tenants.updateSettings(tenant.id, { ...settings, mfa: { ...current, enforced: enforce } });
    }
    return { data: { enforced: enforce } };
  });
}
