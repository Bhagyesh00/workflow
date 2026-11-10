/**
 * /rest/ldap/* (P6-12, L10): GET and PUT `/ldap/config`, POST `/ldap/test-connection` (`ldap:manage`),
 * GET `/ldap/sync` (the history) and POST `/ldap/sync` (a run) (`ldap:sync`).
 * C0 registered each with its final path and gate; the handlers throw until L10 (stub (L10)).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

export function registerLdapRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get('/ldap/config', async (request) => {
    await requireScope(request, 'ldap:manage');
    throw new Error('not implemented (L10)');
  });

  app.put('/ldap/config', async (request) => {
    await requireScope(request, 'ldap:manage');
    throw new Error('not implemented (L10)');
  });

  app.post('/ldap/test-connection', async (request) => {
    await requireScope(request, 'ldap:manage');
    throw new Error('not implemented (L10)');
  });

  app.get('/ldap/sync', async (request) => {
    await requireScope(request, 'ldap:sync');
    throw new Error('not implemented (L10)');
  });

  app.post('/ldap/sync', async (request) => {
    await requireScope(request, 'ldap:sync');
    throw new Error('not implemented (L10)');
  });
}
