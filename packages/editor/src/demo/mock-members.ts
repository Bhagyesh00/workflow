/**
 * P6-20 (C0): the demo's member routes, moved unchanged out of mock-backend.ts `registerRoutes`: the member list,
 * invite, role change and removal at today's behaviour (FULL). L4 owns this file after C0 and adds the list
 * query, many invites, resend and the invite link.
 */
import type { Member } from '../api/types';
import { newId } from '../lib/ids';
import type { MockBackend } from './mock-backend';
import { HttpError } from './mock-http';

export function registerMemberRoutes(backend: MockBackend): void {
  backend.on('GET', '/members', (): Member[] => {
    const { tenant } = backend.auth();
    return backend.memberships
      .filter((m) => m.tenantId === tenant.id)
      .map((m) => {
        const u = backend.users.find((x) => x.id === m.userId)!;
        return { userId: u.id, email: u.email, name: u.name, role: m.role };
      });
  });
  // P6-03: the member routes take owner, admin, `member` and a custom global role slug (P6-39: not the old
  // words); owner and admin only (`user:create`, `user:changeRole`, `user:delete`)
  backend.on('POST', '/members/invite', ({ body }) => {
    const { tenant } = backend.requireScope('user:create');
    const role = body.role === undefined ? 'member' : backend.assignableRole(body.role, tenant.id);
    const token = newId();
    backend.invitations.push({
      token,
      tenantId: tenant.id,
      email: String(body.email ?? '').toLowerCase(),
      role,
    });
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    return { inviteUrl: `${origin}/invitation/${token}` };
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
