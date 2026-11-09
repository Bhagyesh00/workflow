/**
 * /rest/projects (P6-03, L1): n8n's 12 project routes. C0 registers each with its final path and gate;
 * the handlers reach `ctx.projects`, a stub that throws until L1. Gates as n8n's project controller: no
 * scope on the caller's own lists (any signed-in member), `user:list` on sharing candidates,
 * `project:create` (global), and the project's own `project:read`, `project:update`,
 * `project:manageMembers`, `project:delete` (the target is looked up first: another workspace's id is 404).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';

const projectParams = z.object({ projectId: z.string() });
const userParams = z.object({ projectId: z.string(), userId: z.uuid() });

const icon = z.object({ type: z.enum(['icon', 'emoji']), value: z.string().min(1).max(64) });
const listQuery = z.object({
  take: z.coerce.number().int().min(0).max(1000).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});
const createBody = z.object({
  name: z.string().trim().min(1).max(255),
  icon: icon.nullable().optional(),
  description: z.string().max(512).nullable().optional(),
});
/** the PATCH body (L1 owns it; S3's P6-67 adds its field) */
export const projectPatchBody = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  icon: icon.nullable().optional(),
  description: z.string().max(512).nullable().optional(),
});
const relation = z.object({ userId: z.uuid(), role: z.string().min(1).max(128) });
const addUsersBody = z.object({ relations: z.array(relation).max(1000) });
const roleBody = z.object({ role: z.string().min(1).max(128) });
const deleteQuery = z.object({ transferId: z.uuid().optional() });

export function registerProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { projects } = ctx;

  app.get('/projects', async (request) => {
    const auth = requireAuth(request);
    return { data: await projects.list(auth, parse(listQuery, request.query ?? {})) };
  });

  app.get('/projects/count', async (request) => {
    const auth = requireAuth(request);
    return { data: await projects.count(auth) };
  });

  app.get('/projects/sharing-candidates', async (request) => {
    const auth = await requireScope(request, 'user:list');
    return { data: await projects.sharingCandidates(auth) };
  });

  app.post('/projects', async (request) => {
    const auth = await requireScope(request, 'project:create');
    return { data: await projects.create(auth, parse(createBody, request.body)) };
  });

  app.get('/projects/my-projects', async (request) => {
    const auth = requireAuth(request);
    return { data: await projects.myProjects(auth) };
  });

  app.get('/projects/personal', async (request) => {
    const auth = requireAuth(request);
    return { data: await projects.personal(auth) };
  });

  app.get('/projects/:projectId', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:read', { projectId });
    return { data: await projects.get(auth, projectId) };
  });

  app.patch('/projects/:projectId', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:update', { projectId });
    return { data: await projects.update(auth, projectId, parse(projectPatchBody, request.body)) };
  });

  app.post('/projects/:projectId/users', async (request, reply) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:manageMembers', { projectId });
    const body = parse(addUsersBody, request.body);
    const { added, conflicts } = await projects.addUsers(auth, projectId, body.relations);
    if (added > 0) return reply.status(201).send({ data: { conflicts } });
    if (conflicts.length > 0) {
      throw ApiError.conflict('No users were added: they are already members of this project', { conflicts });
    }
    return { data: { conflicts } };
  });

  app.patch('/projects/:projectId/users/:userId', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:manageMembers', { projectId });
    const { userId } = parse(userParams, request.params);
    await projects.changeUserRole(auth, projectId, userId, parse(roleBody, request.body).role);
    return { data: { ok: true } };
  });

  app.delete('/projects/:projectId/users/:userId', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:manageMembers', { projectId });
    const { userId } = parse(userParams, request.params);
    await projects.removeUser(auth, projectId, userId);
    return { data: { ok: true } };
  });

  app.delete('/projects/:projectId', async (request) => {
    const { projectId } = parse(projectParams, request.params);
    const auth = await requireScope(request, 'project:delete', { projectId });
    await projects.delete(auth, projectId, parse(deleteQuery, request.query ?? {}));
    return { data: { ok: true } };
  });
}
