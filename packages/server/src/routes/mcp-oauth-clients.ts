/**
 * /rest/mcp/oauth* and /rest/mcp/instance-stats (P5-14): the workspace's registered OAuth clients
 * (delete revokes their tokens), the allowed redirect URIs (`http` only for loopback) and the instance
 * stats. The redirect list and the stats need `mcp:manage`; the client routes need `mcp:oauth`: the list is
 * the caller's own clients (`ownership=all` needs `mcp:manage`) and a delete removes one user's grant, the
 * caller's own or, with `mcp:manage`, another user's through `?userId=`; the client goes with its last
 * consent (P6-35). Shapes are the editor's (`McpRedirectUris`, `McpOAuthClient[]`, `McpInstanceStats`).
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { tenants } from '../db/schema';
import { requireScope } from '../http/auth';
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
const clientDeleteQuery = z.object({ userId: z.string().uuid().optional() });

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
    const auth = await requireScope(request, ownership === 'all' ? 'mcp:manage' : 'mcp:oauth');
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

  // as n8n: a delete removes one user's grant (consent, codes and tokens), the caller's own by default and
  // another user's through `?userId=` (needs `mcp:manage`). The client row goes with its last consent.
  rest.delete('/mcp/oauth-clients/:clientId', async (request) => {
    const auth = await requireScope(request, 'mcp:oauth');
    const { clientId } = request.params as { clientId: string };
    const { userId } = parse(clientDeleteQuery, request.query ?? {});
    const target = userId ?? auth.user.id;
    if (target !== auth.user.id) await requireScope(request, 'mcp:manage');
    if (!(await repos.mcpOAuth.revokeForUser(auth.tenant.id, target, clientId))) {
      throw ApiError.notFound('OAuth client');
    }
    const clientDeleted = await repos.mcpOAuth.deleteClientWithoutConsents(auth.tenant.id, clientId);
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'mcp.oauth_grant_revoked',
      resourceType: 'oauth_client',
      resourceId: clientId,
      metadata: { userId: target, clientDeleted },
    });
    if (clientDeleted) {
      await repos.audit.add(auth.tenant.id, {
        userId: auth.user.id,
        action: 'mcp.oauth_client_deleted',
        resourceType: 'oauth_client',
        resourceId: clientId,
      });
    }
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
