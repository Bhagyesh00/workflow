/**
 * /rest/ai (P5-09, L1): POST `/ai/build` (editor; NDJSON stream `application/x-ndjson` through
 * `reply.hijack()` as routes/push.ts, one `BuilderChunk` per line, aborted on client close and at
 * `AI_TIMEOUT_MAX`) and POST `/ai/usage-settings` (admin; writes `allowSendingParameterValues`).
 * Gates and rate limit are final from C0: `AI_ENABLED` false gives 404, then the role; 100 per IP.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, requireRole } from '../http/auth';
import { ApiError } from '../http/errors';
import { AI_ROUTE_RATE_LIMIT } from '../services/ai-builder/types';

/** the gate of every `/rest/ai/*` route: 404 while `AI_ENABLED` is false, then `requireRole` */
export function requireAiBuilder(request: FastifyRequest, ctx: ServerContext, minimum: Role): AuthContext {
  if (!ctx.config.ai.enabled) throw ApiError.notFound();
  return requireRole(request, minimum);
}

/** route options of every `/rest/ai/*` route (rate limit 100 per IP, as n8n's `ipRateLimit`) */
export function aiRouteOptions(name: string) {
  return {
    config: {
      rateLimit: {
        max: AI_ROUTE_RATE_LIMIT.max,
        timeWindow: AI_ROUTE_RATE_LIMIT.timeWindow,
        keyGenerator: (request: FastifyRequest) => `ai:${name}:${request.ip}`,
      },
    },
  };
}

export function registerAiRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.post('/ai/build', aiRouteOptions('build'), async (request) => {
    requireAiBuilder(request, ctx, 'editor');
    throw new Error('not implemented (L1)');
  });

  rest.post('/ai/usage-settings', aiRouteOptions('usage-settings'), async (request) => {
    requireAiBuilder(request, ctx, 'admin');
    throw new Error('not implemented (L1)');
  });
}
