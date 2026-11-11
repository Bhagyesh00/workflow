/**
 * /rest/source-control status, push, pull and remote content (P6-07, L4), as n8n's source control controller.
 * Status (direction push), push and remote content are in the list filter form the plan names for them (plan-S4
 * C0c item 3 and critic row 4: "the list filter form through `pushableProjects`"): any signed-in user, and the
 * service narrows to the projects of `pushableProjects` (services/source-control/scope.ts, the `sourceControl:push`
 * filter: `'all'` for the global scope, else the team projects whose role holds it, as
 * `ctx.access.listFilter(auth, 'sourceControl:push')` gives; a name outside the caller's own status is refused;
 * n8n's `getWorkflowsInAdminProjectsFromContext`). The filter is read once, in the service, under the lease, so
 * the route does not read it again. Status with direction pull and the pull need `sourceControl:pull`. Every error
 * text these routes answer passes `redactSecrets` in `SourceControlSyncService`.
 * The schemas are exported for the public rows (routes/public-source-control.ts, L5). Answers in this order: a bad
 * body or query 400, source control not connected 412 (n8n's middleware), then the service's own refusals (a name
 * outside the caller's status 400, a remote workflow outside the caller's pushable projects 403, a conflict 409,
 * another operation holding the lease 409).
 */
import type { SourceControlledFileType } from '@workflow/workflow';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const FILE_TYPES = [
  'workflow',
  'credential',
  'variables',
  'tags',
  'folders',
  'datatable',
  'project',
] as const satisfies readonly SourceControlledFileType[];

export const sourceControlStatusQuery = z.object({
  direction: z.enum(['push', 'pull']).default('push'),
  verbose: z.stringbool().optional(),
  preferLocalVersion: z.stringbool().optional(),
});

/** the client names files by id and type only; the paths come from the server's own status */
export const pushWorkFolderSchema = z.object({
  force: z.boolean().optional(),
  commitMessage: z.string().trim().min(1).max(1000).optional(),
  fileNames: z
    .array(z.object({ id: z.string().min(1).max(64), type: z.enum(FILE_TYPES) }))
    .min(1)
    .max(5000),
});

export const pullWorkFolderSchema = z.object({
  force: z.boolean().optional(),
  autoPublish: z.enum(['none', 'all', 'published']).optional(),
});

const remoteContentParams = z.object({ type: z.enum(['workflow']), id: z.uuid() });

export function registerSourceControlSyncRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const status = async (request: FastifyRequest) => {
    // list filter form: a push status lists only the caller's pushable projects (the service narrows)
    let auth = requireAuth(request);
    const query = parse(sourceControlStatusQuery, request.query ?? {});
    if (query.direction === 'pull') auth = await requireScope(request, 'sourceControl:pull');
    return { data: await ctx.sourceControlSync.status(auth, query) };
  };
  app.get('/source-control/get-status', status);
  app.get('/source-control/status', status);

  app.post('/source-control/push-workfolder', async (request) => {
    // list filter form: the service refuses a file outside the caller's pushable projects
    const auth = requireAuth(request);
    const body = parse(pushWorkFolderSchema, request.body ?? {});
    return { data: await ctx.sourceControlSync.push(auth, body) };
  });

  app.post('/source-control/pull-workfolder', async (request) => {
    const auth = await requireScope(request, 'sourceControl:pull');
    const body = parse(pullWorkFolderSchema, request.body ?? {});
    return { data: await ctx.sourceControlSync.pull(auth, body) };
  });

  app.get('/source-control/remote-content/:type/:id', async (request) => {
    // list filter form: 403 unless the workflow's project is one of the caller's pushable projects
    const auth = requireAuth(request);
    const { type, id } = parse(remoteContentParams, request.params);
    return { data: await ctx.sourceControlSync.remoteContent(auth, type, id) };
  });
}
