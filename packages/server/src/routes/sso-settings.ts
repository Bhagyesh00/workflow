/**
 * /rest/auth/sso-options, /rest/sso/method and /rest/members/:userId/sso-settings (P6-01, L6).
 * `sso-options` is public (the sign-in page asks it before anyone signs in) and rate limited; the method
 * needs any of `saml:manage`, `oidc:manage`, `ldap:manage`; a member's manual login flag needs `user:update`.
 * C0 registered each with its final path and gate; the handlers throw until L6 (stub (L6)).
 */
import type { Scope } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAnyScope, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const MANAGE_SSO: readonly Scope[] = ['saml:manage', 'oidc:manage', 'ldap:manage'];
const userParams = z.object({ userId: z.uuid() });

export function registerSsoSettingsRoutes(app: FastifyInstance, _ctx: ServerContext): void {
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
    async () => {
      throw new Error('not implemented (L6)');
    },
  );

  app.get('/sso/method', async (request) => {
    await requireAnyScope(request, MANAGE_SSO);
    throw new Error('not implemented (L6)');
  });

  app.put('/sso/method', async (request) => {
    await requireAnyScope(request, MANAGE_SSO);
    throw new Error('not implemented (L6)');
  });

  app.patch('/members/:userId/sso-settings', async (request) => {
    await requireScope(request, 'user:update');
    parse(userParams, request.params);
    throw new Error('not implemented (L6)');
  });
}
