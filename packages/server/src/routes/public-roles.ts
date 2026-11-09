/**
 * Public API roles (P6-34), n8n's roles public controller: GET `/roles` and GET `/roles/:slug`
 * (`role:list`, `role:read`), POST, PUT and DELETE (`role:manage`, or `role:manageProject` for project
 * roles). PUBLIC_ROLE_ROUTES is final and shaped as PUBLIC_DATA_TABLE_ROUTES (public-api.ts spreads it and
 * runs the `access` check, then the key scope). The handlers call `ctx.roles`, the service of /rest/roles,
 * which checks the scope of the role's type again and keeps the rules of custom roles (allowed scopes, the
 * name, the reassignment on delete).
 */
import { SCOPES, type Scope } from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ApiRoute, PublicApiInput } from './public-api';
import { decodeCursor, paged } from './public-data-tables';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const MANAGE_ROLES: readonly Scope[] = ['role:manage', 'role:manageProject'];

const slugParams = z.object({ slug: z.string().min(1).max(128) });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
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

export const publicRoleHandlers: Record<'list' | 'get' | 'create' | 'update' | 'remove', Handler> = {
  list: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    // n8n lists every role in one array; the map by type is flattened in a fixed order
    const map = await ctx.roles.list(auth);
    const all = [
      ...map.global,
      ...map.project,
      ...map.workflow,
      ...map.credential,
      ...map.secretsProviderConnection,
    ];
    return paged({ count: all.length, data: all.slice(skip, skip + query.limit) }, skip, (role) => role);
  },
  get: async (ctx, { auth, params }) => ({ data: await ctx.roles.get(auth, params.slug) }),
  create: async (ctx, { auth, body }) => ({ data: await ctx.roles.create(auth, body) }),
  update: async (ctx, { auth, params, body }) => ({ data: await ctx.roles.update(auth, params.slug, body) }),
  remove: async (ctx, { auth, params, query }) => {
    await ctx.roles.delete(auth.tenant.id, params.slug, {
      reassignRoleSlug: query.reassignRoleSlug,
      actor: auth,
    });
    return { data: { ok: true } };
  },
};

const row = (name: keyof typeof publicRoleHandlers, fields: Omit<ApiRoute, 'handler' | 'tag'>): ApiRoute => ({
  ...fields,
  tag: 'Roles',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicRoleHandlers[name](ctx, input),
});

export const PUBLIC_ROLE_ROUTES: ApiRoute[] = [
  row('list', {
    method: 'GET',
    path: '/roles',
    summary: 'List the roles (system and custom, every type)',
    access: { scope: 'role:list' },
    scope: 'role:list',
    query: listQuery,
    response: 'Role',
    list: true,
  }),
  row('get', {
    method: 'GET',
    path: '/roles/:slug',
    summary: 'Get a role',
    access: { scope: 'role:read' },
    scope: 'role:read',
    params: slugParams,
    response: 'Role',
  }),
  row('create', {
    method: 'POST',
    path: '/roles',
    summary: 'Create a custom role (a project role or a global one)',
    access: { scope: MANAGE_ROLES },
    scope: 'role:manage',
    body: createBody,
    response: 'Role',
    status: 201,
  }),
  row('update', {
    method: 'PUT',
    path: '/roles/:slug',
    summary: 'Update a custom role',
    access: { scope: MANAGE_ROLES },
    scope: 'role:manage',
    params: slugParams,
    body: updateBody,
    response: 'Role',
  }),
  row('remove', {
    method: 'DELETE',
    path: '/roles/:slug',
    summary: 'Delete a custom role (reassignRoleSlug moves its members to another global role)',
    access: { scope: MANAGE_ROLES },
    scope: 'role:manage',
    params: slugParams,
    query: deleteQuery,
    response: 'Ok',
  }),
];
