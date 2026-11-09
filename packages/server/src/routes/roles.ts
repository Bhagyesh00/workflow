/**
 * /rest/roles (P6-32, L11): n8n's eight role routes. Gates as n8n's role controller: the lists and one
 * role need a signed-in member only; `/members` needs `role:read`; the writes and the assignment lists
 * need `role:manage` or `role:manageProject` (any one: the service checks the one the role's type needs).
 * C0 registered each with its final path and gate; the handlers reach `ctx.roles` (RoleService,
 * services/roles.ts, filled by L11), which checks `role:manage` for global roles and either scope for
 * project roles.
 */
import { SCOPES, type Scope } from '@workflow/workflow';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireAuth, requireScope } from '../http/auth';
import { parse } from '../http/errors';

const MANAGE_ROLES: readonly Scope[] = ['role:manage', 'role:manageProject'];

const slugParams = z.object({ slug: z.string().min(1).max(128) });
const projectParams = z.object({ slug: z.string().min(1).max(128), projectId: z.string() });
const usageQuery = z.object({
  withUsageCount: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
const scopes = z.array(z.enum(SCOPES)).max(SCOPES.length);
const createBody = z.object({
  displayName: z.string().trim().min(2).max(100),
  description: z.string().max(500).optional(),
  roleType: z.enum(['project', 'global']),
  scopes,
});
const updateBody = z.object({
  displayName: z.string().trim().min(2).max(100).optional(),
  description: z.string().max(500).optional(),
  scopes: scopes.optional(),
});
const deleteQuery = z.object({ reassignRoleSlug: z.string().min(1).max(128).optional() });

export function registerRoleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { roles } = ctx;

  app.get('/roles', async (request) => {
    const auth = requireAuth(request);
    return { data: await roles.list(auth, parse(usageQuery, request.query ?? {})) };
  });

  app.get('/roles/:slug', async (request) => {
    const auth = requireAuth(request);
    const { slug } = parse(slugParams, request.params);
    return { data: await roles.get(auth, slug, parse(usageQuery, request.query ?? {})) };
  });

  app.get('/roles/:slug/assignments', async (request) => {
    const auth = await requireScope(request, MANAGE_ROLES);
    return { data: await roles.assignments(auth, parse(slugParams, request.params).slug) };
  });

  app.get('/roles/:slug/assignments/:projectId/members', async (request) => {
    const auth = await requireScope(request, MANAGE_ROLES);
    const { slug, projectId } = parse(projectParams, request.params);
    return { data: await roles.projectMembers(auth, slug, projectId) };
  });

  app.get('/roles/:slug/members', async (request) => {
    const auth = await requireScope(request, 'role:read');
    return { data: await roles.members(auth, parse(slugParams, request.params).slug) };
  });

  app.post('/roles', async (request) => {
    const auth = await requireScope(request, MANAGE_ROLES);
    return { data: await roles.create(auth, parse(createBody, request.body)) };
  });

  app.patch('/roles/:slug', async (request) => {
    const auth = await requireScope(request, MANAGE_ROLES);
    const { slug } = parse(slugParams, request.params);
    return { data: await roles.update(auth, slug, parse(updateBody, request.body)) };
  });

  app.delete('/roles/:slug', async (request) => {
    const auth = await requireScope(request, MANAGE_ROLES);
    const { slug } = parse(slugParams, request.params);
    const query = parse(deleteQuery, request.query ?? {});
    return {
      data: await roles.delete(auth.tenant.id, slug, {
        reassignRoleSlug: query.reassignRoleSlug,
        actor: auth,
      }),
    };
  });
}
