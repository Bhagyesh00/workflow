/**
 * /rest/sso/provisioning/config and /rest/sso/role-mapping-rules (P6-11, L9). The config needs
 * `provisioning:manage`; the rules `roleMappingRule:list`, `:create`, `:update` (also the move) and `:delete`.
 * C0 registered each with its final path and gate; the handlers throw until L9 (stub (L9)).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { parse } from '../http/errors';
import { idParams } from '../http/schemas';

export function registerProvisioningRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/sso/provisioning/config', async (request) => {
    await requireScope(request, 'provisioning:manage');
    throw new Error('not implemented (L9)');
  });

  app.patch('/sso/provisioning/config', async (request) => {
    await requireScope(request, 'provisioning:manage');
    throw new Error('not implemented (L9)');
  });

  app.get('/sso/role-mapping-rules', async (request) => {
    await requireScope(request, 'roleMappingRule:list');
    throw new Error('not implemented (L9)');
  });

  app.post('/sso/role-mapping-rules', async (request) => {
    await requireScope(request, 'roleMappingRule:create');
    throw new Error('not implemented (L9)');
  });

  app.post('/sso/role-mapping-rules/:id/move', async (request) => {
    await requireScope(request, 'roleMappingRule:update');
    parse(idParams, request.params);
    throw new Error('not implemented (L9)');
  });

  app.patch('/sso/role-mapping-rules/:id', async (request) => {
    await requireScope(request, 'roleMappingRule:update');
    parse(idParams, request.params);
    throw new Error('not implemented (L9)');
  });

  app.delete('/sso/role-mapping-rules/:id', async (request) => {
    await requireScope(request, 'roleMappingRule:delete');
    parse(idParams, request.params);
    throw new Error('not implemented (L9)');
  });
}
