/**
 * SAML routes (P6-09, L7). Public, under `/sso` (routes/sso-public.ts `ssoPlugin`, outside the `/rest`
 * session and CSRF hook): the identity provider and the browser reach them before any session exists, and
 * the signed SAML message is the proof: GET `/sso/saml/:slug/metadata`, GET and POST `/sso/saml/:slug/acs`,
 * GET `/sso/saml/:slug/initsso`. Under `/rest`, `saml:manage`: GET and POST `/sso/saml/config`, POST
 * `/sso/saml/config/toggle`, `/sso/saml/config/test`.
 *
 * A refused sign-in sends the browser to `/signin?workspace=<slug>&ssoError=<code>` (the sign-in page has its
 * own text per code; the SAML details stay in the audit line). The POST page and the test result page send
 * their own CSP; every other answer keeps the app's.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope, setSessionCookie } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { safeSsoRedirect } from '../services/sso/redirect';
import { SAML_TEST_PAGE_CSP } from '../services/sso/views';

const slugParams = z.object({ slug: z.string().min(1).max(64) });
const initQuery = z
  .object({
    redirect: z.string().max(2048).optional(),
    test: z.string().max(128).optional(),
  })
  .passthrough();
/** the redirect-binding fields; the octet string is rebuilt from the raw query, never taken from it */
const redirectFields = ['SAMLResponse', 'RelayState', 'SigAlg', 'Signature'] as const;
const toggleBody = z.object({ loginEnabled: z.boolean() });

function firstString(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

/** back to the sign-in page with the refusal's code (never its text) */
function refused(reply: FastifyReply, slug: string, code: string) {
  const params = new URLSearchParams({ workspace: slug, ssoError: code });
  return reply.redirect(`/signin?${params.toString()}`, 302);
}

/** the signed part of a redirect-binding query: the raw pairs in their order, without `Signature` */
function octetString(request: FastifyRequest): string {
  const raw = request.raw.url ?? '';
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  return query
    .split('&')
    .filter((pair) => pair && !pair.startsWith('Signature='))
    .join('&');
}

/** under the `/sso` prefix of `ssoPlugin`; no session: the IdP's signed message is the proof */
export function registerSamlPublicRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // public: the identity provider reads the service provider metadata
  app.get('/saml/:slug/metadata', async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const xml = await ctx.saml.metadata(slug);
    return reply.header('content-type', 'application/samlmetadata+xml; charset=utf-8').send(xml);
  });

  const acs = async (request: FastifyRequest, reply: FastifyReply, binding: 'redirect' | 'post') => {
    const { slug } = parse(slugParams, request.params);
    const source = (binding === 'post' ? request.body : request.query) as Record<string, unknown> | undefined;
    const message: Record<string, string> = {};
    for (const field of redirectFields) {
      const value = firstString(source?.[field]);
      if (value !== undefined) message[field] = value;
    }
    if (binding === 'redirect') message.octetString = octetString(request);
    try {
      const outcome = await ctx.saml.acs(slug, binding, message, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      if (outcome.kind === 'test') {
        return reply
          .header('content-security-policy', SAML_TEST_PAGE_CSP)
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(outcome.html);
      }
      setSessionCookie(reply, ctx.config, outcome.result.token);
      return reply.header('cache-control', 'no-store').redirect(outcome.redirect, 302);
    } catch (error) {
      if (error instanceof ApiError) return refused(reply, slug, error.code);
      throw error;
    }
  };

  // public: the identity provider's redirect binding (the browser brings the signed query)
  app.get('/saml/:slug/acs', async (request, reply) => acs(request, reply, 'redirect'));

  // public: the identity provider's POST binding (the browser posts the signed response)
  app.post('/saml/:slug/acs', async (request, reply) => acs(request, reply, 'post'));

  // public: the editor's SSO button starts here (`?redirect=<path>`), the settings test with `?test=<token>`
  app.get('/saml/:slug/initsso', async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const query = parse(initQuery, request.query);
    const relayState = query.test
      ? ctx.saml.testRelayState(query.test)
      : query.redirect
        ? safeSsoRedirect(query.redirect, ctx.config.baseUrl)
        : undefined;
    try {
      const start = await ctx.saml.initSso(slug, relayState);
      if (start.html) {
        return reply
          .header('content-security-policy', start.csp ?? "default-src 'none'")
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(start.html);
      }
      if (start.redirect) return reply.header('cache-control', 'no-store').redirect(start.redirect, 302);
      return refused(reply, slug, 'saml_config_invalid');
    } catch (error) {
      if (query.test && error instanceof ApiError) {
        return reply
          .header('content-security-policy', SAML_TEST_PAGE_CSP)
          .status(400)
          .send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof ApiError) return refused(reply, slug, error.code);
      throw error;
    }
  });
}

/** under `/rest`: the workspace's SAML config */
export function registerSamlRestRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/sso/saml/config', async (request) => {
    const auth = await requireScope(request, 'saml:manage');
    return { data: await ctx.saml.getConfig(auth.tenant.id) };
  });

  app.post('/sso/saml/config', async (request) => {
    const auth = await requireScope(request, 'saml:manage');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return { data: await ctx.saml.saveConfig(auth.tenant.id, body, auth.user.id) };
  });

  app.post('/sso/saml/config/toggle', async (request) => {
    const auth = await requireScope(request, 'saml:manage');
    const { loginEnabled } = parse(toggleBody, request.body ?? {});
    await ctx.saml.toggle(auth.tenant.id, loginEnabled, auth.user.id);
    return { data: await ctx.saml.getConfig(auth.tenant.id) };
  });

  app.post('/sso/saml/config/test', async (request) => {
    const auth = await requireScope(request, 'saml:manage');
    const body = (request.body ?? {}) as Record<string, unknown>;
    return { data: await ctx.saml.testUrl(auth.tenant.id, body) };
  });
}
