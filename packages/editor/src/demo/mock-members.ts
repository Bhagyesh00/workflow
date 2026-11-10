/**
 * P6-20 (L4): the demo's member routes. The list takes the server's query (`q`, `role`, `projectId`, `status`,
 * `sort`, `take`, `skip`), answers `count` and, for `user:create`, `statusCounts` beside `data`, and includes
 * open invitations as pending rows. Invite takes one object (today's `{ inviteUrl }`) or a list (one answer
 * per row); resend and the invite link rotate the token, so the old link stops working. Role change and
 * removal are as before.
 */
import type { Member, MemberStatus } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

type Invitation = MockBackend['invitations'][number];

/** an invitation keeps its id when its token rotates (the object stays the same) */
const invitationIds = new WeakMap<Invitation, string>();

function idOf(invitation: Invitation): string {
  let id = invitationIds.get(invitation);
  if (!id) {
    id = newId();
    invitationIds.set(invitation, id);
  }
  return id;
}

const SORT_FIELDS = ['name', 'email', 'role', 'mfaEnabled', 'lastActiveAt'] as const;
type SortField = (typeof SORT_FIELDS)[number];

function acceptUrl(token: string): string {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return `${origin}/invitation/${token}`;
}

export function registerMemberRoutes(backend: MockBackend): void {
  /** every member of the workspace and its open invitations, as the server's list rows */
  const rows = (tenantId: string): Member[] => {
    const members = backend.memberships
      .filter((m) => m.tenantId === tenantId)
      .map((m): Member => {
        const u = backend.users.find((x) => x.id === m.userId)!;
        return {
          userId: u.id,
          email: u.email,
          name: u.name,
          role: m.role,
          status: m.status ?? 'active',
          lastActiveAt: m.lastActiveAt ?? null,
          mfaEnabled: backend.mfaEnabledUsers.has(u.id),
          managedByScim: m.managedByScim ?? false,
          allowSsoManualLogin: m.allowSsoManualLogin ?? false,
        };
      });
    const pending = backend.invitations
      .filter((i) => i.tenantId === tenantId)
      .filter((i) => !members.some((m) => m.email.toLowerCase() === i.email))
      .map(
        (i): Member => ({
          userId: idOf(i),
          invitationId: idOf(i),
          email: i.email,
          name: '',
          role: i.role,
          status: 'pending',
          lastActiveAt: null,
          mfaEnabled: false,
          managedByScim: false,
          allowSsoManualLogin: false,
        }),
      );
    return [...members, ...pending];
  };

  const sortValue = (m: Member, field: SortField): string | number => {
    if (field === 'name') return (m.name || m.email).toLowerCase();
    if (field === 'email') return m.email.toLowerCase();
    if (field === 'role') return m.role;
    if (field === 'mfaEnabled') return m.mfaEnabled ? 1 : 0;
    return m.lastActiveAt ? Date.parse(m.lastActiveAt) : Number.NEGATIVE_INFINITY;
  };

  backend.on('GET', '/members', ({ query }) => {
    const { tenant, role: callerRole } = backend.auth();
    const globalScopes = backend.globalScopesOf(callerRole, tenant.id);
    const canSeeStatus = globalScopes.includes('user:create');
    if (query.status && !canSeeStatus) throw new HttpError(403, 'forbidden', MISSING_SCOPE_TEXT);
    const [sortBy = 'name', sortDir = 'asc'] = (query.sort ?? '').split(':');
    if (query.sort && !(SORT_FIELDS as readonly string[]).includes(sortBy)) {
      throw new HttpError(400, 'bad_request', `Sort by one of: ${SORT_FIELDS.join(', ')}`);
    }
    const q = (query.q ?? '').trim().toLowerCase();
    const inProject = query.projectId
      ? new Set(
          backend.projectRelations
            .filter((r) => r.tenantId === tenant.id && r.projectId === query.projectId)
            .map((r) => r.userId),
        )
      : null;
    const filtered = rows(tenant.id)
      .filter((m) => !q || m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
      .filter((m) => !query.role || m.role === query.role)
      .filter((m) => !inProject || (m.status !== 'pending' && inProject.has(m.userId)));
    const statusCounts: Record<MemberStatus, number> = { active: 0, pending: 0, disabled: 0 };
    for (const m of filtered) statusCounts[m.status ?? 'active'] += 1;
    const shown = filtered
      .filter((m) => !query.status || m.status === query.status)
      .sort((a, b) => {
        const x = sortValue(a, sortBy as SortField);
        const y = sortValue(b, sortBy as SortField);
        const order = x < y ? -1 : x > y ? 1 : a.email.localeCompare(b.email);
        return sortDir === 'desc' ? -order : order;
      });
    const take = Math.min(Math.max(Number(query.take) || 1000, 1), 1000);
    const skip = Math.max(Number(query.skip) || 0, 0);
    return {
      __list: true as const,
      data: shown.slice(skip, skip + take),
      nextCursor: null,
      count: shown.length,
      ...(canSeeStatus ? { statusCounts } : {}),
    };
  });

  // P6-03: the member routes take owner, admin, `member` and a custom global role slug (P6-39: not the old
  // words); owner and admin only (`user:create`, `user:changeRole`, `user:delete`)
  backend.on('POST', '/members/invite', ({ body }) => {
    const { tenant } = backend.requireScope('user:create');
    const invite = (email: unknown, roleValue: unknown) => {
      const role = roleValue === undefined ? 'member' : backend.assignableRole(roleValue, tenant.id);
      const address = String(email ?? '').toLowerCase();
      const known = backend.users.find((u) => u.email.toLowerCase() === address);
      if (known && backend.memberships.some((m) => m.tenantId === tenant.id && m.userId === known.id)) {
        throw new HttpError(409, 'conflict', 'This user is already a member of the workspace');
      }
      // inviting a pending person again sends it again: a new token on the same invitation
      const open = backend.invitations.find((i) => i.tenantId === tenant.id && i.email === address);
      if (open) {
        open.token = newId();
        open.role = role;
        return open;
      }
      const created: Invitation = { token: newId(), tenantId: tenant.id, email: address, role };
      backend.invitations.push(created);
      return created;
    };
    const list = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : null;
    if (!list) {
      return { inviteUrl: acceptUrl(invite(body.email, body.role).token) };
    }
    if (list.length === 0) throw new HttpError(400, 'bad_request', 'Invite at least one person');
    return list.map((row) => {
      try {
        const made = invite(row.email, row.role);
        return {
          id: idOf(made),
          email: made.email,
          role: made.role,
          emailSent: false,
          inviteAcceptUrl: acceptUrl(made.token),
          error: '',
        };
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return {
          id: null,
          email: String(row.email ?? '').toLowerCase(),
          role: String(row.role ?? 'member'),
          emailSent: false,
          error: error.message,
        };
      }
    });
  });
  backend.on('POST', '/invitations/:id/resend', ({ params }) => {
    const { tenant } = backend.requireScope('user:create');
    const invitation = backend.invitations.find((i) => i.tenantId === tenant.id && idOf(i) === params[0]);
    if (!invitation) throw new HttpError(404, 'not_found', 'Invitation not found');
    invitation.token = newId();
    return {
      id: idOf(invitation),
      email: invitation.email,
      role: invitation.role,
      emailSent: false,
      inviteAcceptUrl: acceptUrl(invitation.token),
      error: '',
    };
  });
  backend.on('POST', '/invitations/:id/link', ({ params }) => {
    const { tenant } = backend.requireScope('user:generateInviteLink');
    const invitation = backend.invitations.find((i) => i.tenantId === tenant.id && idOf(i) === params[0]);
    if (!invitation) throw new HttpError(404, 'not_found', 'Invitation not found');
    invitation.token = newId();
    return { link: acceptUrl(invitation.token) };
  });
  backend.on('PATCH', '/members/:userId', ({ params, body }) => {
    const { tenant } = backend.requireScope('user:changeRole');
    const m = backend.memberships.find((x) => x.tenantId === tenant.id && x.userId === params[0]);
    if (!m) throw new HttpError(404, 'not_found', 'Member not found');
    m.role = backend.assignableRole(body.role, tenant.id);
    const u = backend.users.find((x) => x.id === m.userId)!;
    return { userId: u.id, email: u.email, name: u.name, role: m.role };
  });
  backend.on('DELETE', '/members/:userId', ({ params }) => {
    const { tenant } = backend.requireScope('user:delete');
    backend.memberships = backend.memberships.filter(
      (x) => !(x.tenantId === tenant.id && x.userId === params[0]),
    );
    return { ok: true };
  });
}

/** the 403 text of a missing scope (n8n's), as `MISSING_SCOPE` in mock-backend.ts */
const MISSING_SCOPE_TEXT = 'User is missing a scope required to perform this action';
