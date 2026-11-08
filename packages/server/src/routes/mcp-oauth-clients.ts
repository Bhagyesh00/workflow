/**
 * /rest/mcp/oauth* and /rest/mcp/instance-stats (P5-14): the workspace's registered OAuth clients
 * (delete revokes their tokens), the allowed redirect URIs (`http` only for loopback) and the instance
 * stats. Admin only (gates final, C0). Shapes are the editor's (`McpRedirectUris`, `McpOAuthClient[]`,
 * `McpInstanceStats`).
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { tenants } from '../db/schema';
import { requireRole } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { tenantAllowedRedirectUris } from '../services/mcp/oauth/authorize';
import { MCP_OAUTH_MAX_REDIRECT_URI_LENGTH, redirectUriProblem } from '../services/mcp/oauth/clients';

/** the most entries the allowed redirect list holds */
export const MCP_ALLOWED_REDIRECT_URIS_MAX = 100;

const redirectUrisSchema = z
  .object({
    allowedRedirectUris: z
      .array(z.string().trim().min(1).max(MCP_OAUTH_MAX_REDIRECT_URI_LENGTH))
      .max(MCP_ALLOWED_REDIRECT_URIS_MAX),
  })
  .strict();

export function registerMcpOAuthClientRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  const { repos } = ctx;

  rest.get('/mcp/oauth/allowed-redirect-uris', async (request) => {
    const auth = requireRole(request, 'admin');
    const tenant = (await repos.tenants.get(auth.tenant.id)) ?? auth.tenant;
    return { data: { allowedRedirectUris: tenantAllowedRedirectUris(tenant) } };
  });

  rest.patch('/mcp/oauth/allowed-redirect-uris', async (request) => {
    const auth = requireRole(request, 'admin');
    const { allowedRedirectUris } = parse(redirectUrisSchema, request.body ?? {});
    for (const uri of allowedRedirectUris) {
      const problem = redirectUriProblem(uri);
      if (problem) throw ApiError.badRequest(`${problem}: ${uri.slice(0, 200)}`);
    }
    const list = [...new Set(allowedRedirectUris)];
    // one statement merges into `settings.mcp`, so a parallel change of other settings is kept
    const [row] = await ctx.database.db
      .update(tenants)
      .set({
        settings: sql`jsonb_set(coalesce(${tenants.settings}, '{}'::jsonb), '{mcp}', coalesce(${tenants.settings} -> 'mcp', '{}'::jsonb) || ${JSON.stringify({ allowedRedirectUris: list })}::jsonb, true)`,
      })
      .where(eq(tenants.id, auth.tenant.id))
      .returning();
    if (!row) throw ApiError.notFound('Workspace');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.allowed_redirect_uris_updated',
      resourceType: 'tenant',
      resourceId: auth.tenant.id,
      metadata: { count: list.length },
    });
    return { data: { allowedRedirectUris: tenantAllowedRedirectUris(row) } };
  });

  rest.get('/mcp/oauth-clients', async (request) => {
    const auth = requireRole(request, 'admin');
    const clients = await repos.mcpOAuth.listClients(auth.tenant.id);
    return {
      data: clients.map((client) => ({
        id: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        createdAt: client.createdAt.toISOString(),
      })),
    };
  });

  rest.delete('/mcp/oauth-clients/:clientId', async (request) => {
    const auth = requireRole(request, 'admin');
    const { clientId } = request.params as { clientId: string };
    // tokens go first, at once; the client row then takes its consents with it
    await repos.mcpOAuth.revokeForClient(auth.tenant.id, clientId);
    if (!(await repos.mcpOAuth.deleteClient(auth.tenant.id, clientId)))
      throw ApiError.notFound('OAuth client');
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.oauth_client_deleted',
      resourceType: 'oauth_client',
      resourceId: clientId,
    });
    return { data: { ok: true } };
  });

  rest.get('/mcp/instance-stats', async (request) => {
    const auth = requireRole(request, 'admin');
    return {
      data: {
        registeredClients: await repos.mcpOAuth.countClients(auth.tenant.id),
        maxRegisteredClients: ctx.config.mcp.maxRegisteredClients,
      },
    };
  });
}
