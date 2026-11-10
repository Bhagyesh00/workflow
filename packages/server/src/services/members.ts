/**
 * P6-20 (L4): the members list (filters, sort, paging, status counts for callers with `user:create`) and
 * invitations (many at once, resend, copy link). Every invite path uses `inviteMany`: the REST route and
 * the public `POST /users` (L5); it keeps today's checks (`auth.assertMemberRole`, `assertGrantable` from
 * services/member-disable.ts, `auth.invite`) and calls `ctx.ssoLogin.assertInviteAllowed` first.
 * Stub from C0: every method throws until L4.
 */
import type { ServiceDeps } from '../context';
import type { Role } from '../db/schema';
import type { AuthContext } from '../http/auth';
import type { MemberListQuery, MemberListRow, MemberListStatus } from '../repositories/members-list';
import type { SessionMeta } from './auth';

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

export class MemberService {
  constructor(readonly deps: ServiceDeps) {}

  async list(_auth: AuthContext, _query: MemberListQuery): Promise<MemberListResult> {
    throw new Error('not implemented (L4)');
  }

  async inviteMany(
    _auth: AuthContext,
    _invites: MemberInvite[],
    _meta: SessionMeta,
  ): Promise<MemberInviteResult[]> {
    throw new Error('not implemented (L4)');
  }

  /** a new token and expiry, mailed again; the old link stops working */
  async resend(_auth: AuthContext, _invitationId: string): Promise<MemberInviteResult> {
    throw new Error('not implemented (L4)');
  }

  /** the same rotation, answered as a link (the token is stored hashed) */
  async inviteLink(_auth: AuthContext, _invitationId: string): Promise<{ inviteAcceptUrl: string }> {
    throw new Error('not implemented (L4)');
  }
}
