/**
 * OIDC routes (P6-10, L8). Public, under `/sso` (routes/sso-public.ts `ssoPlugin`, outside the `/rest`
 * session and CSRF hook): the browser starts a sign-in and the provider sends it back before any session
 * exists; the signed state and nonce cookies are the proof: GET `/sso/oidc/:slug/login`,
 * `/sso/oidc/:slug/callback`. Under `/rest`: GET and POST `/sso/oidc/config`, POST `/sso/oidc/config/test`
 * (`oidc:manage`), POST `/sso/oidc/logout` (session).
 * C0 registered each with its final path and gate; the handlers throw until L8 (stub (L8)).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const slugParams = z.object({ slug: z.string().min(1).max(64) });

/** under the `/sso` prefix of `ssoPlugin`; no session: the signed state cookie is the proof */
export function registerOidcPublicRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/oidc/:slug/login', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L8)');
  });

  app.get('/oidc/:slug/callback', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L8)');
  });
}

/** under `/rest`: the workspace's OIDC config and the sign out */
export function registerOidcRestRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/sso/oidc/config', async (request) => {
    await requireScope(request, 'oidc:manage');
    throw new Error('not implemented (L8)');
  });

  app.post('/sso/oidc/config', async (request) => {
    await requireScope(request, 'oidc:manage');
    throw new Error('not implemented (L8)');
  });

  app.post('/sso/oidc/config/test', async (request) => {
    await requireScope(request, 'oidc:manage');
    throw new Error('not implemented (L8)');
  });

  app.post('/sso/oidc/logout', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L8)');
  });
}
