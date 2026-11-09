/**
 * /rest/favorites (P3-07, P6-26): the signed-in user's own favorites. A favorite is a personal bookmark, so any
 * signed-in user may keep one, but adding needs the read scope on the target (checked in the service) and the
 * list leaves out what the caller can no longer read; every query filters tenant and user.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';
import { parse } from '../http/errors';

const resourceType = z.enum(['workflow', 'folder', 'dataTable', 'project']);
const addBody = z.object({ resourceType, resourceId: z.uuid() });
const removeParams = z.object({ resourceType, resourceId: z.uuid() });

export function registerFavoriteRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { favorites } = ctx;

  app.get('/favorites', async (request) => {
    const auth = requireAuth(request);
    return { data: await favorites.list(auth) };
  });

  app.post('/favorites', async (request) => {
    const auth = requireAuth(request);
    const body = parse(addBody, request.body);
    return { data: await favorites.add(auth, body.resourceType, body.resourceId) };
  });

  app.delete('/favorites/:resourceType/:resourceId', async (request) => {
    const auth = requireAuth(request);
    const params = parse(removeParams, request.params);
    await favorites.remove(auth.tenant.id, auth.user.id, params.resourceType, params.resourceId);
    return { data: { ok: true } };
  });
}
