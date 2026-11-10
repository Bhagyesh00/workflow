/**
 * /rest/members and /rest/invitations (moved from routes/resources.ts in S2's C0; P6-20, L4 owns it): the
 * filtered list, invite (one or many), resend and copy link. The invite logic is in services/members.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';
import type { MemberListRow } from '../repositories/members-list';
import { assertGrantable, changeMemberRole, LAST_OWNER_MESSAGE } from '../services/member-disable';
import { type MemberRemovalChoice, removeMember } from '../services/member-removal';
import type { MemberInviteResult } from '../services/members';

/** a workspace role in a member route: a system role or a custom global slug (checked against the roles) */
export const memberRoleSchema = z.string().trim().min(1).max(64);

/**
 * DELETE /members/:userId: what happens to the member's personal work. The editor sends the choice in the
 * body; n8n's `?transferId=` also works. No choice (or both) is a 400.
 */
export const removalBodySchema = z
  .object({ transferToProjectId: z.uuid().optional(), deleteData: z.literal(true).optional() })
  .nullish();
export const removalQuerySchema = z.object({ transferId: z.uuid().optional() });

export function removalChoice(body: unknown, query: unknown): MemberRemovalChoice {
  const fromBody = parse(removalBodySchema, body) ?? {};
  const { transferId } = parse(removalQuerySchema, query ?? {});
  const transferTo = fromBody.transferToProjectId ?? transferId;
  if (transferTo !== undefined && fromBody.deleteData) {
    throw ApiError.badRequest("Choose one: move the member's work to a project or delete it");
  }
  if (transferTo !== undefined) return { transferToProjectId: transferTo };
  if (fromBody.deleteData) return { deleteData: true };
  throw ApiError.badRequest(
    "Say what happens to the member's work: send transferToProjectId to move it to a project, or deleteData: true to delete it",
  );
}

const inviteSchema = z.object({ email: z.email().max(254), role: memberRoleSchema });
/** one object (today's body) or a list of up to 100 */
const inviteBodySchema = z.union([inviteSchema, z.array(inviteSchema).min(1).max(100)]);

/** the sort names a list may use; anything else is a 400 */
const SORT_FIELDS = ['name', 'email', 'role', 'mfaEnabled', 'lastActiveAt'] as const;
const memberListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  role: memberRoleSchema.optional(),
  projectId: z.uuid().optional(),
  status: z.enum(['active', 'pending', 'disabled']).optional(),
  sort: z
    .string()
    .regex(/^[A-Za-z]+(:(asc|desc))?$/)
    .transform((value, issue) => {
      const [by, dir] = value.split(':');
      if (!(SORT_FIELDS as readonly string[]).includes(by)) {
        issue.addIssue({ code: 'custom', message: `Sort by one of: ${SORT_FIELDS.join(', ')}` });
        return z.NEVER;
      }
      return {
        by: by as (typeof SORT_FIELDS)[number],
        dir: dir === 'desc' ? ('desc' as const) : ('asc' as const),
      };
    })
    .optional(),
  take: z.coerce.number().int().min(1).max(1000).default(1000),
  skip: z.coerce.number().int().min(0).default(0),
});

/** a list row as the editor's `Member`; a pending row's `userId` is its invitation id */
function memberDto(row: MemberListRow) {
  return {
    userId: row.id,
    ...(row.kind === 'invitation' ? { invitationId: row.id } : {}),
    email: row.email,
    name: row.name ?? '',
    role: row.role,
    joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
    status: row.status,
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    mfaEnabled: row.mfaEnabled,
    managedByScim: row.managedByScim,
    allowSsoManualLogin: row.allowSsoManualLogin,
  };
}

function inviteRowDto(row: MemberInviteResult) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    emailSent: row.emailSent,
    ...(row.inviteAcceptUrl ? { inviteAcceptUrl: row.inviteAcceptUrl } : {}),
    error: row.error ?? '',
  };
}

