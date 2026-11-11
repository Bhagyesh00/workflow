/**
 * Public API source control (P6-75, L5): GET `/source-control/status` (`sourceControl:read`), POST
 * `/source-control/push` (`sourceControl:push`; any key whose user has pushable projects, the service narrows to
 * them, so the access is in the list filter form) and POST `/source-control/pull` (`sourceControl:pull`), through
 * `ctx.sourceControlSync` as REST; 409 lists the files, 400 when not connected (n8n's public controller).
 * PUBLIC_SOURCE_CONTROL_ROUTES is shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 * stub (L5): the rows have their final path, access and scope; the service methods throw.
 */
import { z } from 'zod';
import type { ApiRoute } from './public-api';
import { pullWorkFolderSchema, pushWorkFolderSchema } from './source-control-sync';

const statusQuery = z.object({ direction: z.enum(['push', 'pull']).default('push') });

export const PUBLIC_SOURCE_CONTROL_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/source-control/status',
    summary: 'List the files that differ between the workspace and the connected branch',
    tag: 'SourceControl',
    access: { scope: 'sourceControl:read' },
    scope: 'sourceControl:read',
    query: statusQuery,
    response: 'SourceControlledFile',
    list: true,
    handler: async (ctx, { auth, query }) => ({
      data: await ctx.sourceControlSync.status(auth, { direction: query.direction }),
    }),
  },
  {
    method: 'POST',
    path: '/source-control/push',
    summary: 'Push the named files to the connected branch',
    tag: 'SourceControl',
    access: { scope: 'sourceControl:push', list: true },
    scope: 'sourceControl:push',
    body: pushWorkFolderSchema,
    response: 'PushResult',
    handler: async (ctx, { auth, body }) => ({ data: await ctx.sourceControlSync.push(auth, body) }),
  },
  {
    method: 'POST',
    path: '/source-control/pull',
    summary: 'Pull the connected branch into the workspace',
    tag: 'SourceControl',
    access: { scope: 'sourceControl:pull' },
    scope: 'sourceControl:pull',
    body: pullWorkFolderSchema,
    response: 'PullResult',
    handler: async (ctx, { auth, body }) => ({ data: await ctx.sourceControlSync.pull(auth, body) }),
  },
];
