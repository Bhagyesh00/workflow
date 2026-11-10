/**
 * P6-20 (L4): the members list (filters, sort, paging, status counts for callers with `user:create`) and
 * invitations (many at once, resend, copy link). Every invite path uses `inviteMany`: the REST route and
 * the public `POST /users` (L5); it keeps today's checks (`auth.assertMemberRole`, `assertGrantable` from
 * services/member-disable.ts, `auth.invite`) and calls `ctx.ssoLogin.assertInviteAllowed` first.
 *
 * An invitation's token is stored hashed, so a link can't be read back: "copy link" and "resend" both make
 * a new token and expiry, and the old link stops working (a named deviation from n8n's 90 day JWT link).
 */
import { redactSecrets } from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { Role } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { MemberListQuery, MemberListRow, MemberListStatus } from '../repositories/members-list';
import { randomToken, type SessionMeta, sha256 } from './auth';
import { assertGrantable } from './member-disable';

/** how long a new or resent invitation works (as `AuthService.invite`) */
const INVITATION_TTL_MS = 7 * 86_400_000;

export interface MemberListResult {
  count: number;
  items: MemberListRow[];
  /** only for callers with `user:create` */
  statusCounts?: Record<MemberListStatus, number>;
}

export interface MemberInvite {
  email: string;
  role: Role;
}

/** one row of a many-invite answer; `inviteAcceptUrl` hidden when mail worked and links are email only */
export interface MemberInviteResult {
  id: string | null;
  email: string;
  role: Role;
  emailSent: boolean;
  inviteAcceptUrl?: string;
  error: string | null;
}

/** one invitation made or renewed, with the one-time token (the single-object route answers it as before) */
export interface MemberInviteDetail {
  result: MemberInviteResult;
  token: string;
  expiresAt: Date;
}

export class MemberService {
  constructor(readonly deps: ServiceDeps) {}

  async list(auth: AuthContext, query: MemberListQuery): Promise<MemberListResult> {
    const ctx = this.deps.context();
    const scopes = await ctx.access.scopesForAuth(auth);
    const canSeeStatus = scopes.has('user:create');
    // a status filter and the counts belong to the people who manage invitations
    if (query.status !== undefined && !canSeeStatus) {
      throw ApiError.forbidden('User is missing a scope required to perform this action');
    }
    const { rows, total } = await this.deps.repos.membersList.list(auth.tenant.id, query);
    const result: MemberListResult = { count: total, items: rows };
    if (canSeeStatus) {
      const { status: _status, sort: _sort, take: _take, skip: _skip, ...filters } = query;
      result.statusCounts = await this.deps.repos.membersList.statusCounts(auth.tenant.id, filters);
    }
    return result;
  }

  /**
   * Invites every row; a row that fails answers its own `error` and the others still go. SSO or workspace
   * provisioning refusing invites fails the whole call before any row.
   */
  async inviteMany(
    auth: AuthContext,
    invites: MemberInvite[],
    meta: SessionMeta,
  ): Promise<MemberInviteResult[]> {
    await this.deps.context().ssoLogin.assertInviteAllowed(auth.tenant.id);
    const results: MemberInviteResult[] = [];
    // a repeat of an email would find the invitation the first row just made and kill its link
    const seen = new Set<string>();
    for (const invite of invites) {
      const email = invite.email.trim().toLowerCase();
      if (seen.has(email)) {
        results.push({
          id: null,
          email,
          role: invite.role,
          emailSent: false,
          error: 'This email is already in the list',
        });
        continue;
      }
      seen.add(email);
      try {
        results.push((await this.inviteRow(auth, invite, meta)).result);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        results.push({
          id: null,
          email: invite.email.trim().toLowerCase(),
          role: invite.role,
          emailSent: false,
          error: redactSecrets(error.message),
        });
      }
    }
    return results;
  }

  /** one invitation; a refusal throws its own status (the single-object route keeps today's answers) */
  async inviteOne(auth: AuthContext, invite: MemberInvite, meta: SessionMeta): Promise<MemberInviteDetail> {
    await this.deps.context().ssoLogin.assertInviteAllowed(auth.tenant.id);
    return this.inviteRow(auth, invite, meta);
  }

