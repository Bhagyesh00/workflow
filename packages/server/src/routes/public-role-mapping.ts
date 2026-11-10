/**
 * Public API role mapping rules (P6-11, L9), n8n's role mapping rules public controller:
 * GET and POST `/role-mapping-rules`, POST `/role-mapping-rules/:id/move`, PATCH and DELETE
 * `/role-mapping-rules/:id`, with `roleMappingRule:list`, `:create`, `:update` and `:delete`.
 * PUBLIC_ROLE_MAPPING_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it); the
 * handlers call `ctx.provisioning`, which checks the expression, the role and the projects of the workspace.
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import { idParams } from '../http/schemas';
import type { ApiRoute, PublicApiInput } from './public-api';
import { decodeCursor, paged } from './public-data-tables';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const listQuery = z.object({
  type: z.enum(['instance', 'project']).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
});
const ruleBody = z.object({
  type: z.enum(['instance', 'project']),
  expression: z.string().min(1).max(2000),
  role: z.string().trim().min(1).max(128),
  projectIds: z.array(z.uuid()).max(500).optional(),
});
const rulePatch = ruleBody.partial().omit({ type: true });
const moveBody = z.object({ order: z.number().int().min(0) });

export const publicRoleMappingHandlers: Record<'list' | 'create' | 'move' | 'update' | 'remove', Handler> = {
  list: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    const all = await ctx.provisioning.listRules(auth.tenant.id, query.type);
    return paged({ count: all.length, data: all.slice(skip, skip + query.limit) }, skip, (rule) => rule);
  },
  create: async (ctx, { auth, body }) => ({
    data: await ctx.provisioning.createRule(auth.tenant.id, auth.user.id, body),
  }),
  move: async (ctx, { auth, params, body }) => {
    await ctx.provisioning.moveRule(auth.tenant.id, auth.user.id, params.id, body.order);
    return { data: await ctx.provisioning.getRule(auth.tenant.id, params.id) };
  },
  update: async (ctx, { auth, params, body }) => ({
    data: await ctx.provisioning.updateRule(auth.tenant.id, auth.user.id, params.id, body),
  }),
  remove: async (ctx, { auth, params }) => {
    await ctx.provisioning.deleteRule(auth.tenant.id, auth.user.id, params.id);
    return { data: { ok: true } };
  },
};

const row = (
  name: keyof typeof publicRoleMappingHandlers,
  fields: Omit<ApiRoute, 'handler' | 'tag'>,
): ApiRoute => ({
  ...fields,
  tag: 'RoleMappingRules',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicRoleMappingHandlers[name](ctx, input),
});

export const PUBLIC_ROLE_MAPPING_ROUTES: ApiRoute[] = [
  row('list', {
    method: 'GET',
    path: '/role-mapping-rules',
    summary: 'List the role mapping rules',
    access: { scope: 'roleMappingRule:list' },
    scope: 'roleMappingRule:list',
    query: listQuery,
    response: 'RoleMappingRule',
    list: true,
  }),
  row('create', {
    method: 'POST',
    path: '/role-mapping-rules',
    summary: 'Create a role mapping rule',
    access: { scope: 'roleMappingRule:create' },
    scope: 'roleMappingRule:create',
    body: ruleBody,
    response: 'RoleMappingRule',
    status: 201,
  }),
  row('move', {
    method: 'POST',
    path: '/role-mapping-rules/:id/move',
    summary: 'Move a role mapping rule to another place in its list',
    access: { scope: 'roleMappingRule:update' },
    scope: 'roleMappingRule:update',
    params: idParams,
    body: moveBody,
    response: 'RoleMappingRule',
  }),
  row('update', {
    method: 'PATCH',
    path: '/role-mapping-rules/:id',
    summary: 'Update a role mapping rule',
    access: { scope: 'roleMappingRule:update' },
    scope: 'roleMappingRule:update',
    params: idParams,
    body: rulePatch,
    response: 'RoleMappingRule',
  }),
  row('remove', {
    method: 'DELETE',
    path: '/role-mapping-rules/:id',
    summary: 'Delete a role mapping rule',
    access: { scope: 'roleMappingRule:delete' },
    scope: 'roleMappingRule:delete',
    params: idParams,
    response: 'Ok',
  }),
];
