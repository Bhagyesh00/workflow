/**
 * Password reset, profile and email change (P6-19, L3). The four token routes are public (a person who
 * cannot sign in uses them), rate limited, and take the token in the body, never in the URL; the profile,
 * password and email change routes need a session; the reset link for a member needs `user:resetPassword`.
 * C0 registered each with its final path and gate; the handlers throw until L3 (stub (L3)).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const userParams = z.object({ userId: z.uuid() });

/** public token routes: 20 calls per 5 minutes per IP (L3 adds the per email limit of forgot password) */
const publicLimit = (name: string) => ({
  config: {
    rateLimit: {
      max: 20,
      timeWindow: 300_000,
      keyGenerator: (request: FastifyRequest) => `${name}:${request.ip}`,
    },
  },
});

export function registerPasswordRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  // public: the person cannot sign in; the answer is the same for an unknown email
  app.post('/auth/forgot-password', publicLimit('forgot-password'), async () => {
    throw new Error('not implemented (L3)');
  });

  // public: the reset page checks its token (sent in the body) before it shows the form
  app.post('/auth/reset-token/resolve', publicLimit('reset-token'), async () => {
    throw new Error('not implemented (L3)');
  });

  // public: the token in the body is the proof
  app.post('/auth/reset-password', publicLimit('reset-password'), async () => {
    throw new Error('not implemented (L3)');
  });

  // public: the token from the mail to the new address is the proof
  app.post('/auth/confirm-email-change', publicLimit('confirm-email-change'), async () => {
    throw new Error('not implemented (L3)');
  });

  app.patch('/auth/me', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L3)');
  });

  app.patch('/auth/me/password', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L3)');
  });

  app.post('/auth/change-email', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L3)');
  });

  app.get('/members/:userId/password-reset-link', async (request) => {
    await requireScope(request, 'user:resetPassword');
    parse(userParams, request.params);
    throw new Error('not implemented (L3)');
  });
}
