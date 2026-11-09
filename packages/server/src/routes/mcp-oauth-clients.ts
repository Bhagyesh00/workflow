/**
 * /rest/mcp/oauth* and /rest/mcp/instance-stats (P5-14): the workspace's registered OAuth clients
 * (delete revokes their tokens), the allowed redirect URIs (`http` only for loopback) and the instance
 * stats. The redirect list and the stats need `mcp:manage`; the client list is the caller's own clients
 * (`ownership=all` needs `mcp:manage`) and a delete without it removes the caller's own grant (P6-35). Shapes are the editor's (`McpRedirectUris`, `McpOAuthClient[]`,
 * `McpInstanceStats`).
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { tenants } from '../db/schema';
import { requireAuth, requireScope } from '../http/auth';
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

const clientListQuery = z.object({ ownership: z.enum(['own', 'all']).default('own') });

export function registerMcpOAuthClientRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  const { repos } = ctx;

  rest.get('/mcp/oauth/allowed-redirect-uris', async (request) => {
    const auth = await requireScope(request, 'mcp:manage');
    const tenant = (await repos.tenants.get(auth.tenant.id)) ?? auth.tenant;
    return { data: { allowedRedirectUris: tenantAllowedRedirectUris(tenant) } };
  });

  rest.patch('/mcp/oauth/allowed-redirect-uris', async (request) => {
    const auth = await requireScope(request, 'mcp:manage');
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

  // P6-35: a client is the caller's own when the caller has a consent row for it (`oauth_user_consents`).
  // The list is the caller's own; `ownership=all` (every client of the workspace) needs `mcp:manage`.
  rest.get('/mcp/oauth-clients', async (request) => {
    const { ownership } = parse(clientListQuery, request.query ?? {});
    const auth = ownership === 'all' ? await requireScope(request, 'mcp:manage') : requireAuth(request);
    const clients =
      ownership === 'all'
        ? await repos.mcpOAuth.listClients(auth.tenant.id)
        : await repos.mcpOAuth.listClientsByUser(auth.tenant.id, auth.user.id);
    return {
      data: clients.map((client) => ({
        id: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        createdAt: client.createdAt.toISOString(),
      })),
    };
  });

  // a holder of `mcp:manage` deletes the client for every user (today's behaviour); anyone else removes
  // only their own grant (consent and tokens) and the client stays for the others
  rest.delete('/mcp/oauth-clients/:clientId', async (request) => {
    const auth = requireAuth(request);
    const { clientId } = request.params as { clientId: string };
    const manage = (await ctx.access.scopesForAuth(auth)).has('mcp:manage');
    if (manage) {
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
    }
    if (!(await repos.mcpOAuth.revokeForUser(auth.tenant.id, auth.user.id, clientId))) {
      throw ApiError.notFound('OAuth client');
    }
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.oauth_grant_revoked',
      resourceType: 'oauth_client',
      resourceId: clientId,
    });
    return { data: { ok: true } };
  });

  rest.get('/mcp/instance-stats', async (request) => {
    const auth = await requireScope(request, 'mcp:manage');
    return {
      data: {
        registeredClients: await repos.mcpOAuth.countClients(auth.tenant.id),
        maxRegisteredClients: ctx.config.mcp.maxRegisteredClients,
      },
    };
  });
}
