/**
 * Public API folders (P3-15, P6-34), as n8n's folders public controller: the folders of a project live
 * under `/projects/:projectId/folders` (list, create) and `/projects/:projectId/folders/:folderId` (get,
 * update, delete with query `transferToFolderId`). The row's `access` is checked in public-api.ts before
 * the schemas run: `folder:list` and `folder:create` on the project, the others on the folder. The
 * handlers call the same FolderService as /rest/folders, so the name rule, tenant checks and audit are
 * shared; a folder of another project than the path's is 404.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import { ApiError, parse } from '../http/errors';
import {
  folderCreateSchema,
  folderDeleteSchema,
  folderListQuerySchema,
  folderUpdateSchema,
} from '../services/folders';
import type { ApiRoute, PublicApiInput, RouteTarget } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const actor = (input: PublicApiInput) => ({ userId: input.auth.user.id, ip: input.request.ip });

const projectParams = z.object({ projectId: z.uuid() });
const folderParams = projectParams.extend({ folderId: z.uuid() });
const publicFolderListQuery = z.object({
  parentFolderId: z.union([z.uuid(), z.literal('root')]).optional(),
  /** comma-separated tag names; a folder must have all of them */
  tags: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(512).optional(),
});
const publicFolderCreate = z.object({
  name: z.string().trim().min(1).max(128),
  parentFolderId: z.uuid().nullable().optional(),
});
const publicFolderUpdate = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  parentFolderId: z.uuid().nullable().optional(),
  /** same cap as folderUpdateSchema, which the handler re-parses with */
  tagIds: z.array(z.uuid()).max(50).optional(),
});
const publicFolderDeleteQuery = z.object({
  transferToFolderId: z.union([z.uuid(), z.literal('root')]).optional(),
});

/** the folder of the path, which must be in the path's project (else the same 404 as a missing one) */
async function folderOf(ctx: ServerContext, { auth, params }: PublicApiInput): Promise<string> {
  const row = await ctx.repos.folders.get(auth.tenant.id, params.folderId);
  if (!row || row.projectId !== params.projectId) throw ApiError.notFound('Folder');
  return row.id;
}

export const publicFolderHandlers: Record<'list' | 'create' | 'get' | 'update' | 'remove', Handler> = {
  list: (ctx, input) =>
    ctx.folders.listFor(input.auth, {
      ...parse(folderListQuerySchema, input.query),
      projectId: input.params.projectId,
    }),
  create: async (ctx, input) => {
    // the project of the path must be one of the workspace (404 otherwise); a parent folder must be in it
    const projectId = await ctx.access.targetProject(input.auth, input.params.projectId);
    const created = await ctx.folders.create(
      input.auth.tenant.id,
      { ...parse(folderCreateSchema, input.body), projectId },
      actor(input),
    );
    return { data: await ctx.folders.dtoFor(input.auth, created) };
  },
  get: async (ctx, input) => {
    const id = await folderOf(ctx, input);
    return { data: await ctx.folders.dtoFor(input.auth, await ctx.folders.get(input.auth.tenant.id, id)) };
  },
  update: async (ctx, input) => {
    const id = await folderOf(ctx, input);
    const updated = await ctx.folders.update(
      input.auth.tenant.id,
      id,
      parse(folderUpdateSchema, input.body),
      actor(input),
    );
    return { data: await ctx.folders.dtoFor(input.auth, updated) };
  },
  remove: async (ctx, input) => {
    const id = await folderOf(ctx, input);
    await ctx.folders.delete(input.auth.tenant.id, id, parse(folderDeleteSchema, input.query), actor(input));
    return { data: { ok: true } };
  },
};

const onProject: RouteTarget = ({ params }) => ({ projectId: params.projectId });
const onFolder: RouteTarget = ({ params }) => ({ folderId: params.folderId });

const row = (
  name: keyof typeof publicFolderHandlers,
  fields: Omit<ApiRoute, 'tag' | 'handler' | 'response'> & { response?: string },
): ApiRoute => ({
  ...fields,
  tag: 'Folders',
  response: fields.response ?? 'Folder',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicFolderHandlers[name](ctx, input),
});

const folders = '/projects/:projectId/folders';

export const PUBLIC_FOLDER_ROUTES: ApiRoute[] = [
  row('list', {
    method: 'GET',
    path: folders,
    summary: 'List the folders of a project',
    access: { scope: 'folder:list', target: onProject },
    scope: 'folder:list',
    params: projectParams,
    query: publicFolderListQuery,
    list: true,
  }),
  row('create', {
    method: 'POST',
    path: folders,
    summary: 'Create a folder in a project',
    access: { scope: 'folder:create', target: onProject },
    scope: 'folder:create',
    params: projectParams,
    body: publicFolderCreate,
  }),
  row('get', {
    method: 'GET',
    path: `${folders}/:folderId`,
    summary: 'Get a folder',
    access: { scope: 'folder:read', target: onFolder },
    scope: 'folder:read',
    params: folderParams,
  }),
  row('update', {
    method: 'PATCH',
    path: `${folders}/:folderId`,
    summary: 'Rename, move or tag a folder',
    access: { scope: 'folder:update', target: onFolder },
    scope: 'folder:update',
    params: folderParams,
    body: publicFolderUpdate,
  }),
  row('remove', {
    method: 'DELETE',
    path: `${folders}/:folderId`,
    summary: 'Delete a folder (transferToFolderId moves its content; omitted archives its workflows to root)',
    access: { scope: 'folder:delete', target: onFolder },
    scope: 'folder:delete',
    params: folderParams,
    query: publicFolderDeleteQuery,
    response: 'Ok',
  }),
];
