/**
 * /rest/mcp/* (P5-04, filled by L8): MCP settings of the workspace, the user's own MCP key and which
 * workflows MCP clients can reach. Role gates are final (C0): settings read viewer, change admin; the
 * key is the caller's own (viewer, as routes/resources.ts API keys); the workflow list editor (editable
 * ones); `toggle-access` admin.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';

export function registerMcpSettingsRoutes(rest: FastifyInstance, _ctx: ServerContext): void {
  rest.get('/mcp/settings', async (request) => {
    requireRole(request, 'viewer');
    throw new Error('not implemented (L8)');
  });

  rest.patch('/mcp/settings', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L8)');
  });

  rest.get('/mcp/api-key', async (request) => {
    requireRole(request, 'viewer');
    throw new Error('not implemented (L8)');
  });

  rest.post('/mcp/api-key/rotate', async (request) => {
    requireRole(request, 'viewer');
    throw new Error('not implemented (L8)');
  });

  rest.get('/mcp/workflows', async (request) => {
    requireRole(request, 'editor');
    throw new Error('not implemented (L8)');
  });

  rest.patch('/mcp/workflows/toggle-access', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L8)');
  });
}
