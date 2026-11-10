/**
 * /rest/settings/policies/rate-limits (P6-83, L15), as n8n's public API rate limit settings controller: GET and
 * PUT the workspace's public API limits (four limits and four windows, read and write, global and per endpoint;
 * 0 means no limit), `securitySettings:manage`. Stored in `tenants.settings.publicApiRateLimit`; the platform
 * envs are only defaults. Paths and scope gates are final; each handler is a stub until L15 fills it.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

export function registerRateLimitSettingsRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/settings/policies/rate-limits', async (request) => {
    await requireScope(request, 'securitySettings:manage');
    // stub (L15)
    throw new Error('not implemented (L15)');
  });

  app.put('/settings/policies/rate-limits', async (request) => {
    await requireScope(request, 'securitySettings:manage');
    // stub (L15)
    throw new Error('not implemented (L15)');
  });
}
