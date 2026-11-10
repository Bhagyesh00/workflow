/**
 * OIDC routes (P6-10, L8). Public, under `/sso` (routes/sso-public.ts `ssoPlugin`, outside the `/rest`
 * session and CSRF hook): the browser starts a sign-in and the provider sends it back before any session
 * exists; the signed state and nonce cookies are the proof: GET `/sso/oidc/:slug/login`,
 * `/sso/oidc/:slug/callback`. Under `/rest`: GET and POST `/sso/oidc/config`, POST `/sso/oidc/config/test`
 * (`oidc:manage`), POST `/sso/oidc/logout` (session).
 * A refused sign-in sends the browser to `/signin?workspace=<slug>&ssoError=<code>`; the provider's own
 * error text is never put on that URL.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { clearSessionCookie, requireAuth, requireScope, setSessionCookie } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import {
  OIDC_COOKIE_TTL_S,
  OIDC_ID_TOKEN_COOKIE,
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  type OidcCookie,
} from '../services/sso/oidc';

const slugParams = z.object({ slug: z.string().min(1).max(64) });
const loginQuery = z.object({ redirect: z.string().max(2048).optional() }).passthrough();
const callbackQuery = z
  .object({
    code: z.string().max(4096).optional(),
    state: z.string().max(4096).optional(),
    iss: z.string().max(2048).optional(),
    error: z.string().max(256).optional(),
  })
  .passthrough();

/** the cookies of one sign-in belong to the workspace's own path */
function flowCookiePath(slug: string): string {
  return `/sso/oidc/${encodeURIComponent(slug)}`;
}

function setFlowCookies(
  reply: FastifyReply,
  ctx: ServerContext,
  slug: string,
  cookies: OidcCookie[],
): void {
  for (const cookie of cookies) {
    reply.setCookie(cookie.name, cookie.value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure,
      path: flowCookiePath(slug),
      maxAge: OIDC_COOKIE_TTL_S,
    });
  }
}

function clearFlowCookies(reply: FastifyReply, ctx: ServerContext, slug: string): void {
  for (const name of [OIDC_STATE_COOKIE, OIDC_NONCE_COOKIE]) {
    reply.clearCookie(name, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure,
      path: flowCookiePath(slug),
    });
  }
}

/** back to the sign-in page with the code (a fixed list), never the provider's words */
function signInError(reply: FastifyReply, slug: string, code: string): FastifyReply {
  const params = new URLSearchParams({ workspace: slug, ssoError: code });
  return reply.redirect(`/signin?${params.toString()}`, 302);
}

const rateLimit = (name: string) => ({
  config: {
    rateLimit: {
      max: 60,
      timeWindow: 60_000,
      keyGenerator: (request: FastifyRequest) => `${name}:${request.ip}`,
    },
  },
});

/** under the `/sso` prefix of `ssoPlugin`; no session: the signed state cookie is the proof */
export function registerOidcPublicRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/oidc/:slug/login', rateLimit('sso-oidc-login'), async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const { redirect } = parse(loginQuery, request.query);
    reply.header('cache-control', 'no-store');
    try {
      const login = await ctx.oidc.loginUrl(slug, redirect);
      setFlowCookies(reply, ctx, slug, login.cookies);
      return reply.redirect(login.url, 302);
    } catch (error) {
      if (error instanceof ApiError && error.statusCode !== 404) return signInError(reply, slug, error.code);
      throw error;
    }
  });

  app.get('/oidc/:slug/callback', rateLimit('sso-oidc-callback'), async (request, reply) => {
    const { slug } = parse(slugParams, request.params);
    const query = parse(callbackQuery, request.query);
    reply.header('cache-control', 'no-store');
    try {
      const outcome = await ctx.oidc.callback(
        slug,
        query,
        request.cookies,
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      );
      clearFlowCookies(reply, ctx, slug);
      if (outcome.kind === 'test') {
        // the test flow never starts a session; the page holds fixed words and an escaped email
        return reply
          .type('text/html; charset=utf-8')
          .header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          )
          .send(outcome.html);
      }
      setSessionCookie(reply, ctx.config, outcome.result.token);
      if (outcome.idTokenCookie) {
        reply.setCookie(OIDC_ID_TOKEN_COOKIE, outcome.idTokenCookie, {
          httpOnly: true,
          sameSite: 'lax',
          secure: ctx.config.cookieSecure,
          path: '/rest',
          maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
        });
      }
      return reply.redirect(outcome.redirect, 302);
    } catch (error) {
      clearFlowCookies(reply, ctx, slug);
      if (error instanceof ApiError && error.statusCode !== 404) return signInError(reply, slug, error.code);
      throw error;
    }
  });
}

/** under `/rest`: the workspace's OIDC config and the sign out */
export function registerOidcRestRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/sso/oidc/config', async (request) => {
    const auth = await requireScope(request, 'oidc:manage');
    return { data: await ctx.oidc.getConfig(auth.tenant.id) };
  });

  app.post('/sso/oidc/config', async (request) => {
    const auth = await requireScope(request, 'oidc:manage');
    const body = parse(z.object({}).passthrough(), request.body ?? {});
    return { data: await ctx.oidc.saveConfig(auth.tenant.id, body, auth.user.id) };
  });

  app.post('/sso/oidc/config/test', async (request, reply) => {
    const auth = await requireScope(request, 'oidc:manage');
    const test = await ctx.oidc.testUrl(auth.tenant.id);
    setFlowCookies(reply, ctx, auth.tenant.slug, test.cookies);
    return { data: { url: test.url } };
  });

  app.post('/sso/oidc/logout', async (request, reply) => {
    const auth = requireAuth(request);
    const out = await ctx.oidc.logout(auth, {
      idTokenCookie: request.cookies[OIDC_ID_TOKEN_COOKIE],
      ip: request.ip,
    });
    clearSessionCookie(reply, ctx.config);
    reply.clearCookie(OIDC_ID_TOKEN_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: ctx.config.cookieSecure,
      path: '/rest',
    });
    return { data: { url: out.redirect } };
  });
}
