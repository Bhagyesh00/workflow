/**
 * /rest workflow dependencies (P6-86, L18), as n8n's workflow dependency controller: POST
 * `/workflow-dependencies/counts` and `/workflow-dependencies/details` (at most 100 ids) and GET
 * `/workflow-dependencies/projects/:projectId/folders/:folderId`. Computed from `workflows.nodes` and `settings`
 * (no table). All three are in the list filter form of `GET /executions` (from S1): no scope on the route, the
 * resources the caller cannot read are dropped through `AccessService.listFilter` in the service, and the
 * counts follow.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';
import { DEPENDENCY_BATCH_LIMIT } from '../services/dependencies';

const queryBody = z.object({
  resourceType: z.enum(['workflow', 'credential', 'dataTable']),
  resourceIds: z.array(z.string().max(64)).max(DEPENDENCY_BATCH_LIMIT),
});
const folderParams = z.object({ projectId: z.uuid(), folderId: z.uuid() });

export function registerDependencyRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post('/workflow-dependencies/counts', async (request) => {
    const auth = requireAuth(request);
    const { resourceType, resourceIds } = queryBody.parse(request.body);
    return { data: await ctx.dependencies.counts(auth, resourceType, resourceIds) };
  });

  app.post('/workflow-dependencies/details', async (request) => {
    const auth = requireAuth(request);
    const { resourceType, resourceIds } = queryBody.parse(request.body);
    return { data: await ctx.dependencies.details(auth, resourceType, resourceIds) };
  });

  app.get('/workflow-dependencies/projects/:projectId/folders/:folderId', async (request) => {
    const auth = requireAuth(request);
    const { projectId, folderId } = folderParams.parse(request.params);
    return { data: await ctx.dependencies.folderDependencies(auth, projectId, folderId) };
  });
}
