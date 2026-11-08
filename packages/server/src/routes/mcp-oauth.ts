/**
 * The MCP OAuth server's public routes (P5-14), outside `/rest` (no cookie): under the issuer
 * `/mcp-oauth/:tenantSlug` `register`, `authorize`, `token`, `revoke`; RFC 8414 metadata at
 * `/.well-known/oauth-authorization-server/<base path>/mcp-oauth/:tenantSlug`; RFC 9728 metadata at
 * `/.well-known/oauth-protected-resource/<base path>/<resource path>` (path insertion: the path of
 * MCP_BASE_URL, if any, comes right after the well-known segment). Every route: `mcpHostAllowed` (else
 * 403), `mcpCorsHeaders`, its 5-minute rate limit (`config.mcp.oauthRateLimits`), and 404 for an unknown
 * slug. The routes are shared by the tenant MCP server and the MCP Server Triggers, so they answer while
 * the workspace's MCP access is off (as n8n); the switch gates only the tenant server's resource (its
 * authorize, consent, tokens and metadata). This encapsulated plugin has its own form parser
 * (routes/webhooks.ts `parseForm`) and the `sweepExpired` timer (`unref()`, cleared in `onClose`).
 * Registered by app.ts after `webhookPlugin`.
 */
import { isPlainObject } from '@workflow/workflow';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import type { TenantRow } from '../db/schema';
import { mcpCorsHeaders, mcpHostAllowed, mcpRateLimit } from '../http/mcp-http';
import { startMcpAuthorization } from '../services/mcp/oauth/authorize';
import { registerMcpOAuthClient } from '../services/mcp/oauth/clients';
import { mcpAuthorizationServerMetadata, mcpProtectedResourceMetadata } from '../services/mcp/oauth/metadata';
import {
  exchangeMcpOAuthToken,
  type McpOAuthTokenReply,
  revokeMcpOAuthToken,
} from '../services/mcp/oauth/tokens';
import { parseForm } from './webhooks';

/** how often expired codes and tokens are deleted */
export const MCP_OAUTH_SWEEP_INTERVAL_MS = 15 * 60_000;

/** the largest form or JSON body an OAuth route reads */
const OAUTH_BODY_LIMIT = 64 * 1024;

export const MCP_OAUTH_TEXTS = {
  host: 'The Host header does not match the MCP base URL',
  notAvailable: 'MCP access is not available for this workspace',
  noResource: 'No protected resource at this path',
  rateLimited: 'Too many requests, please try again later',
  badRequest: 'The request could not be read',
  repeated: 'A parameter must not be given more than once',
  form: 'The request body must be application/x-www-form-urlencoded',
  internal: 'Internal server error',
} as const;

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  statusCode: number,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  reply.code(statusCode).headers({ ...mcpCorsHeaders(request.headers), ...headers });
  if (body === undefined) return reply.send();
  return reply.header('content-type', 'application/json; charset=utf-8').send(body);
}

const oauthBody = (error: string, description: string) => ({ error, error_description: description });

/** the form body as single string values; null when a parameter repeats or the body is not a form */
function formValues(body: unknown): Record<string, string> | null | 'repeated' {
  if (!isPlainObject(body)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) return 'repeated';
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * The rest of a well-known wildcard path after the MCP base URL's path (`wf` of `https://h/wf`), or null
 * when the path does not start with it (RFC 8414 and RFC 9728 path insertion put it first).
 */
export function afterBasePath(baseUrl: string, path: string): string | null {
  const base = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '');
  const rest = path.replace(/^\/+/, '');
  if (!base) return rest;
  return rest.startsWith(`${base}/`) ? rest.slice(base.length + 1) : null;
}

function decodedSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

