/**
 * Public API source control (P6-75, L5): GET `/source-control/status` (`sourceControl:read`), POST
 * `/source-control/push` (`sourceControl:push`; any key whose user has pushable projects, the service narrows to
 * them, so the access is in the list filter form) and POST `/source-control/pull` (`sourceControl:pull`), through
 * `ctx.sourceControlSync` as REST; 409 lists the files, 400 when not connected (n8n's public controller; REST
 * answers 412). The pull direction of the status also needs the user's `sourceControl:pull`, as the REST status
 * does. Error text passes `redactSecrets` inside `SourceControlSyncService`.
 * PUBLIC_SOURCE_CONTROL_ROUTES is shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it).
 */
import { z } from 'zod';
import { requireScope } from '../http/auth';
import { ApiError } from '../http/errors';
import type { ApiRoute } from './public-api';
import { pullWorkFolderSchema, pushWorkFolderSchema } from './source-control-sync';

const statusQuery = z.object({ direction: z.enum(['push', 'pull']).default('push') });

/** the service says 412 `source_control_not_connected`; n8n's public controller answers 400 */
async function whenConnected<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'source_control_not_connected') {
      throw ApiError.badRequest(error.message);
    }
    throw error;
  }
}

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
    handler: async (ctx, { auth, query, request }) => {
      if (query.direction === 'pull') await requireScope(request, 'sourceControl:pull');
      return {
        data: await whenConnected(() => ctx.sourceControlSync.status(auth, { direction: query.direction })),
      };
    },
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
    handler: async (ctx, { auth, body }) => ({
      data: await whenConnected(() => ctx.sourceControlSync.push(auth, body)),
    }),
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
    handler: async (ctx, { auth, body }) => ({
      data: await whenConnected(() => ctx.sourceControlSync.pull(auth, body)),
    }),
  },
];
