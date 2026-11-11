/**
 * /rest workflow collaboration (P6-81, L14), as n8n's collaboration service: POST `/workflows/:id/presence`
 * (open, heartbeat, close; `workflow:read` on the workflow) and POST `/workflows/:id/write-access` (request,
 * force, release, heartbeat; `workflow:update` on the workflow). The editor tab names itself with the `push-ref`
 * header (allowed by the CORS preflight in app.ts); a call without it is a 400. Every answer is the
 * `{ data: { collaborators, writeLock } }` of `ctx.collaboration`, keyed by the caller's workspace; a workflow
 * of another workspace is 404.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { type AuthContext, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';
import type { CollaborationUser } from '../services/collaboration';

const presenceBody = z.object({ action: z.enum(['open', 'heartbeat', 'close']) });
const writeAccessBody = z.object({ action: z.enum(['request', 'force', 'release', 'heartbeat']) });

/** the caller as a collaborator (the name splits into first and last) */
function collaboratorOf(auth: AuthContext): CollaborationUser {
  const [firstName = '', ...rest] = auth.user.name.trim().split(/\s+/);
  return { id: auth.user.id, email: auth.user.email, firstName, lastName: rest.join(' ') };
}

/** the tab's id: the `push-ref` header, 1 to 128 visible characters */
function clientIdOf(request: FastifyRequest): string {
  const raw = request.headers['push-ref'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value || value.length > 128) throw ApiError.badRequest('The push-ref header is required');
  return value;
}

export function registerCollaborationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { collaboration } = ctx;

  /** the gate: the scope on the workflow, then the workflow must be in the caller's workspace */
  const gate = async (request: FastifyRequest, scope: 'workflow:read' | 'workflow:update') => {
    const { id } = parse(idParams, request.params);
    const auth = await requireScope(request, scope, { workflowId: id });
    if (!(await ctx.repos.workflows.get(auth.tenant.id, id))) throw ApiError.notFound('Workflow');
    return { auth, id, clientId: clientIdOf(request) };
  };

  app.post('/workflows/:id/presence', async (request) => {
    const { auth, id, clientId } = await gate(request, 'workflow:read');
    const { action } = parse(presenceBody, request.body);
    const tenantId = auth.tenant.id;
    const user = collaboratorOf(auth);
    if (action === 'close') return { data: await collaboration.closed(tenantId, id, user.id, clientId) };
    if (action === 'heartbeat') return { data: await collaboration.heartbeat(tenantId, id, user, clientId) };
    return { data: await collaboration.opened(tenantId, id, user, clientId) };
  });

  app.post('/workflows/:id/write-access', async (request) => {
    const { auth, id, clientId } = await gate(request, 'workflow:update');
    const { action } = parse(writeAccessBody, request.body);
    const tenantId = auth.tenant.id;
    const user = collaboratorOf(auth);
    if (action === 'release') return { data: await collaboration.release(tenantId, id, user.id, clientId) };
    if (action === 'heartbeat') return { data: await collaboration.heartbeat(tenantId, id, user, clientId) };
    return {
      data: await collaboration.requestWrite(tenantId, id, user, clientId, { force: action === 'force' }),
    };
  });
}
