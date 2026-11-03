/**
 * /rest/annotation-tags (P3-09). Every route checks access with requireRole (viewer reads, editor
 * writes; a viewer gets 403 on writes) and scopes by tenant (another tenant tag is 404).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
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
    const auth = requireRole(request, 'viewer');
    const { withUsageCount } = parse(listQuery, request.query);
    return { data: await annotations.listTags(auth.tenant.id, withUsageCount === 'true'), nextCursor: null };
  });

  app.post('/annotation-tags', async (request) => {
    const auth = requireRole(request, 'editor');
    const { name } = parse(annotationTagSchema, request.body);
    return { data: await annotations.createTag(auth.tenant.id, name, actor(request)) };
  });

  app.patch('/annotation-tags/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    const { name } = parse(annotationTagSchema, request.body);
    return { data: await annotations.renameTag(auth.tenant.id, id, name, actor(request)) };
  });

  app.delete('/annotation-tags/:id', async (request) => {
    const auth = requireRole(request, 'editor');
    const { id } = parse(idParams, request.params);
    await annotations.deleteTag(auth.tenant.id, id, actor(request));
    return { data: { ok: true } };
  });
}
