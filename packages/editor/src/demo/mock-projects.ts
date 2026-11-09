/**
 * P6-41: the demo's project routes, the whole project API as the server's (routes/projects.ts, n8n's project
 * controller): the caller's lists, one project, create (`project:create`, the caller becomes project admin),
 * change, members (add with conflicts, role, remove) and delete with a transfer or a wipe. L19 needs no demo
 * file of its own.
 */
import type {
  Project,
  ProjectAddUsersResult,
  ProjectDetail,
  ProjectIcon,
  ProjectImplicitMember,
  ProjectRef,
  ProjectRelation,
} from '../api/types';
import { MISSING_SCOPE, type MockBackend, type StoredProject } from './mock-backend';
import { copy, HttpError, now } from './mock-http';
import { findCustomRole } from './mock-roles';
import { demoShares } from './mock-sharing';

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
  backend.on('GET', '/projects/sharing-candidates', () => {
    const { tenant } = backend.requireScope('user:list');
    const refs: ProjectRef[] = [
      ...backend.projects.filter((p) => p.tenantId === tenant.id && p.type === 'personal'),
      ...visibleProjects(backend).filter((p) => p.type === 'team'),
    ].map((p) => ({ id: p.id, name: p.name, type: p.type, icon: p.icon ? copy(p.icon) : null }));
    return refs;
  });
  backend.on('GET', '/projects/:id', ({ params }) => {
    const p = tenantProject(backend, params[0]);
    if (!visibleProjects(backend).includes(p)) throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    return projectDetail(backend, p);
  });
  backend.on('POST', '/projects', ({ body }) => {
    const { user, tenant } = backend.requireScope('project:create');
    const project = backend.createProject({
      tenantId: tenant.id,
      name: readName(body.name, true) as string,
      type: 'team',
      icon: readIcon(body.icon) ?? null,
      description: readDescription(body.description) ?? null,
      creatorId: user.id,
    });
    backend.projectRelations.push({
      tenantId: tenant.id,
      projectId: project.id,
      userId: user.id,
      role: 'project:admin',
    });
    return projectDetail(backend, project);
  });
  backend.on('PATCH', '/projects/:id', ({ params, body }) => {
    const p = tenantProject(backend, params[0]);
    backend.requireScope('project:update', { scopes: backend.projectScopes(p) });
    if (p.type === 'personal') throw new HttpError(400, 'bad_request', "Can't update a personal project.");
    const name = readName(body.name, false);
    const icon = readIcon(body.icon);
    const description = readDescription(body.description);
    if (name !== undefined) p.name = name;
    if (icon !== undefined) p.icon = icon;
    if (description !== undefined) p.description = description;
    p.updatedAt = now();
    return projectDetail(backend, p);
  });
  backend.on('POST', '/projects/:id/users', ({ params, body }) => {
    const p = tenantProject(backend, params[0]);
    backend.requireScope('project:manageMembers', { scopes: backend.projectScopes(p) });
    if (p.type === 'personal')
      throw new HttpError(400, 'bad_request', "Can't add users to personal projects.");
    if (!Array.isArray(body.relations)) throw invalid('relations must be a list');
    const wanted = new Map<string, string>();
    for (const item of body.relations as Array<{ userId?: unknown; role?: unknown }>) {
      if (typeof item?.userId !== 'string' || typeof item.role !== 'string')
        throw invalid('Each relation needs a userId and a role');
      assertAssignableRole(backend, p.tenantId, item.role);
      if (!wanted.has(item.userId)) wanted.set(item.userId, item.role);
    }
    const conflicts: NonNullable<ProjectAddUsersResult['conflicts']> = [];
    let added = 0;
    for (const [userId, role] of wanted) {
      const membership = backend.memberships.find((m) => m.tenantId === p.tenantId && m.userId === userId);
      if (!membership) throw new HttpError(404, 'not_found', 'User not found');
      // owners and admins already reach every team project
      if ((membership.globalRole ?? membership.role) in GLOBAL_ROLE_NAMES) continue;
      const existing = backend.projectRelations.find((r) => r.projectId === p.id && r.userId === userId);
      if (!existing) {
        backend.projectRelations.push({ tenantId: p.tenantId, projectId: p.id, userId, role });
        added += 1;
      } else if (existing.role !== role) {
        conflicts.push({ userId, currentRole: existing.role, requestedRole: role });
      }
    }
    if (added === 0 && conflicts.length > 0) {
      throw new HttpError(409, 'conflict', 'No users were added: they are already members of this project', {
        conflicts,
      });
    }
    return { conflicts } satisfies ProjectAddUsersResult;
  });
  backend.on('PATCH', '/projects/:id/users/:userId', ({ params, body }) => {
    const p = tenantProject(backend, params[0]);
    backend.requireScope('project:manageMembers', { scopes: backend.projectScopes(p) });
    const relation = backend.projectRelations.find((r) => r.projectId === p.id && r.userId === params[1]);
    if (!relation) throw new HttpError(404, 'not_found', 'Project member not found');
    if (relation.role === PERSONAL_OWNER)
      throw new HttpError(400, 'bad_request', "Can't change the role of a project owner.");
    if (typeof body.role !== 'string') throw invalid('role must be text');
    assertAssignableRole(backend, p.tenantId, body.role);
    relation.role = body.role;
    return { ok: true };
  });
  backend.on('DELETE', '/projects/:id/users/:userId', ({ params }) => {
    const p = tenantProject(backend, params[0]);
    backend.requireScope('project:manageMembers', { scopes: backend.projectScopes(p) });
    const relation = backend.projectRelations.find((r) => r.projectId === p.id && r.userId === params[1]);
    if (!relation) throw new HttpError(404, 'not_found', 'Project member not found');
    if (relation.role === PERSONAL_OWNER)
      throw new HttpError(400, 'bad_request', 'Project owner cannot be removed from the project');
    removeAll(backend.projectRelations, (r) => r === relation);
    return { ok: true };
  });
  backend.on('DELETE', '/projects/:id', ({ params, query }) => {
    const p = tenantProject(backend, params[0]);
    backend.requireScope('project:delete', { scopes: backend.projectScopes(p) });
    if (p.type !== 'team') {
      throw new HttpError(
        400,
        'bad_request',
        `Can't delete project. Project with ID ${p.id} is not a team project.`,
      );
    }
    const transferId = query.transferId;
    const owned = (row: { projectId?: string | null; tenantId: string }) =>
      row.tenantId === p.tenantId && row.projectId === p.id;
    if (transferId) {
      if (transferId === p.id) {
        throw new HttpError(
          400,
          'bad_request',
          "Can't move the work of a project into the project that is being deleted.",
        );
      }
      const target = tenantProject(backend, transferId);
      const scopes = backend.projectScopes(target);
      for (const scope of ['credential:create', 'workflow:create', 'dataTable:create'] as const) {
        if (!scopes.includes(scope)) throw new HttpError(403, 'forbidden', MISSING_SCOPE);
      }
      for (const row of [...backend.workflows, ...backend.credentials, ...backend.variables]) {
        if (owned(row)) row.projectId = target.id;
      }
    } else {
      const gone = new Set([...backend.workflows, ...backend.credentials].filter(owned).map((row) => row.id));
      backend.workflows = backend.workflows.filter((w) => !owned(w));
      backend.credentials = backend.credentials.filter((c) => !owned(c));
      backend.variables = backend.variables.filter((v) => !owned(v));
      removeAll(demoShares(backend), (s) => gone.has(s.resourceId));
    }
    removeAll(demoShares(backend), (s) => s.projectId === p.id);
    removeAll(backend.projectRelations, (r) => r.projectId === p.id);
    removeAll(backend.projects, (x) => x === p);
    return { ok: true };
  });
}

