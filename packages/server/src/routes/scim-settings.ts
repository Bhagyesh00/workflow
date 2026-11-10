/**
 * /rest/scim/* (P6-02, L13): the workspace's SCIM settings. GET and PATCH `/scim/config`, PUT
 * `/scim/deprovisioning`, POST and DELETE `/scim/token` (mint shown once, revoke), GET
 * `/scim/transfer-targets`, all `scim:manage`.
 * C0 registered each with its final path and gate; the handlers throw until L13 (stub (L13)).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

export function registerScimSettingsRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/scim/config', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });

  app.patch('/scim/config', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });

  app.put('/scim/deprovisioning', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });

  app.post('/scim/token', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });

  app.delete('/scim/token', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });

  app.get('/scim/transfer-targets', async (request) => {
    await requireScope(request, 'scim:manage');
    throw new Error('not implemented (L13)');
  });
}
