/**
 * /rest/members and /rest/invitations (moved from routes/resources.ts in S2's C0, unchanged; P6-20, L4 owns
 * it afterwards). Resend and copy link are stubs until L4.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context';
import { requireScope } from '../http/auth';
import { ApiError, parse } from '../http/errors';
import { idParams } from '../http/schemas';
import { assertGrantable, changeMemberRole, LAST_OWNER_MESSAGE } from '../services/member-disable';
import { type MemberRemovalChoice, removeMember } from '../services/member-removal';

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

export function registerMemberRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const { repos, auth: authService, config } = ctx;

  app.get('/members', async (request) => {
    const auth = await requireScope(request, 'user:list');
    const members = await repos.memberships.listForTenant(auth.tenant.id);
    return {
      data: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
      })),
      nextCursor: null,
    };
  });

  app.post('/members/invite', async (request) => {
    const auth = await requireScope(request, 'user:create');
    const body = parse(z.object({ email: z.email().max(254), role: memberRoleSchema }), request.body);
    // stub (L6): PASSES; refused under SSO (n8n keeps the rule in the service: L4 moves this into `inviteMany`)
    await ctx.ssoLogin.assertInviteAllowed(auth.tenant.id);
    await authService.assertMemberRole(auth.tenant.id, body.role);
    await assertGrantable(ctx, auth, body.role, 'invite the member');
    const { invitation, token } = await authService.invite(
      auth.tenant.id,
      { id: auth.user.id, role: auth.role },
      body.email,
      body.role,
    );
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      ip: request.ip,
    });
    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
        // shown once: deliver it to the invitee (no mail transport is configured)
        token,
        // the editor's accept page (`/invitation/:token`)
        inviteUrl: `${config.baseUrl}/invitation/${token}`,
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

  // P6-20: a new token and expiry, sent again by mail; the old link stops working
  app.post('/invitations/:id/resend', async (request) => {
    await requireScope(request, 'user:create');
    parse(idParams, request.params);
    throw new Error('not implemented (L4)');
  });

  // P6-20: a new token and expiry, answered as the invite link (the token is stored hashed, so it rotates)
  app.post('/invitations/:id/link', async (request) => {
    await requireScope(request, 'user:generateInviteLink');
    parse(idParams, request.params);
    throw new Error('not implemented (L4)');
  });
}