const PERSONAL_OWNER = 'project:personalOwner';
const SYSTEM_PROJECT_ROLES = ['project:admin', 'project:editor', 'project:viewer'];

const invalid = (message: string) => new HttpError(400, 'validation_error', message);

/** the project of the session's workspace; another workspace's id is a 404 */
function tenantProject(backend: MockBackend, id: string): StoredProject {
  const { tenant } = backend.auth();
  const p = backend.projects.find((x) => x.id === id && x.tenantId === tenant.id);
  if (!p) throw new HttpError(404, 'not_found', 'Project not found');
  return p;
}

function readName(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 255)
    throw invalid('Project name must be 1 to 255 characters');
  return value.trim();
}

function readDescription(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || value.length > 512)
    throw invalid('Description must be at most 512 characters');
  return value;
}

function readIcon(value: unknown): ProjectIcon | null | undefined {
  if (value === undefined || value === null) return value;
  const icon = value as Partial<ProjectIcon>;
  if (
    (icon.type !== 'icon' && icon.type !== 'emoji') ||
    typeof icon.value !== 'string' ||
    icon.value.length < 1 ||
    icon.value.length > 64
  )
    throw invalid('The icon needs a type and a value');
  return {
    type: icon.type,
    value: icon.value,
    ...(typeof icon.color === 'string' ? { color: icon.color } : {}),
  };
}

/** a project role a member may be given: the three system roles or a custom role of type project */
function assertAssignableRole(backend: MockBackend, tenantId: string, role: string): void {
  if (role === PERSONAL_OWNER) throw invalid("Can't add a personalOwner to a team project.");
  if (SYSTEM_PROJECT_ROLES.includes(role)) return;
  if (!findCustomRole(backend, tenantId, role, 'project')) throw invalid(`Unknown project role "${role}"`);
}

/** drops the matching items from a live array in place */
function removeAll<T>(list: T[], match: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i])) list.splice(i, 1);
}
