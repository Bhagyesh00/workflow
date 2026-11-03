/**
 * /rest/folders (P3-07). Every route checks access with requireRole (viewer 403 on writes) and
 * scopes by tenant (another tenant's folder is 404).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';
import { idParams } from '../http/schemas';
import {
  folderCreateSchema,
  folderDeleteSchema,
  folderListQuerySchema,
  folderUpdateSchema,
} from '../services/folders';

export function registerFolderRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { folders } = ctx;
  const actor = (request: { auth: { user: { id: string } } | null; ip: string }) => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  app.get('/folders', async (request) => {
    const auth = requireRole(request, 'viewer');
    return folders.list(auth.tenant.id, parse(folderListQuerySchema, request.query));
  });

  app.get('/folders/:id', async (request) => {
    const auth = requireRole(request, 'viewer');
    const { id } = parse(idParams, request.params);
    return { data: await folders.get(auth.tenant.id, id) };
  });

  app.post('/folders', async (request) => {
    const auth = requireRole(request, 'editor');
    const body = parse(folderCreateSchema, request.body);
    return { data: await folders.create(auth.tenant.id, body, actor(request)) };
  });

  app.patch('/folders/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(folderUpdateSchema, request.body);
    return { data: await folders.update(auth.tenant.id, id, body, actor(request)) };
  });

  app.delete('/folders/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const body = parse(folderDeleteSchema, request.body ?? {});
    await folders.delete(auth.tenant.id, id, body, actor(request));
    return { data: { ok: true } };
  });
}
