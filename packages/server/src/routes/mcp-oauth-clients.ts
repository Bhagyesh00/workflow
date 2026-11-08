/**
 * /rest/mcp/oauth* and /rest/mcp/instance-stats (P5-14, filled by L10): the workspace's registered OAuth
 * clients (delete revokes their tokens), the allowed redirect URIs (`http` only for loopback) and the
 * instance stats. Admin only (gates final, C0).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';

export function registerMcpOAuthClientRoutes(rest: FastifyInstance, _ctx: ServerContext): void {
  rest.get('/mcp/oauth/allowed-redirect-uris', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L10)');
  });

  rest.patch('/mcp/oauth/allowed-redirect-uris', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L10)');
  });

  rest.get('/mcp/oauth-clients', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L10)');
  });

  rest.delete('/mcp/oauth-clients/:clientId', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L10)');
  });

  rest.get('/mcp/instance-stats', async (request) => {
    requireRole(request, 'admin');
    throw new Error('not implemented (L10)');
  });
}
