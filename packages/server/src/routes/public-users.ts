/**
 * Public API users (P6-21, L5), n8n's users public controller: GET `/users` (limit, cursor, `includeRole`,
 * `projectId`), GET `/users/:id` (by id or email), POST `/users` (an array of invites, through
 * `ctx.members.inviteMany`), DELETE `/users/:id` (`transferId`, through `removeMember`), PATCH
 * `/users/:id/role` (today's PATCH `/members/:userId` checks, then `changeMemberRole`).
 * PUBLIC_USER_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it); the handlers
 * throw until L5 (stub (L5)).
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { ApiRoute, PublicApiInput } from './public-api';

type Handler = (ctx: ServerContext, input: PublicApiInput) => Promise<unknown>;

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
  includeRole: z.stringbool().optional(),
  projectId: z.uuid().optional(),
});
/** a user id, or an email (GET only) */
const userParams = z.object({ id: z.string().min(1).max(254) });
const roleBody = z.object({ newRoleName: z.string().trim().min(1).max(64) });
const inviteBody = z
  .array(z.object({ email: z.email().max(254), role: z.string().trim().min(1).max(64).optional() }))
  .min(1)
  .max(100);
const deleteQuery = z.object({ transferId: z.uuid().optional() });

const notImplemented: Handler = async () => {
  throw new Error('not implemented (L5)');
};

export const publicUserHandlers: Record<'list' | 'get' | 'create' | 'remove' | 'changeRole', Handler> = {
  list: notImplemented,
  get: notImplemented,
  create: notImplemented,
  remove: notImplemented,
  changeRole: notImplemented,
};

const row = (name: keyof typeof publicUserHandlers, fields: Omit<ApiRoute, 'handler' | 'tag'>): ApiRoute => ({
  ...fields,
  tag: 'Users',
  /** late bound, so the handler that runs is the one in the table above */
  handler: (ctx, input) => publicUserHandlers[name](ctx, input),
});

export const PUBLIC_USER_ROUTES: ApiRoute[] = [
  row('list', {
    method: 'GET',
    path: '/users',
    summary: 'List the members of the workspace',
    access: { scope: 'user:list' },
    scope: 'user:list',
    query: listQuery,
    response: 'User',
    list: true,
  }),
  row('get', {
    method: 'GET',
    path: '/users/:id',
    summary: 'Get a member by id or email',
    access: { scope: 'user:read' },
    scope: 'user:read',
    params: userParams,
    response: 'User',
  }),
  row('create', {
    method: 'POST',
    path: '/users',
    summary: 'Invite people to the workspace',
    access: { scope: 'user:create' },
    scope: 'user:create',
    body: inviteBody,
    response: 'User',
    status: 201,
  }),
  row('remove', {
    method: 'DELETE',
    path: '/users/:id',
    summary: "Remove a member (transferId moves the member's personal work, else it is deleted)",
    access: { scope: 'user:delete' },
    scope: 'user:delete',
    params: z.object({ id: z.uuid() }),
    query: deleteQuery,
    response: 'Ok',
  }),
  row('changeRole', {
    method: 'PATCH',
    path: '/users/:id/role',
    summary: "Change a member's workspace role",
    access: { scope: 'user:changeRole' },
    scope: 'user:changeRole',
    params: z.object({ id: z.uuid() }),
    body: roleBody,
    response: 'Ok',
  }),
];
