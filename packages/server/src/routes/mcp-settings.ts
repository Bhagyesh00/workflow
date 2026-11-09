/**
 * /rest/mcp/* (P5-04, P6-35): MCP settings of the workspace, the user's own MCP key and which workflows MCP
 * clients can reach. Scopes as n8n: settings read `mcp:oauth`, change `mcp:manage`; the key is the caller's
 * own (`mcpApiKey:create`, `mcpApiKey:rotate`); the workflow list and `toggle-access` hold to
 * `workflow:update` per workflow (the service narrows every row to the caller's projects). Shapes are the editor's (`McpSettings`, `McpApiKey`, `McpWorkflowSummary[]`,
 * `McpToggleAccessResult`).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
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
    const auth = await requireScope(request, 'mcp:oauth');
    return { data: await settings.getSettings(auth) };
  });

  rest.patch('/mcp/settings', async (request) => {
    const auth = await requireScope(request, 'mcp:manage');
    return { data: await settings.patchSettings(auth, parse(mcpSettingsPatchSchema, request.body ?? {})) };
  });

  rest.get('/mcp/api-key', async (request) => {
    const auth = await requireScope(request, 'mcpApiKey:create');
    return { data: await settings.getApiKey(auth) };
  });

  rest.post('/mcp/api-key/rotate', async (request) => {
    const auth = await requireScope(request, 'mcpApiKey:rotate');
    return { data: await settings.rotateApiKey(auth) };
  });

  rest.get('/mcp/workflows', async (request) => {
    // no workspace scope (a member edits through a project): the service lists what `workflow:update` reaches
    const auth = requireAuth(request);
    return { data: await settings.listWorkflows(auth, parse(mcpWorkflowsQuerySchema, request.query ?? {})) };
  });

  rest.patch('/mcp/workflows/toggle-access', async (request) => {
    // `workflow:update` is checked per workflow in the service
    const auth = requireAuth(request);
    return { data: await settings.toggleAccess(auth, parse(mcpToggleAccessSchema, request.body ?? {})) };
  });
}
