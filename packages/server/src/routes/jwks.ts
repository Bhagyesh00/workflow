/**
 * GET /.well-known/jwks/:slug.json (P6-16, L15), outside `/rest`: public, because the OAuth provider fetches
 * the workspace's public encryption keys without a session; only public key parts are served, rate limited
 * (60 per IP per minute), cached one hour.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ApiError, parse } from '../http/errors';

const slugParams = z.object({ slug: z.string().min(1).max(64) });

export function registerJwksRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // public: the provider reads the public keys; no secret is served
  app.get(
    '/.well-known/jwks/:slug.json',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60_000,
          keyGenerator: (request: FastifyRequest) => `jwks:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const { slug } = parse(slugParams, request.params);
      const jwks = await ctx.oauthJwe.publicJwks(slug);
      if (!jwks) throw ApiError.notFound('Workspace');
      void reply.header('cache-control', 'public, max-age=3600');
      return jwks;
    },
  );
}
