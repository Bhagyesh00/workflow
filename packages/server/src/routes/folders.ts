/**
 * /rest/folders (P3-07, P6-26). Every route checks a `folder:*` scope (on the folder, or on the project
 * for a create) and scopes by tenant (another tenant's folder is 404; a folder of a project the caller
 * is not in is 403). Rows carry their project and the caller's `scopes`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';
import {
  folderCreateSchema,
  folderDeleteSchema,
  folderListQuerySchema,
  folderUpdateSchema,
} from '../services/folders';

/** P6-26: the project filter and `includeScopes`, as the other list routes take them */
const listQuery = folderListQuerySchema.extend({
  projectId: z.uuid().optional(),
  onlySharedWithMe: z.stringbool().optional(),
  includeScopes: z.stringbool().optional(),
});
const createBody = folderCreateSchema.extend({ projectId: z.uuid().nullish() });
/** the project and parent a create route names (the gate reads them before the body is parsed) */
const createPeek = z.object({
  projectId: z.uuid().nullish(),
  parentFolderId: z.uuid().nullish(),
});

export function registerFolderRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { folders } = ctx;
  const actor = (request: { auth: { user: { id: string } } | null; ip: string }) => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  const onFolder = async (
    request: FastifyRequest,
    scope: 'folder:read' | 'folder:update' | 'folder:delete',
  ) => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, scope, { folderId: id });
    return { auth, id };
  };

  /** the project a new folder goes to: the parent's (a named project must be the same), else the named one, else the default */
  const createTarget = async (request: FastifyRequest): Promise<{ auth: AuthContext; projectId: string }> => {
    requireAuth(request);
    const peek = createPeek.safeParse(request.body ?? {});
    const named = peek.success ? peek.data.projectId : undefined;
    const parentId = peek.success ? peek.data.parentFolderId : undefined;
    let projectId: string;
    if (parentId) {
      const parent = await ctx.repos.folders.get(requireAuth(request).tenant.id, parentId);
      if (!parent) throw ApiError.notFound('Folder');
      if (named && named !== parent.projectId) {
        throw ApiError.badRequest('The parent folder belongs to another project.');
      }
      projectId = parent.projectId;
    } else {
      projectId = await ctx.access.targetProject(requireAuth(request), named);
    }
    const auth = await requireScope(request, 'folder:create', { projectId });
    return { auth, projectId };
  };

  app.get('/folders', async (request) => {
    // no scope on the route (as n8n): `listFor` narrows the rows to the caller's `folder:list` access filter
    const auth = requireAuth(request);
    return folders.listFor(auth, parse(listQuery, request.query));
  });

  app.get('/folders/:id', async (request) => {
    const { auth, id } = await onFolder(request, 'folder:read');
    return { data: await folders.dtoFor(auth, await folders.get(auth.tenant.id, id)) };
  });

  app.post('/folders', async (request) => {
    const { auth, projectId } = await createTarget(request);
    const { projectId: _ignored, ...body } = parse(createBody, request.body);
    const created = await folders.create(auth.tenant.id, { ...body, projectId }, actor(request));
    return { data: await folders.dtoFor(auth, created) };
  });

  app.patch('/folders/:id', async (request) => {
    const { auth, id } = await onFolder(request, 'folder:update');
    const body = parse(folderUpdateSchema, request.body);
    const updated = await folders.update(auth.tenant.id, id, body, actor(request));
    return { data: await folders.dtoFor(auth, updated) };
  });

  app.delete('/folders/:id', async (request) => {
    const { auth, id } = await onFolder(request, 'folder:delete');
    const body = parse(folderDeleteSchema, request.body ?? {});
    await folders.delete(auth.tenant.id, id, body, actor(request));
    return { data: { ok: true } };
  });
}
