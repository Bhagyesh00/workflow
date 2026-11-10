/**
 * P6-20 (L4): the members page query: members and open invitations with filters, sort and paging
 * (n8n's users list filter). One UNION in SQL, every value bound, the sort column picked from a fixed list.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import type { Role } from '../db/schema';
import { escapeLike } from './executions';
import { isUuid } from './util';

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

type Filters = Omit<MemberListQuery, 'status' | 'sort' | 'take' | 'skip'>;

/** the sort column of each sort name; the value never comes from the request */
const SORT_COLUMNS: Record<MemberListSort, string> = {
  name: "lower(coalesce(nullif(r.name, ''), r.email))",
  email: 'lower(r.email)',
  role: 'r.role',
  mfaEnabled: 'r.mfa_enabled',
  lastActiveAt: 'r.last_active_at',
};

type RawRow = {
  id: string;
  kind: 'member' | 'invitation';
  email: string;
  name: string | null;
  role: Role;
  status: MemberListStatus;
  mfa_enabled: boolean;
  last_active_at: string | null;
  allow_sso_manual_login: boolean;
  managed_by_scim: boolean;
  joined_at: string | null;
};

/** raw SQL gives a time as text; an ISO string in UTC reads back exactly */
function isoColumn(column: string): SQL {
  return sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
}

function toRow(raw: RawRow): MemberListRow {
  return {
    id: raw.id,
    kind: raw.kind,
    email: raw.email,
    name: raw.name,
    role: raw.role,
    status: raw.status,
    mfaEnabled: raw.mfa_enabled,
    lastActiveAt: raw.last_active_at ? new Date(raw.last_active_at) : null,
    allowSsoManualLogin: raw.allow_sso_manual_login,
    managedByScim: raw.managed_by_scim,
    joinedAt: raw.joined_at ? new Date(raw.joined_at) : null,
  };
}

export class MembersListRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** the workspace's members and its open invitations as one set (`r`), before any filter */
  private source(tenantId: string): SQL {
    return sql`
      SELECT u.id::text AS id, 'member'::text AS kind, u.email AS email, u.name AS name, m.role AS role,
        (CASE WHEN m.disabled_at IS NOT NULL THEN 'disabled' ELSE 'active' END)::text AS status,
        (mfa.enabled_at IS NOT NULL) AS mfa_enabled, m.last_active_at AS last_active_at,
        m.allow_sso_manual_login AS allow_sso_manual_login,
        (u.managed_by_tenant_id IS NOT NULL AND u.managed_by_tenant_id = m.tenant_id) AS managed_by_scim,
        m.created_at AS joined_at, m.tenant_id AS tenant_id, u.id AS user_id
      FROM memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN user_mfa mfa ON mfa.user_id = u.id
      WHERE m.tenant_id = ${tenantId}::uuid
      UNION ALL
      SELECT i.id::text, 'invitation'::text, i.email, NULL::text, i.role, 'pending'::text,
        false, NULL::timestamptz, false, false, NULL::timestamptz, i.tenant_id, NULL::uuid
      FROM invitations i
      WHERE i.tenant_id = ${tenantId}::uuid AND i.accepted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM memberships m2 JOIN users u2 ON u2.id = m2.user_id
          WHERE m2.tenant_id = i.tenant_id AND lower(u2.email) = lower(i.email))`;
  }

  private where(tenantId: string, filters: Filters, status?: MemberListStatus): SQL {
    const parts: SQL[] = [sql`r.tenant_id = ${tenantId}::uuid`];
    const q = filters.q?.trim();
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      parts.push(sql`(r.email ILIKE ${pattern} ESCAPE '\\' OR r.name ILIKE ${pattern} ESCAPE '\\')`);
    }
    if (filters.role) parts.push(sql`r.role = ${filters.role}`);
    if (filters.projectId) {
      // an invitation is in no project
      parts.push(sql`r.user_id IN (
        SELECT pr.user_id FROM project_relations pr
        WHERE pr.tenant_id = ${tenantId}::uuid AND pr.project_id = ${filters.projectId}::uuid)`);
    }
    if (status) parts.push(sql`r.status = ${status}`);
    return sql.join(parts, sql` AND `);
  }

  async list(tenantId: string, query: MemberListQuery): Promise<{ rows: MemberListRow[]; total: number }> {
    if (!isUuid(tenantId) || (query.projectId !== undefined && !isUuid(query.projectId))) {
      return { rows: [], total: 0 };
    }
    const where = this.where(tenantId, query, query.status);
    const sortColumn = SORT_COLUMNS[query.sort?.by ?? 'name'];
    const dir = query.sort?.dir === 'desc' ? 'DESC' : 'ASC';
    // ties and nulls fall back to the email and the id, so a page boundary is stable
    const order = sql.raw(`${sortColumn} ${dir} NULLS LAST, lower(r.email) ASC, r.id ASC`);
    const take = Math.max(1, Math.min(Math.trunc(query.take), 250));
    const skip = Math.max(0, Math.trunc(query.skip));
    const page = await this.db.execute<RawRow>(sql`
      SELECT r.id, r.kind, r.email, r.name, r.role, r.status, r.mfa_enabled, r.allow_sso_manual_login,
        r.managed_by_scim, ${isoColumn('r.last_active_at')} AS last_active_at,
        ${isoColumn('r.joined_at')} AS joined_at
      FROM (${this.source(tenantId)}) r WHERE ${where}
      ORDER BY ${order} LIMIT ${take} OFFSET ${skip}`);
    const total = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM (${this.source(tenantId)}) r WHERE ${where}`);
    return { rows: page.rows.map(toRow), total: total.rows[0]?.n ?? 0 };
  }

  /** how many rows each status has, under the same filters but status */
  async statusCounts(tenantId: string, query: Filters): Promise<Record<MemberListStatus, number>> {
    const counts: Record<MemberListStatus, number> = { active: 0, pending: 0, disabled: 0 };
    if (!isUuid(tenantId) || (query.projectId !== undefined && !isUuid(query.projectId))) return counts;
    const result = await this.db.execute<{ status: MemberListStatus; n: number }>(sql`
      SELECT r.status AS status, count(*)::int AS n FROM (${this.source(tenantId)}) r
      WHERE ${this.where(tenantId, query)} GROUP BY r.status`);
    for (const row of result.rows) counts[row.status] = row.n;
    return counts;
  }

  /** an open invitation of this email in the workspace (re-inviting sends it again) */
  async findOpenInvitationId(tenantId: string, email: string): Promise<string | undefined> {
    if (!isUuid(tenantId)) return undefined;
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM invitations
      WHERE tenant_id = ${tenantId}::uuid AND accepted_at IS NULL AND lower(email) = lower(${email})
      ORDER BY created_at DESC LIMIT 1`);
    return result.rows[0]?.id;
  }
}
