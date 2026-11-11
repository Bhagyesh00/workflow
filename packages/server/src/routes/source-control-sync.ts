/**
 * /rest/source-control status, push, pull and remote content (P6-07, L4), as n8n's source control controller.
 * Status (direction push), push and remote content are in the list filter form: any signed-in user, and the
 * service narrows to the projects of `pushableProjects` (a name outside the caller's own status is refused; n8n's
 * `getWorkflowsInAdminProjectsFromContext`). Status with direction pull and the pull need `sourceControl:pull`.
 * The schemas are exported for the public rows (routes/public-source-control.ts, L5).
 * stub (L4): the routes are registered with their final gates; the service methods throw.
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
