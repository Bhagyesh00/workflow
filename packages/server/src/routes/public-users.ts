/**
 * Public API users (P6-21, L5), n8n's users public controller: GET `/users` (limit, cursor, `includeRole`,
 * `projectId`), GET `/users/:id` (by id or email), POST `/users` (an array of invites, through
 * `ctx.members.inviteMany`), DELETE `/users/:id` (`transferId`, through `removeMember`), PATCH
 * `/users/:id/role` (today's PATCH `/members/:userId` checks, then `changeMemberRole`).
 * PUBLIC_USER_ROUTES is final and shaped as PUBLIC_ROLE_ROUTES (public-api.ts spreads it).
 */
import { z } from 'zod';
import type { ServerContext } from '../context';
import type { Role } from '../db/schema';
import { ApiError } from '../http/errors';
import { assertGrantable, changeMemberRole, LAST_OWNER_MESSAGE } from '../services/member-disable';
import { type MemberRemovalChoice, removeMember } from '../services/member-removal';
import type { ApiRoute, PublicApiInput } from './public-api';
import { decodeCursor, paged } from './public-data-tables';

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
  .array(
    z.object({
      email: z.email().max(254),
      role: z.string().trim().min(1).max(64).optional(),
    }),
  )
  .min(1)
  .max(100);
const getQuery = z.object({ includeRole: z.stringbool().optional() });
const deleteQuery = z.object({ transferId: z.uuid().optional() });

/** n8n names a global role `global:member`; ours is the bare slug (a custom global slug passes as is) */
const roleSlug = (name: string): string => name.replace(/^global:/, '');

/** n8n's user fields: the one `name` of ours is split at its first space */
function userDto(
  user: {
    id: string;
    email: string;
    name: string | null;
    isPending: boolean;
    createdAt: Date | null;
  },
  role: string | undefined,
) {
  const [first = '', ...rest] = (user.name ?? '').trim().split(/\s+/);
  const at = user.createdAt ? user.createdAt.toISOString() : null;
  return {
    id: user.id,
    email: user.email,
    firstName: first || null,
    lastName: rest.join(' ') || null,
    isPending: user.isPending,
    createdAt: at,
    updatedAt: at,
    ...(role !== undefined ? { role } : {}),
  };
}

export const publicUserHandlers: Record<'list' | 'get' | 'create' | 'remove' | 'changeRole', Handler> = {
  list: async (ctx, { auth, query }) => {
    const skip = decodeCursor(query.cursor);
    const { rows, total } = await ctx.repos.membersList.list(auth.tenant.id, {
      projectId: query.projectId,
      sort: { by: 'email', dir: 'asc' },
      take: query.limit,
      skip,
    });
    // an open invitation has no join date: its own creation time stands for it
    const pending = rows.some((r) => r.kind === 'invitation')
      ? new Map((await ctx.repos.invitations.listPending(auth.tenant.id)).map((i) => [i.id, i.createdAt]))
      : new Map<string, Date>();
    return paged({ count: total, data: rows }, skip, (r) =>
      userDto(
        {
          id: r.id,
          email: r.email,
          name: r.name,
          isPending: r.kind === 'invitation',
          createdAt: r.kind === 'invitation' ? (pending.get(r.id) ?? null) : r.joinedAt,
        },
        query.includeRole ? r.role : undefined,
      ),
    );
  },

  get: async (ctx, { auth, params, query }) => {
    const includeRole = query.includeRole === true;
    const tenantId = auth.tenant.id;
    const { repos } = ctx;
    const ref: string = params.id;
    const byEmail = ref.includes('@');
    const user = byEmail
      ? await repos.users.getByEmail(ref.toLowerCase())
      : z.uuid().safeParse(ref).success
        ? await repos.users.get(ref)
        : undefined;
    const membership = user ? await repos.memberships.getIncludingDisabled(tenantId, user.id) : undefined;
    if (user && membership) {
      const dto = userDto(
        { ...user, isPending: false, createdAt: user.createdAt },
        includeRole ? membership.role : undefined,
      );
      return { data: dto };
    }
    // a person who was invited and has not joined yet
    const invitation = (await repos.invitations.listPending(tenantId)).find((i) =>
      byEmail ? i.email.toLowerCase() === ref.toLowerCase() : i.id === ref,
    );
    if (!invitation) throw ApiError.notFound('User');
    return {
      data: userDto(
        {
          id: invitation.id,
          email: invitation.email,
          name: null,
          isPending: true,
          createdAt: invitation.createdAt,
        },
        includeRole ? invitation.role : undefined,
      ),
    };
  },

  create: async (ctx, { auth, body, request }) => {
    const invites = (body as Array<{ email: string; role?: string }>).map((invite) => ({
      email: invite.email,
      role: roleSlug(invite.role ?? 'member') as Role,
    }));
    // every invite path goes through `inviteMany`: SSO or provisioning refusing invites, the role check and the grant ceiling
    const results = await ctx.members.inviteMany(auth, invites, {
      ip: request.ip,
    });
    return {
      data: results.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        isPending: true,
        emailSent: r.emailSent,
        ...(r.inviteAcceptUrl ? { inviteAcceptUrl: r.inviteAcceptUrl } : {}),
        ...(r.error ? { error: r.error } : {}),
      })),
    };
  },

  remove: async (ctx, { auth, params, query }) => {
    if (params.id === auth.user.id) throw ApiError.badRequest('Cannot delete your own user');
    // no `transferId` deletes the member's work, as n8n
    const choice: MemberRemovalChoice = query.transferId
      ? { transferToProjectId: query.transferId }
      : { deleteData: true };
    await removeMember(ctx, auth, params.id, choice);
    return { data: { ok: true } };
  },

  changeRole: async (ctx, { auth, params, body, request }) => {
    const userId: string = params.id;
    const role = roleSlug(body.newRoleName);
    const tenantId = auth.tenant.id;
    // the checks of PATCH /members/:userId, in its order
    await ctx.auth.assertMemberRole(tenantId, role);
    const target = await ctx.repos.memberships.getIncludingDisabled(tenantId, userId);
    if (!target) throw ApiError.notFound('Member');
    if ((target.role === 'owner' || role === 'owner') && auth.role !== 'owner') {
      throw ApiError.forbidden('Only owners can grant or revoke the owner role');
    }
    if (
      target.role === 'owner' &&
      role !== 'owner' &&
      (await ctx.repos.memberships.countOwners(tenantId)) <= 1
    ) {
      throw ApiError.conflict(LAST_OWNER_MESSAGE);
    }
    if (userId === auth.user.id) throw ApiError.forbidden('Cannot change your own global role');
    await assertGrantable(ctx, auth, role, 'change the role');
    await changeMemberRole(ctx, tenantId, userId, role as Role, {
      actorId: auth.user.id,
      ip: request.ip,
    });
    return { data: { ok: true } };
  },
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
    query: getQuery,
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
