/**
 * SAML routes (P6-09, L7). Public, under `/sso` (routes/sso-public.ts `ssoPlugin`, outside the `/rest`
 * session and CSRF hook): the identity provider and the browser reach them before any session exists, and
 * the signed SAML message is the proof: GET `/sso/saml/:slug/metadata`, GET and POST `/sso/saml/:slug/acs`,
 * GET `/sso/saml/:slug/initsso`. Under `/rest`, `saml:manage`: GET and POST `/sso/saml/config`, POST
 * `/sso/saml/config/toggle`, `/sso/saml/config/test`.
 * C0 registered each with its final path and gate; the handlers throw until L7 (stub (L7)).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';

const slugParams = z.object({ slug: z.string().min(1).max(64) });

/** under the `/sso` prefix of `ssoPlugin`; no session: the IdP's signed message is the proof */
export function registerSamlPublicRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/saml/:slug/metadata', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L7)');
  });

  app.get('/saml/:slug/acs', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L7)');
  });

  app.post('/saml/:slug/acs', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L7)');
  });

  app.get('/saml/:slug/initsso', async (request) => {
    parse(slugParams, request.params);
    throw new Error('not implemented (L7)');
  });
}

/** under `/rest`: the workspace's SAML config */
export function registerSamlRestRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/sso/saml/config', async (request) => {
    await requireScope(request, 'saml:manage');
    throw new Error('not implemented (L7)');
  });

  app.post('/sso/saml/config', async (request) => {
    await requireScope(request, 'saml:manage');
    throw new Error('not implemented (L7)');
  });

  app.post('/sso/saml/config/toggle', async (request) => {
    await requireScope(request, 'saml:manage');
    throw new Error('not implemented (L7)');
  });

  app.post('/sso/saml/config/test', async (request) => {
    await requireScope(request, 'saml:manage');
    throw new Error('not implemented (L7)');
  });
}
