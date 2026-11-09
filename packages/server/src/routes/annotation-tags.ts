/**
 * /rest/annotation-tags (P3-09). Annotation tags belong to the workspace, not to a project: every route checks
 * a global scope (P6-25, n8n's `annotationTag:*`, held by owner, admin and member) and scopes by tenant
 * (another tenant tag is 404).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';
import { idParams } from '../http/schemas';

export const annotationTagSchema = z.object({ name: z.string().trim().min(1).max(24) });
const listQuery = z.object({ withUsageCount: z.enum(['true', 'false']).optional() });

export function registerAnnotationTagRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { annotations } = ctx;
  const actor = (request: { auth: { user: { id: string } } | null; ip: string }) => ({
    userId: request.auth?.user.id,
    ip: request.ip,
  });

  app.get('/annotation-tags', async (request) => {
    const auth = await requireScope(request, 'annotationTag:list');
    const { withUsageCount } = parse(listQuery, request.query);
    return { data: await annotations.listTags(auth.tenant.id, withUsageCount === 'true'), nextCursor: null };
  });

  app.post('/annotation-tags', async (request) => {
    const auth = await requireScope(request, 'annotationTag:create');
    const { name } = parse(annotationTagSchema, request.body);
    return { data: await annotations.createTag(auth.tenant.id, name, actor(request)) };
  });

  app.patch('/annotation-tags/:id', async (request) => {
    const auth = await requireScope(request, 'annotationTag:update');
    const { id } = parse(idParams, request.params);
    const { name } = parse(annotationTagSchema, request.body);
    return { data: await annotations.renameTag(auth.tenant.id, id, name, actor(request)) };
  });

  app.delete('/annotation-tags/:id', async (request) => {
    const auth = await requireScope(request, 'annotationTag:delete');
    const { id } = parse(idParams, request.params);
    await annotations.deleteTag(auth.tenant.id, id, actor(request));
    return { data: { ok: true } };
  });
}
