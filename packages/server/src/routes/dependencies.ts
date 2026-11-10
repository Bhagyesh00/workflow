/**
 * /rest workflow dependencies (P6-86, L18), as n8n's workflow dependency controller: POST
 * `/workflow-dependencies/counts` and `/workflow-dependencies/details` (at most 100 ids) and GET
 * `/workflow-dependencies/projects/:projectId/folders/:folderId`. Computed from `workflows.nodes` and `settings`
 * (no table). All three are in the list filter form of `GET /executions` (from S1): no scope on the route, the
 * workflows the caller cannot read are dropped through `AccessService.listFilter`, and the counts follow.
 * Paths and the filter form are final; each handler is a stub until L18 fills it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';

export function registerDependencyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const stub = async (request: FastifyRequest): Promise<never> => {
    const auth = requireAuth(request);
    await ctx.access.listFilter(auth, 'workflow:read');
    // stub (L18)
    throw new Error('not implemented (L18)');
  };

  app.post('/workflow-dependencies/counts', stub);
  app.post('/workflow-dependencies/details', stub);
  app.get('/workflow-dependencies/projects/:projectId/folders/:folderId', stub);
}
