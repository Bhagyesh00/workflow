/**
 * /rest/favorites (P3-07): the signed-in user's own favorites. A favorite is a personal bookmark,
 * so a viewer may keep one (requireRole viewer); every query filters tenant and user.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireRole } from '../http/auth';
import { parse } from '../http/errors';

const resourceType = z.enum(['workflow', 'folder', 'dataTable']);
const addBody = z.object({ resourceType, resourceId: z.uuid() });
const removeParams = z.object({ resourceType, resourceId: z.uuid() });

export function registerFavoriteRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { favorites } = ctx;

  app.get('/favorites', async (request) => {
    const auth = requireRole(request, 'viewer');
    return { data: await favorites.list(auth.tenant.id, auth.user.id) };
  });

  app.post('/favorites', async (request) => {
    const auth = requireRole(request, 'viewer');
    const body = parse(addBody, request.body);
    return {
      data: await favorites.add(auth.tenant.id, auth.user.id, body.resourceType, body.resourceId),
    };
  });

  app.delete('/favorites/:resourceType/:resourceId', async (request) => {
    const auth = requireRole(request, 'viewer');
    const params = parse(removeParams, request.params);
    await favorites.remove(auth.tenant.id, auth.user.id, params.resourceType, params.resourceId);
    return { data: { ok: true } };
  });
}
