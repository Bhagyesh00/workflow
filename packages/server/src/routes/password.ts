/**
 * Password reset, profile and email change (P6-19, L3). The four token routes are public (a person who
 * cannot sign in uses them), rate limited, and take the token in the body, never in the URL; the profile,
 * password and email change routes need a session; the reset link for a member needs `user:resetPassword`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clientIp, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { userDTO } from '../services/auth';

const userParams = z.object({ userId: z.uuid() });

const tokenSchema = z.object({ token: z.string().min(1).max(512) });
const forgotSchema = z.object({ email: z.string().trim().min(1).max(254) });
const resetSchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(256),
  mfaCode: z.string().trim().min(1).max(64).optional(),
});
const profileSchema = z.object({ name: z.string().trim().min(1).max(128) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
  mfaCode: z.string().trim().min(1).max(64).optional(),
});
const changeEmailSchema = z.object({
  email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
  currentPassword: z.string().min(1).max(256).optional(),
  mfaCode: z.string().trim().min(1).max(64).optional(),
});

/** public token routes: 20 calls per 5 minutes per IP (forgot password adds 3 per minute per email) */
const publicLimit = (name: string) => ({
  config: {
    rateLimit: {
      max: 20,
      timeWindow: 300_000,
      keyGenerator: (request: FastifyRequest) => `${name}:${request.ip}`,
    },
  },
});

/** signed-in routes that check a password or code: 10 calls per minute per user (per IP for a session-less call) */
const accountLimit = (name: string) => ({
  config: {
    rateLimit: {
      max: 10,
      timeWindow: 60_000,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => `${name}:${request.auth?.user.id ?? request.ip}`,
    },
  },
});

const meta = (request: FastifyRequest) => ({
  ip: clientIp(request),
  userAgent: request.headers['user-agent'],
});

export function registerPasswordRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { passwords } = ctx;
  const perEmail = app.createRateLimit({
    max: 3,
    timeWindow: 60_000,
    keyGenerator: (request: FastifyRequest) => {
      const email = String((request.body as { email?: unknown } | undefined)?.email ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 254);
      return `forgot-password-email:${email}`;
    },
  });

  /** a session of a person (an API key has no password to check) */
  const sessionAuth = (request: FastifyRequest) => {
    const auth = requireAuth(request);
    if (auth.apiKeyId) throw ApiError.forbidden();
    return auth;
  };

  // public: the person cannot sign in; the answer is the same for an unknown email
  app.post('/auth/forgot-password', publicLimit('forgot-password'), async (request, reply) => {
    const { email } = parse(forgotSchema, request.body);
    const limit = await perEmail(request);
    if (!limit.isAllowed && limit.isExceeded) throw ApiError.tooMany('Too many requests, please try again later');
    const deliver = await passwords.forgotPassword(email, meta(request));
    // the mail goes after the reply, so the answer's timing does not tell a real address from an unknown one
    reply.raw.once('finish', () => void deliver());
    return { data: { ok: true } };
  });

  // public: the reset page checks its token (sent in the body) before it shows the form
  app.post('/auth/reset-token/resolve', publicLimit('reset-token'), async (request) => {
    const { token } = parse(tokenSchema, request.body);
    return { data: await passwords.resolveResetToken(token) };
  });

  // public: the token in the body is the proof
  app.post('/auth/reset-password', publicLimit('reset-password'), async (request) => {
    await passwords.resetPassword(parse(resetSchema, request.body), meta(request));
    return { data: { ok: true } };
  });

  // public: the token from the mail to the new address is the proof
  app.post('/auth/confirm-email-change', publicLimit('confirm-email-change'), async (request) => {
    const { token } = parse(tokenSchema, request.body);
    await passwords.confirmEmailChange(token, meta(request));
    return { data: { ok: true } };
  });

  app.patch('/auth/me', async (request) => {
    const auth = sessionAuth(request);
    const user = await passwords.updateProfile(auth, parse(profileSchema, request.body));
    return { data: userDTO(user) };
  });

  app.patch('/auth/me/password', accountLimit('change-password'), async (request) => {
    const auth = sessionAuth(request);
    await passwords.changePassword(auth, parse(changePasswordSchema, request.body), meta(request));
    return { data: { ok: true } };
  });

  app.post('/auth/change-email', accountLimit('change-email'), async (request) => {
    const auth = sessionAuth(request);
    await passwords.requestEmailChange(auth, parse(changeEmailSchema, request.body));
    return { data: { ok: true } };
  });

  app.get('/members/:userId/password-reset-link', async (request) => {
    const auth = await requireScope(request, 'user:resetPassword');
    const { userId } = parse(userParams, request.params);
    return { data: await passwords.resetLink(auth, userId) };
  });
}
