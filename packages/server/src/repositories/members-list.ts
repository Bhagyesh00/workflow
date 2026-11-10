/**
 * P6-20 (L4): the members page query: members and pending invitations with filters, sort and paging
 * (n8n's users list filter). Stub from C0; L4 fills it.
 */
import type { DbOrTx } from '../db/client';
import type { Role } from '../db/schema';

export type MemberListSort = 'name' | 'email' | 'role' | 'mfaEnabled' | 'lastActiveAt';
export type MemberListStatus = 'active' | 'pending' | 'disabled';

export interface MemberListQuery {
  q?: string;
  role?: Role;
  projectId?: string;
  /** only for callers with `user:create` (the service checks) */
  status?: MemberListStatus;
  sort?: { by: MemberListSort; dir: 'asc' | 'desc' };
  take: number;
  skip: number;
}

export interface MemberListRow {
  /** the user id, or the invitation id for a pending row */
  id: string;
  kind: 'member' | 'invitation';
  email: string;
  name: string | null;
  role: Role;
  status: MemberListStatus;
  mfaEnabled: boolean;
  lastActiveAt: Date | null;
  allowSsoManualLogin: boolean;
  /** P6-02: managed by this workspace's SCIM client */
  managedByScim: boolean;
  joinedAt: Date | null;
}

export class MembersListRepository {
  constructor(protected readonly db: DbOrTx) {}

  async list(_tenantId: string, _query: MemberListQuery): Promise<{ rows: MemberListRow[]; total: number }> {
    throw new Error('not implemented (L4)');
  }

  /** how many rows each status has, under the same filters but status */
  async statusCounts(
    _tenantId: string,
    _query: Omit<MemberListQuery, 'status' | 'sort' | 'take' | 'skip'>,
  ): Promise<Record<MemberListStatus, number>> {
    throw new Error('not implemented (L4)');
  }
}