export function registerMemberRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, auth: authService } = ctx;

  app.get('/members', async (request) => {
    const auth = await requireScope(request, 'user:list');
    const query = parse(memberListQuerySchema, request.query ?? {});
    const page = await ctx.members.list(auth, {
      q: query.q,
      role: query.role,
      projectId: query.projectId,
      status: query.status,
      sort: query.sort,
      take: query.take,
      skip: query.skip,
    });
    return {
      data: page.items.map(memberDto),
      nextCursor: null,
      count: page.count,
      ...(page.statusCounts ? { statusCounts: page.statusCounts } : {}),
    };
  });

  // a single object keeps the answer the editor and the API tests know (token and inviteUrl, once); an array
  // answers one row per invitation
  app.post('/members/invite', async (request) => {
    const auth = await requireScope(request, 'user:create');
    const body = parse(inviteBodySchema, request.body);
    const meta = { ip: request.ip };
    if (Array.isArray(body)) {
      const rows = await ctx.members.inviteMany(auth, body, meta);
      return { data: rows.map(inviteRowDto) };
    }
    const { result, token, expiresAt } = await ctx.members.inviteOne(auth, body, meta);
    return {
      data: {
        id: result.id,
        email: result.email,
        role: result.role,
        expiresAt: expiresAt.toISOString(),
        emailSent: result.emailSent,
        // shown once; left out when the mail went out and links are email only
        ...(result.inviteAcceptUrl ? { token, inviteUrl: result.inviteAcceptUrl } : {}),
      },
    };
  });

  app.patch('/members/:userId', async (request) => {
    const auth = await requireScope(request, 'user:changeRole');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    const { role } = parse(z.object({ role: memberRoleSchema }), request.body);
    await authService.assertMemberRole(auth.tenant.id, role);
    // a disabled member keeps a role that can be changed
    const target = await repos.memberships.getIncludingDisabled(auth.tenant.id, userId);
    if (!target) throw ApiError.notFound('Member');
    if ((target.role === 'owner' || role === 'owner') && auth.role !== 'owner') {
      throw ApiError.forbidden('Only owners can grant or revoke the owner role');
    }
    if (
      target.role === 'owner' &&
      role !== 'owner' &&
      (await repos.memberships.countOwners(auth.tenant.id)) <= 1
    ) {
      throw ApiError.conflict(LAST_OWNER_MESSAGE);
    }
    // as n8n (after the last owner check, so the only owner still hears why)
    if (userId === auth.user.id) throw ApiError.forbidden('Cannot change your own global role');
    await assertGrantable(ctx, auth, role, 'change the role');
    await changeMemberRole(ctx, auth.tenant.id, userId, role, { actorId: auth.user.id, ip: request.ip });
    return { data: { userId, role } };
  });

  app.delete('/members/:userId', async (request) => {
    const auth = await requireScope(request, 'user:delete');
    const { userId } = parse(z.object({ userId: z.uuid() }), request.params);
    // a disabled member can still be removed
    if (!(await repos.memberships.getIncludingDisabled(auth.tenant.id, userId)))
      throw ApiError.notFound('Member');
    await removeMember(ctx, auth, userId, removalChoice(request.body, request.query));
    return { data: { ok: true } };
  });

  app.get('/invitations', async (request) => {
    const auth = await requireScope(request, 'user:create');
    const rows = await repos.invitations.listPending(auth.tenant.id);
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  app.delete('/invitations/:id', async (request) => {
    const auth = await requireScope(request, 'user:create');
    const { id } = parse(idParams, request.params);
    if (!(await repos.invitations.delete(auth.tenant.id, id))) throw ApiError.notFound('Invitation');
    return { data: { ok: true } };
  });

  // a new token and expiry, sent again by mail; the old link stops working
  app.post('/invitations/:id/resend', async (request) => {
    const auth = await requireScope(request, 'user:create');
    const { id } = parse(idParams, request.params);
    return { data: inviteRowDto(await ctx.members.resend(auth, id, { ip: request.ip })) };
  });

  // a new token and expiry, answered as the invite link (the token is stored hashed, so it rotates)
  app.post('/invitations/:id/link', async (request) => {
    const auth = await requireScope(request, 'user:generateInviteLink');
    const { id } = parse(idParams, request.params);
    const { inviteAcceptUrl } = await ctx.members.inviteLink(auth, id);
    return { data: { link: inviteAcceptUrl } };
  });
}
