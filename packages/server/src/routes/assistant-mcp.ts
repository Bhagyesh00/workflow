/**
 * /rest/assistant/mcp-connections (P5-72, lane L9): the workspace's MCP servers for the Assistant. GET
 * viewer, POST, PATCH `/:id`, DELETE `/:id` admin. The gate: signed out 401, MCP access off for this
 * workspace (`TenantSettings.assistant.mcpAccessEnabled`, off by default) 404, then the role (403). A
 * connection holds a credential id, never a secret. Gates and rate limits are final from C0; the
 * handlers are L9's.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { type AuthContext, requireAuth } from '../http/auth';
import { ApiError } from '../http/errors';
import type { TenantSettings } from '../plans';
import { effectiveAssistantSettings } from '../services/assistant/settings';
import { hasRole } from '../services/auth';
import { assistantRouteOptions } from './assistant';

/** 401 signed out, 404 while MCP access is off for the workspace, then `minimum` role (403) */
export function requireAssistantMcp(request: FastifyRequest, ctx: ServerContext, minimum: Role): AuthContext {
  const auth = requireAuth(request);
  const settings = effectiveAssistantSettings(ctx.config, auth.tenant.settings as TenantSettings);
  if (!settings.mcpAccessEnabled) throw ApiError.notFound();
  if (!hasRole(auth.role, minimum)) throw ApiError.forbidden();
  return auth;
}

function notImplemented(): never {
  throw new Error('not implemented (L9)');
}

export function registerAssistantMcpRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  rest.get('/assistant/mcp-connections', assistantRouteOptions('mcp-list', 'read'), async (request) => {
    requireAssistantMcp(request, ctx, 'viewer');
    return notImplemented();
  });

  rest.post('/assistant/mcp-connections', assistantRouteOptions('mcp-create', 'write'), async (request) => {
    requireAssistantMcp(request, ctx, 'admin');
    return notImplemented();
  });

  rest.patch(
    '/assistant/mcp-connections/:id',
    assistantRouteOptions('mcp-update', 'write'),
    async (request) => {
      requireAssistantMcp(request, ctx, 'admin');
      return notImplemented();
    },
  );

  rest.delete(
    '/assistant/mcp-connections/:id',
    assistantRouteOptions('mcp-delete', 'write'),
    async (request) => {
      requireAssistantMcp(request, ctx, 'admin');
      return notImplemented();
    },
  );
}
