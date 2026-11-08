/**
 * The MCP OAuth server's public routes (P5-14, filled by L10), outside `/rest` (no cookie): under the
 * issuer `/mcp-oauth/:tenantSlug` `register`, `authorize`, `token`, `revoke`; RFC 8414 metadata at
 * `/.well-known/oauth-authorization-server/mcp-oauth/:tenantSlug`; RFC 9728 metadata at
 * `/.well-known/oauth-protected-resource/<resource path>`. Every route: `mcpHostAllowed` (else 403),
 * `mcpCorsHeaders`, its 5-minute rate limit (`config.mcp.oauthRateLimits`), and 404 while MCP access is
 * off. L10 adds the form parser of this encapsulated plugin (routes/webhooks.ts `parseForm`) and the
 * `sweepExpired` timer (`unref()`, cleared in `onClose`). Registered by app.ts after `webhookPlugin`.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { mcpRateLimit } from '../http/mcp-http';

export async function mcpOAuthPlugin(app: FastifyInstance, opts: { ctx: ServerContext }): Promise<void> {
  const limits = opts.ctx.config.mcp.oauthRateLimits;
  const notImplemented = async () => {
    throw new Error('not implemented (L10)');
  };

  app.post(
    '/mcp-oauth/:tenantSlug/register',
    { config: { rateLimit: mcpRateLimit(limits.register) } },
    notImplemented,
  );
  app.get(
    '/mcp-oauth/:tenantSlug/authorize',
    { config: { rateLimit: mcpRateLimit(limits.authorize) } },
    notImplemented,
  );
  app.post(
    '/mcp-oauth/:tenantSlug/token',
    { config: { rateLimit: mcpRateLimit(limits.token) } },
    notImplemented,
  );
  app.post(
    '/mcp-oauth/:tenantSlug/revoke',
    { config: { rateLimit: mcpRateLimit(limits.revoke) } },
    notImplemented,
  );
  app.get(
    '/.well-known/oauth-authorization-server/mcp-oauth/:tenantSlug',
    { config: { rateLimit: mcpRateLimit(limits.wellKnown) } },
    notImplemented,
  );
  app.get(
    '/.well-known/oauth-protected-resource/*',
    { config: { rateLimit: mcpRateLimit(limits.wellKnown) } },
    notImplemented,
  );
}
