/**
 * /rest workflow collaboration (P6-81, L14), as n8n's collaboration service: POST `/workflows/:id/presence`
 * (open, heartbeat, close; `workflow:read` on the workflow) and POST `/workflows/:id/write-access` (request,
 * force, release, heartbeat; `workflow:update` on the workflow). The editor tab names itself with the `push-ref`
 * header (allowed by the CORS preflight in app.ts). Paths and scope gates are final; each handler is a stub
 * until L14 fills it through `ctx.collaboration`.
 */
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';

export function registerCollaborationRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.post('/workflows/:id/presence', async (request) => {
    const { id } = request.params as { id: string };
    await requireScope(request, 'workflow:read', { workflowId: id });
    // stub (L14)
    throw new Error('not implemented (L14)');
  });

  app.post('/workflows/:id/write-access', async (request) => {
    const { id } = request.params as { id: string };
    await requireScope(request, 'workflow:update', { workflowId: id });
    // stub (L14)
    throw new Error('not implemented (L14)');
  });
}
