/**
 * /rest/consent/* (P5-14, filled by L10): the consent page's two calls, behind the session and CSRF
 * checks of every `/rest` route. A signed-in user is enough here; the service checks the membership in
 * the flow token's tenant, whatever the session's current tenant (else 403).
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireAuth } from '../http/auth';

export function registerMcpConsentRoutes(rest: FastifyInstance, _ctx: ServerContext): void {
  /** `?flow=<token>`: client name, workspace, resource, scopes, redirect host */
  rest.get('/consent/details', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L10)');
  });

  /** `{ flow, approved, scopes? }`: `{ data: { redirectUrl } }` */
  rest.post('/consent/approve', async (request) => {
    requireAuth(request);
    throw new Error('not implemented (L10)');
  });
}