  /** a new token and expiry, mailed again; the old link stops working */
  async resend(auth: AuthContext, invitationId: string, meta: SessionMeta = {}): Promise<MemberInviteResult> {
    const ctx = this.deps.context();
    await ctx.ssoLogin.assertInviteAllowed(auth.tenant.id);
    const renewed = await this.renew(auth, invitationId, 'resend the invitation');
    const result = await this.deliver(auth, renewed.invitation, renewed.token);
    await this.deps.repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'invitation.resent',
      resourceType: 'invitation',
      resourceId: renewed.invitation.id,
      metadata: { email: renewed.invitation.email, role: renewed.invitation.role },
      ip: meta.ip,
    });
    return result;
  }

  /** the same rotation, answered as a link (the token is stored hashed) */
  async inviteLink(auth: AuthContext, invitationId: string): Promise<{ inviteAcceptUrl: string }> {
    await this.deps.context().ssoLogin.assertInviteAllowed(auth.tenant.id);
    const renewed = await this.renew(auth, invitationId, 'copy the invitation link');
    return { inviteAcceptUrl: this.acceptUrl(renewed.token) };
  }

  // -------------------------------------------------------------------------------------------

  private acceptUrl(token: string): string {
    return `${this.deps.config.baseUrl}/invitation/${token}`;
  }

  private async assertNotMember(tenantId: string, email: string): Promise<void> {
    const existing = await this.deps.repos.users.getByEmail(email);
    if (existing && (await this.deps.repos.memberships.getIncludingDisabled(tenantId, existing.id))) {
      throw ApiError.conflict('This user is already a member of the workspace');
    }
  }

  private async inviteRow(
    auth: AuthContext,
    invite: MemberInvite,
    meta: SessionMeta,
  ): Promise<MemberInviteDetail> {
    const ctx = this.deps.context();
    const { repos } = this.deps;
    const email = invite.email.trim().toLowerCase();
    await ctx.auth.assertMemberRole(auth.tenant.id, invite.role);
    await assertGrantable(ctx, auth, invite.role, 'invite the member');
    if (invite.role === 'owner' && auth.role !== 'owner') {
      throw ApiError.forbidden('Only owners can invite owners');
    }
    await this.assertNotMember(auth.tenant.id, email);
    // inviting a pending person again sends it again: a new token, and the old link dies
    const openId = await repos.membersList.findOpenInvitationId(auth.tenant.id, email);
    const open = openId ? await repos.invitations.get(auth.tenant.id, openId) : undefined;
    let invitation: NonNullable<typeof open>;
    let token: string;
    if (open && open.role === invite.role) {
      token = randomToken();
      const rotated = await repos.invitations.rotate(
        auth.tenant.id,
        open.id,
        sha256(token),
        new Date(Date.now() + INVITATION_TTL_MS),
      );
      if (!rotated) throw ApiError.notFound('Invitation');
      invitation = rotated;
    } else {
      // a different role is a different invitation: the old one goes, so only the new link works
      if (open) await repos.invitations.delete(auth.tenant.id, open.id);
      const created = await ctx.auth.invite(
        auth.tenant.id,
        { id: auth.user.id, role: auth.role },
        email,
        invite.role,
      );
      invitation = created.invitation;
      token = created.token;
    }
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { email: invitation.email, role: invitation.role },
      ip: meta.ip,
    });
    const result = await this.deliver(auth, invitation, token);
    return { result, token, expiresAt: invitation.expiresAt };
  }

  /** rotates the token of an open invitation the caller may still hand out */
  private async renew(auth: AuthContext, invitationId: string, action: string) {
    const ctx = this.deps.context();
    const found = await this.deps.repos.invitations.get(auth.tenant.id, invitationId);
    if (!found || found.acceptedAt) throw ApiError.notFound('Invitation');
    // a link to a wider role than the caller holds would be a way up
    await assertGrantable(ctx, auth, found.role, action);
    if (found.role === 'owner' && auth.role !== 'owner') {
      throw ApiError.forbidden('Only owners can invite owners');
    }
    const token = randomToken();
    const invitation = await this.deps.repos.invitations.rotate(
      auth.tenant.id,
      found.id,
      sha256(token),
      new Date(Date.now() + INVITATION_TTL_MS),
    );
    if (!invitation) throw ApiError.notFound('Invitation');
    return { invitation, token };
  }

  /** mails the link when mail is set up; the link is answered unless mail worked and links are email only */
  private async deliver(
    auth: AuthContext,
    invitation: { id: string; email: string; role: Role },
    token: string,
  ): Promise<MemberInviteResult> {
    const { mailer } = this.deps.context();
    const url = this.acceptUrl(token);
    let emailSent = false;
    let error: string | null = null;
    if (mailer.isConfigured()) {
      try {
        emailSent = (
          await mailer.sendInvite(invitation.email, {
            workspaceName: auth.tenant.name,
            inviterName: auth.user.name || auth.user.email,
            role: invitation.role,
            inviteUrl: url,
          })
        ).sent;
      } catch (cause) {
        error = redactSecrets(
          `Couldn't send the invitation email: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const hideLink = emailSent && this.deps.config.inviteLinksEmailOnly;
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      emailSent,
      ...(hideLink ? {} : { inviteAcceptUrl: url }),
      error,
    };
  }
}
