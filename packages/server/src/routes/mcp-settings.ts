/**
 * /rest/mcp/* (P5-04): MCP settings of the workspace, the user's own MCP key and which workflows MCP
 * clients can reach. Role gates are final (C0): settings read viewer, change admin; the key is the
 * caller's own (viewer, as routes/resources.ts API keys); the workflow list editor (editable ones);
 * `toggle-access` admin. Shapes are the editor's (`McpSettings`, `McpApiKey`, `McpWorkflowSummary[]`,
 * `McpToggleAccessResult`).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';
import {
  McpSettingsService,
  mcpSettingsPatchSchema,
  mcpToggleAccessSchema,
  mcpWorkflowsQuerySchema,
} from '../services/mcp/settings';

export function registerMcpSettingsRoutes(rest: FastifyInstance, ctx: ServerContext): void {
  const settings = new McpSettingsService(ctx);

  rest.get('/mcp/settings', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await settings.getSettings(auth) };
  });

  rest.patch('/mcp/settings', async (request) => {
    const auth = requireRole(request, 'admin');
    return { data: await settings.patchSettings(auth, parse(mcpSettingsPatchSchema, request.body ?? {})) };
  });

  rest.get('/mcp/api-key', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await settings.getApiKey(auth) };
  });

  rest.post('/mcp/api-key/rotate', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await settings.rotateApiKey(auth) };
  });

  rest.get('/mcp/workflows', async (request) => {
    const auth = requireRole(request, 'editor');
    return { data: await settings.listWorkflows(auth, parse(mcpWorkflowsQuerySchema, request.query ?? {})) };
  });

  rest.patch('/mcp/workflows/toggle-access', async (request) => {
    const auth = requireRole(request, 'admin');
    return { data: await settings.toggleAccess(auth, parse(mcpToggleAccessSchema, request.body ?? {})) };
  });
}
