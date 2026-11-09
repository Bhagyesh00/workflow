/**
 * P6-41: the demo's project routes. C0 answers enough for the shell (stub (L18)): GET /projects (a bare array,
 * or `{ count, data }` with `take` or `skip`), /projects/count, /projects/my-projects, /projects/personal and
 * /projects/:id over `backend.projects` and `backend.projectRelations`. Creating, changing, deleting a project,
 * its members and the sharing candidates answer 501 until L18 writes the whole project API. L18 owns this file
 * after C0.
 */
import type { Project, ProjectDetail, ProjectImplicitMember, ProjectRelation } from '../api/types';
import { MISSING_SCOPE, type MockBackend, type StoredProject } from './mock-backend';
import { copy, HttpError, notImplemented } from './mock-http';

const GLOBAL_ROLE_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin' };

/**
 * The projects the signed-in user sees: their personal project, and the workspace's team projects (all of
 * them with the global `project:list`, which owner, admin and the old words hold; else the ones they are a
 * member of).
 */
export function visibleProjects(backend: MockBackend): StoredProject[] {
  const { user, tenant, globalRole } = backend.auth();
  const personal = backend.personalProject(tenant.id, user.id);
  const listAll = backend.globalScopesOf(globalRole, tenant.id).includes('project:list');
  const memberOf = new Set(
    backend.projectRelations
      .filter((r) => r.tenantId === tenant.id && r.userId === user.id)
      .map((r) => r.projectId),
  );
  const team = backend.projects.filter(
    (p) => p.tenantId === tenant.id && p.type === 'team' && (listAll || memberOf.has(p.id)),
  );
  return [personal, ...team];
}

/** a project row with the caller's role and scopes in it */
export function projectRow(backend: MockBackend, p: StoredProject): Project {
  const { user } = backend.auth();
  const relation = backend.projectRelations.find((r) => r.projectId === p.id && r.userId === user.id);
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    icon: p.icon ? copy(p.icon) : null,
    description: p.description,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(relation ? { role: relation.role } : {}),
    scopes: backend.projectScopes(p),
  };
}

/** GET /projects/:id: the row, its members, and owner and admin as implicit members of a team project */
export function projectDetail(backend: MockBackend, p: StoredProject): ProjectDetail {
  const userOf = (id: string) => backend.users.find((u) => u.id === id);
  const relations: ProjectRelation[] = backend.projectRelations
    .filter((r) => r.projectId === p.id)
    .flatMap((r) => {
      const u = userOf(r.userId);
      return u ? [{ id: u.id, email: u.email, name: u.name, role: r.role }] : [];
    });
  const related = new Set(relations.map((r) => r.id));
  const implicitMembers: ProjectImplicitMember[] =
    p.type === 'team'
      ? backend.memberships
          .filter((m) => m.tenantId === p.tenantId && (m.globalRole ?? m.role) in GLOBAL_ROLE_NAMES)
          .filter((m) => !related.has(m.userId))
          .flatMap((m) => {
            const u = userOf(m.userId);
            const slug = m.globalRole ?? m.role;
            return u
              ? [
                  {
                    id: u.id,
                    email: u.email,
                    name: u.name,
                    globalRole: { slug, displayName: GLOBAL_ROLE_NAMES[slug] },
                  },
                ]
              : [];
          })
      : [];
  const row = projectRow(backend, p);
  return { ...row, scopes: row.scopes ?? [], relations, implicitMembers, creatorId: p.creatorId };
}

export function registerProjectRoutes(backend: MockBackend): void {
  backend.on('GET', '/projects', ({ query }) => {
    const search = (query.search ?? '').toLowerCase();
    const rows = visibleProjects(backend)
      .filter((p) => !query.type || p.type === query.type)
      .filter((p) => !search || p.name.toLowerCase().includes(search))
      .map((p) => projectRow(backend, p));
    if (query.take === undefined && query.skip === undefined) return rows;
    const skip = Math.max(Number(query.skip) || 0, 0);
    const take = query.take === undefined ? rows.length : Math.max(Number(query.take) || 0, 0);
    return { count: rows.length, data: rows.slice(skip, skip + take) };
  });
  backend.on('GET', '/projects/count', () => {
    const { tenant } = backend.auth();
    const inTenant = backend.projects.filter((p) => p.tenantId === tenant.id);
    return {
      personal: inTenant.filter((p) => p.type === 'personal').length,
      team: inTenant.filter((p) => p.type === 'team').length,
    };
  });
  backend.on('GET', '/projects/my-projects', () =>
    visibleProjects(backend).map((p) => projectRow(backend, p)),
  );
  backend.on('GET', '/projects/personal', () => {
    const { user, tenant } = backend.auth();
    return projectDetail(backend, backend.personalProject(tenant.id, user.id));
  });
  // stub (L18): sharing candidates; create, change and delete a project; its members
  backend.on('GET', '/projects/sharing-candidates', () => notImplemented('L18'));
  backend.on('GET', '/projects/:id', ({ params }) => {
    const { tenant } = backend.auth();
    const p = backend.projects.find((x) => x.id === params[0] && x.tenantId === tenant.id);
    if (!p) throw new HttpError(404, 'not_found', 'Project not found');
    if (!visibleProjects(backend).includes(p)) throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    return projectDetail(backend, p);
  });
  backend.on('POST', '/projects', () => notImplemented('L18'));
  backend.on('PATCH', '/projects/:id', () => notImplemented('L18'));
  backend.on('DELETE', '/projects/:id', () => notImplemented('L18'));
  backend.on('POST', '/projects/:id/users', () => notImplemented('L18'));
  backend.on('PATCH', '/projects/:id/users/:userId', () => notImplemented('L18'));
  backend.on('DELETE', '/projects/:id/users/:userId', () => notImplemented('L18'));
}
