/**
 * /rest/settings/policies/rate-limits (P6-83, L15), as n8n's public API rate limit settings controller: GET and
 * PUT the workspace's public API limits (four limits and four windows, read and write, global and per endpoint;
 * 0 means no limit), `securitySettings:manage`. Stored in `tenants.settings.publicApiRateLimit`; the platform
 * envs are only defaults.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

const limit = z.number().int().min(0).max(10_000_000);
const windowSeconds = z.number().int().min(1).max(86_400);

/** the fields sent change; the others keep their value */
export const rateLimitPatchSchema = z
  .object({
    enabled: z.boolean(),
    globalReadLimit: limit,
    globalReadWindow: windowSeconds,
    globalWriteLimit: limit,
    globalWriteWindow: windowSeconds,
    endpointReadLimit: limit,
    endpointReadWindow: windowSeconds,
    endpointWriteLimit: limit,
    endpointWriteWindow: windowSeconds,
  })
  .partial()
  .strict();

export function registerRateLimitSettingsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/settings/policies/rate-limits', async (request) => {
    const auth = await requireScope(request, 'securitySettings:manage');
    return { data: await ctx.rateLimitSettings.get(auth.tenant.id) };
  });

  app.put('/settings/policies/rate-limits', async (request) => {
    const auth = await requireScope(request, 'securitySettings:manage');
    const body = parse(rateLimitPatchSchema, request.body ?? {});
    return {
      data: await ctx.rateLimitSettings.update(auth.tenant.id, body, {
        userId: auth.user.id,
        ip: request.ip,
      }),
    };
  });
}
