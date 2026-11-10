/**
 * /rest/auth/mfa/* and /rest/settings/mfa-enforce (P6-18, L2). Setup, enable, disable and verify need a
 * session (the caller's own account); enforcing MFA for the workspace needs `user:enforceMfa`.
 * C0 registered each with its final path and gate; the handlers throw until L2 (stub (L2)).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';

export function registerMfaRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/auth/mfa/setup', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L2)');
  });

  app.post('/auth/mfa/enable', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L2)');
  });

  app.post('/auth/mfa/disable', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L2)');
  });

  app.post('/auth/mfa/verify', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L2)');
  });

  app.post('/settings/mfa-enforce', async (request) => {
    await requireScope(request, 'user:enforceMfa');
    throw new Error('not implemented (L2)');
  });
}
