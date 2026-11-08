/**
 * The tenant MCP server endpoint (P5-04, filled by L8): `POST /mcp-server/:tenantSlug/http`, outside
 * `/rest` (no cookie, no CSRF: Bearer only). L8 serves it from an encapsulated plugin with a string
 * body parser (malformed JSON gives -32700, over the limit 413), `mcpHostAllowed` first on every method
 * (else 403), `mcpCorsHeaders` on every reply, GET 405 with `Allow: POST`, HEAD 401 with
 * `WWW-Authenticate` and `resource_metadata`, OPTIONS CORS, `mcpRateLimit(config.mcp.rateLimit)`, and
 * 404 for everything while MCP access is off. Registered by app.ts after `webhookPlugin`.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';

export async function registerMcpServerRoutes(app: FastifyInstance, _ctx: ServerContext): Promise<void> {
  await app.register(async (scope) => {
    scope.post('/mcp-server/:tenantSlug/http', async () => {
      throw new Error('not implemented (L8)');
    });
  });
}