export async function mcpOAuthPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const { ctx } = opts;
  const { config } = ctx;
  const limits = config.mcp.oauthRateLimits;

  // RFC 6749: the token and revoke endpoints take form bodies; this parser lives in this plugin only
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: OAUTH_BODY_LIMIT },
    (_request, body, done) => done(null, parseForm(String(body))),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 429) {
      return send(reply, request, 429, oauthBody('rate_limited', MCP_OAUTH_TEXTS.rateLimited));
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return send(reply, request, error.statusCode, oauthBody('invalid_request', MCP_OAUTH_TEXTS.badRequest));
    }
    // the error's name only: a message may hold a code or a token
    ctx.logger.warn({ error: error?.name }, 'MCP OAuth route failed');
    return send(reply, request, 500, oauthBody('server_error', MCP_OAUTH_TEXTS.internal));
  });

  // DNS rebinding: every route of this plugin answers only on the MCP base URL's host
  app.addHook('onRequest', async (request, reply) => {
    if (!mcpHostAllowed(request, config)) {
      return send(reply, request, 403, { error: { code: 'forbidden', message: MCP_OAUTH_TEXTS.host } });
    }
  });

  /**
   * The tenant of the slug; else the 404 is sent and undefined returned. Not gated by MCP access: these
   * routes also serve the tenant's MCP Server Triggers, so the services refuse only the server's resource.
   */
  const tenantOf = async (
    request: FastifyRequest,
    reply: FastifyReply,
    slug: string,
  ): Promise<TenantRow | undefined> => {
    const tenant = slug ? await ctx.repos.tenants.getBySlug(slug) : undefined;
    if (tenant) return tenant;
    await send(reply, request, 404, oauthBody('not_found', MCP_OAUTH_TEXTS.notAvailable));
    return undefined;
  };

  const sendTokenReply = (request: FastifyRequest, reply: FastifyReply, answer: McpOAuthTokenReply) =>
    send(reply, request, answer.statusCode, answer.body, answer.headers ?? {});

  /** the form of a token or revoke request; sends the 400 and returns undefined when it is not one */
  const readForm = async (request: FastifyRequest, reply: FastifyReply) => {
    const values = formValues(request.body);
    if (values === 'repeated') {
      await send(reply, request, 400, oauthBody('invalid_request', MCP_OAUTH_TEXTS.repeated), {
        'cache-control': 'no-store',
      });
      return undefined;
    }
    if (!values) {
      await send(reply, request, 400, oauthBody('invalid_request', MCP_OAUTH_TEXTS.form), {
        'cache-control': 'no-store',
      });
      return undefined;
    }
    return values;
  };

  const preflight = async (request: FastifyRequest, reply: FastifyReply) => send(reply, request, 204);

  app.post(
    '/mcp-oauth/:tenantSlug/register',
    { config: { rateLimit: mcpRateLimit(limits.register) }, bodyLimit: OAUTH_BODY_LIMIT },
    async (request, reply) => {
      const tenant = await tenantOf(request, reply, (request.params as { tenantSlug: string }).tenantSlug);
      if (!tenant) return reply;
      const answer = await registerMcpOAuthClient(ctx, tenant, request.body);
      return send(reply, request, answer.statusCode, answer.body, { 'cache-control': 'no-store' });
    },
  );

  app.get(
    '/mcp-oauth/:tenantSlug/authorize',
    { config: { rateLimit: mcpRateLimit(limits.authorize) } },
    async (request, reply) => {
      const tenant = await tenantOf(request, reply, (request.params as { tenantSlug: string }).tenantSlug);
      if (!tenant) return reply;
      // the service checks the client's redirect URI before it returns any redirect (GHSA-rc3w)
      const outcome = await startMcpAuthorization(
        ctx,
        tenant,
        (request.query ?? {}) as Record<string, unknown>,
      );
      if ('redirect' in outcome) {
        reply.headers({ ...mcpCorsHeaders(request.headers), 'cache-control': 'no-store' });
        return reply.redirect(outcome.redirect, 302);
      }
      return send(reply, request, outcome.statusCode, outcome.body, { 'cache-control': 'no-store' });
    },
  );

  app.post(
    '/mcp-oauth/:tenantSlug/token',
    { config: { rateLimit: mcpRateLimit(limits.token) } },
    async (request, reply) => {
      const tenant = await tenantOf(request, reply, (request.params as { tenantSlug: string }).tenantSlug);
      if (!tenant) return reply;
      const form = await readForm(request, reply);
      if (!form) return reply;
      return sendTokenReply(
        request,
        reply,
        await exchangeMcpOAuthToken(ctx, tenant, form, header(request, 'authorization')),
      );
    },
  );

  app.post(
    '/mcp-oauth/:tenantSlug/revoke',
    { config: { rateLimit: mcpRateLimit(limits.revoke) } },
    async (request, reply) => {
      const tenant = await tenantOf(request, reply, (request.params as { tenantSlug: string }).tenantSlug);
      if (!tenant) return reply;
      const form = await readForm(request, reply);
      if (!form) return reply;
      return sendTokenReply(
        request,
        reply,
        await revokeMcpOAuthToken(ctx, tenant, form, header(request, 'authorization')),
      );
    },
  );

  app.get(
    '/.well-known/oauth-authorization-server/*',
    { config: { rateLimit: mcpRateLimit(limits.wellKnown) } },
    async (request, reply) => {
      // `<base path>/mcp-oauth/<slug>`, the issuer's path
      const path = afterBasePath(config.mcp.baseUrl, (request.params as { '*'?: string })['*'] ?? '');
      const [issuer, rawSlug = '', ...more] = (path ?? '').split('/');
      const slug = issuer === 'mcp-oauth' && more.length === 0 ? decodedSegment(rawSlug) : '';
      const tenant = await tenantOf(request, reply, slug);
      if (!tenant) return reply;
      return send(reply, request, 200, mcpAuthorizationServerMetadata(config, tenant.slug));
    },
  );

  app.get(
    '/.well-known/oauth-protected-resource/*',
    { config: { rateLimit: mcpRateLimit(limits.wellKnown) } },
    async (request, reply) => {
      // `<base path>/mcp-server/<slug>/http` or `<base path>/<endpoint>/<slug>/<path>`
      const path = afterBasePath(config.mcp.baseUrl, (request.params as { '*'?: string })['*'] ?? '');
      if (path === null) return send(reply, request, 404, oauthBody('not_found', MCP_OAUTH_TEXTS.noResource));
      // the slug is the second segment
      const [, rawSlug = ''] = path.split('/');
      const tenant = await tenantOf(request, reply, decodedSegment(rawSlug));
      if (!tenant) return reply;
      const metadata = await mcpProtectedResourceMetadata(ctx, tenant, path);
      if (!metadata) return send(reply, request, 404, oauthBody('not_found', MCP_OAUTH_TEXTS.noResource));
      return send(reply, request, 200, metadata);
    },
  );

  // CORS preflights of browser-based MCP clients
  app.options('/mcp-oauth/:tenantSlug/*', preflight);
  app.options('/.well-known/oauth-authorization-server/*', preflight);
  app.options('/.well-known/oauth-protected-resource/*', preflight);

  const sweep = setInterval(() => {
    ctx.repos.mcpOAuth.sweepExpired(new Date()).catch((error: Error) => {
      ctx.logger.warn({ error: error?.name }, 'MCP OAuth sweep failed');
    });
  }, MCP_OAUTH_SWEEP_INTERVAL_MS);
  sweep.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweep);
  });
}
