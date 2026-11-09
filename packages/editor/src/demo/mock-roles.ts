/**
 * P6-46: the demo's roles. GET /roles is FULL here (C0), because L19's project role dropdown and L22's members
 * page render it before L23 builds the rest: the system roles from the catalog's maps plus the workspace's
 * custom roles, one custom project role seeded per workspace. L23 fills the rest: one role, create, update,
 * delete, assignments and members, with the server's checks. L23 owns this file after C0.
 */
import {
  ASSIGNABLE_PROJECT_ROLE_SLUGS,
  customRoleAllowedScopes,
  GLOBAL_ROLE_SCOPES,
  GLOBAL_ROLE_SLUGS,
  MANDATORY_INSTANCE_SCOPES,
  PROJECT_CUSTOM_ROLE_SCOPES,
  PROJECT_ROLE_SCOPES,
  RESOURCE_ROLE_SCOPES,
  RESOURCE_ROLE_SLUGS,
  type Scope,
} from '@workflow/workflow';
import type { CustomRole, RoleAssignmentsPage, RoleMember, RoleMembersPage, RolesMap } from '../api/types';
import { MISSING_SCOPE, type MockBackend } from './mock-backend';
import { copy, HttpError, now } from './mock-http';
import { visibleProjects } from './mock-projects';

/** a custom role of a workspace (the server's `roles` table) */
export interface StoredRole extends CustomRole {
  tenantId: string;
  roleType: 'project' | 'global';
}

interface RolesState {
  roles: StoredRole[];
  /** workspaces whose seed role was added */
  seeded: Set<string>;
}

/** the demo's seed custom project role: reads workflows and their runs, nothing else */
export const DEMO_CUSTOM_PROJECT_ROLE = {
  slug: 'project:reviewer',
  displayName: 'Reviewer',
  description: 'Reads workflows and their executions',
  scopes: [
    'project:read',
    'project:list',
    'folder:read',
    'folder:list',
    'workflow:read',
    'workflow:list',
    'execution:read',
    'execution:list',
  ] as Scope[],
} as const;

const DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  'project:admin': 'Admin',
  'project:editor': 'Editor',
  'project:viewer': 'Viewer',
  'workflow:owner': 'Workflow Owner',
  'workflow:editor': 'Workflow Editor',
  'credential:owner': 'Credential Owner',
  'credential:user': 'Credential User',
  'secretsProviderConnection:owner': 'Secrets Provider Connection Owner',
  'secretsProviderConnection:user': 'Secrets Provider Connection User',
};

function state(backend: MockBackend): RolesState {
  let s = backend.ext.roles as RolesState | undefined;
  if (!s) {
    s = { roles: [], seeded: new Set() };
    backend.ext.roles = s;
  }
  return s;
}

/** the custom roles of a workspace (the seed project role is added on first read) */
export function demoRoles(backend: MockBackend, tenantId: string): StoredRole[] {
  const s = state(backend);
  if (!s.seeded.has(tenantId)) {
    s.seeded.add(tenantId);
    const at = new Date().toISOString();
    s.roles.push({
      ...DEMO_CUSTOM_PROJECT_ROLE,
      scopes: DEMO_CUSTOM_PROJECT_ROLE.scopes.filter((scope) => PROJECT_CUSTOM_ROLE_SCOPES.has(scope)),
      tenantId,
      systemRole: false,
      roleType: 'project',
      createdAt: at,
      updatedAt: at,
    });
  }
  return s.roles.filter((r) => r.tenantId === tenantId);
}

/** adds a custom role to its workspace (tests; L23's POST /roles uses it too) */
export function addDemoRole(backend: MockBackend, role: StoredRole): StoredRole {
  demoRoles(backend, role.tenantId);
  state(backend).roles.push(role);
  return role;
}

/** a workspace's custom role by slug (and type), or undefined */
export function findCustomRole(
  backend: MockBackend,
  tenantId: string,
  slug: string,
  roleType?: 'project' | 'global',
): StoredRole | undefined {
  return demoRoles(backend, tenantId).find((r) => r.slug === slug && (!roleType || r.roleType === roleType));
}

function systemRole(slug: string, roleType: CustomRole['roleType'], scopes: Iterable<Scope>): CustomRole {
  return {
    slug,
    displayName: DISPLAY_NAMES[slug] ?? slug,
    description: null,
    systemRole: true,
    roleType,
    scopes: [...scopes],
  };
}

/** GET /roles: every role by type (n8n's AllRolesMap); usage counts with `withUsageCount=true` */
function rolesMap(backend: MockBackend, tenantId: string, withUsage: boolean): RolesMap {
  const members = backend.memberships.filter((m) => m.tenantId === tenantId);
  const relations = backend.projectRelations.filter((r) => r.tenantId === tenantId);
  const usage = (role: CustomRole): CustomRole => {
    if (!withUsage) return role;
    if (role.roleType === 'global') {
      const usedByUsers = members.filter((m) => m.role === role.slug).length;
      return { ...role, usedByUsers };
    }
    if (role.roleType === 'project') {
      const used = relations.filter((r) => r.role === role.slug);
      return {
        ...role,
        usedByUsers: new Set(used.map((r) => r.userId)).size,
        usedByProjects: new Set(used.map((r) => r.projectId)).size,
      };
    }
    return role;
  };
  const custom = demoRoles(backend, tenantId).map(({ tenantId: _t, ...role }) => copy(role) as CustomRole);
  const byPrefix = (prefix: string) =>
    RESOURCE_ROLE_SLUGS.filter((slug) => slug.startsWith(`${prefix}:`)).map((slug) =>
      systemRole(slug, prefix as CustomRole['roleType'], RESOURCE_ROLE_SCOPES[slug]),
    );
  return {
    global: [
      ...GLOBAL_ROLE_SLUGS.map((slug) => systemRole(slug, 'global', GLOBAL_ROLE_SCOPES[slug])),
      ...custom.filter((r) => r.roleType === 'global'),
    ].map(usage),
    project: [
      ...ASSIGNABLE_PROJECT_ROLE_SLUGS.map((slug) => systemRole(slug, 'project', PROJECT_ROLE_SCOPES[slug])),
      ...custom.filter((r) => r.roleType === 'project'),
    ].map(usage),
    workflow: byPrefix('workflow'),
    credential: byPrefix('credential'),
    secretsProviderConnection: byPrefix('secretsProviderConnection'),
  };
}

export function registerRoleRoutes(backend: MockBackend): void {
  // FULL: any signed-in member reads the role list (the project role dropdown, the members page)
  backend.on('GET', '/roles', ({ query }) => {
    const { tenant } = backend.auth();
    return rolesMap(backend, tenant.id, query.withUsageCount === 'true');
  });
  backend.on('GET', '/roles/:slug', ({ params, query }) => {
    const { tenant } = backend.auth();
    return roleOf(backend, tenant.id, params[0], query.withUsageCount === 'true');
  });
  backend.on('POST', '/roles', ({ body }) => {
    const { tenant } = backend.auth();
    const roleType = body.roleType;
    if (roleType !== 'project' && roleType !== 'global') throw invalid('roleType must be project or global');
    requireManage(backend, roleType);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (displayName.length < 2 || displayName.length > 100) throw invalid('Name must be 2 to 100 characters');
    const scopes = checkedScopes(roleType, body.scopes);
    assertNameFree(backend, tenant.id, roleType, displayName);
    const at = now();
    const role = addDemoRole(backend, {
      slug: `${roleType}:${slugify(displayName)}-${Math.random().toString(16).slice(2, 8)}`,
      displayName,
      description: typeof body.description === 'string' && body.description ? body.description : null,
      scopes,
      tenantId: tenant.id,
      systemRole: false,
      roleType,
      createdAt: at,
      updatedAt: at,
    });
    return publicRole(role);
  });
  backend.on('PATCH', '/roles/:slug', ({ params, body }) => {
    const { tenant } = backend.auth();
    const slug = params[0];
    if (isSystemSlug(slug)) {
      requireManageAny(backend);
      throw new HttpError(400, 'bad_request', 'Cannot update system roles');
    }
    const role = findCustomRole(backend, tenant.id, slug);
    if (!role) throw new HttpError(404, 'not_found', `Role "${slug}" not found`);
    requireManage(backend, role.roleType);
    if (body.displayName !== undefined) {
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (name.length < 2 || name.length > 100) throw invalid('Name must be 2 to 100 characters');
      assertNameFree(backend, tenant.id, role.roleType, name, slug);
      role.displayName = name;
    }
    if (body.description !== undefined) role.description = String(body.description) || null;
    if (body.scopes !== undefined) role.scopes = checkedScopes(role.roleType, body.scopes);
    role.updatedAt = now();
    return publicRole(role);
  });
  backend.on('DELETE', '/roles/:slug', ({ params, query }) => {
    const { tenant } = backend.auth();
    const slug = params[0];
    if (isSystemSlug(slug)) {
      requireManageAny(backend);
      throw new HttpError(400, 'bad_request', 'Cannot delete system roles');
    }
    const role = findCustomRole(backend, tenant.id, slug);
    if (!role) throw new HttpError(404, 'not_found', `Role "${slug}" not found`);
    requireManage(backend, role.roleType);
    const holders = backend.memberships.filter(
      (m) => m.tenantId === tenant.id && m.role === slug,
    );
    const used = backend.projectRelations.some((r) => r.tenantId === tenant.id && r.role === slug);
    const reassign = query.reassignRoleSlug;
    const inUse = role.roleType === 'global' ? holders.length > 0 : used;
    if (inUse && !(reassign && role.roleType === 'global')) {
      throw new HttpError(400, 'bad_request', 'Cannot delete role assigned to users');
    }
    if (inUse && reassign) {
      backend.requireScope('user:changeRole');
      const target =
        reassign === slug || reassign === 'owner' ? undefined : globalRoleOf(backend, tenant.id, reassign);
      if (!target) {
        throw new HttpError(400, 'bad_request', `Cannot reassign the members to the role "${reassign}"`);
      }
      for (const m of holders) m.role = reassign;
    }
    state(backend).roles = state(backend).roles.filter((r) => r !== role);
    return publicRole(role);
  });
  backend.on('GET', '/roles/:slug/assignments', ({ params }) => {
    const { tenant } = backend.auth();
    requireManageAny(backend);
    projectRoleOf(backend, tenant.id, params[0]);
    const visible = new Set(visibleProjects(backend).map((p) => p.id));
    const projects = backend.projects
      .filter((p) => p.tenantId === tenant.id && visible.has(p.id))
      .map((p) => ({
        projectId: p.id,
        projectName: p.name,
        projectIcon: p.icon ? copy(p.icon) : null,
        memberCount: backend.projectRelations.filter((r) => r.projectId === p.id && r.role === params[0])
          .length,
        lastAssigned: null,
      }))
      .filter((row) => row.memberCount > 0);
    return { projects, totalProjects: projects.length } satisfies RoleAssignmentsPage;
  });
  backend.on('GET', '/roles/:slug/assignments/:projectId/members', ({ params }) => {
    const { tenant } = backend.auth();
    requireManageAny(backend);
    projectRoleOf(backend, tenant.id, params[0]);
    const project = backend.projects.find((p) => p.tenantId === tenant.id && p.id === params[1]);
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    if (!visibleProjects(backend).some((p) => p.id === project.id)) {
      throw new HttpError(403, 'forbidden', MISSING_SCOPE);
    }
    const members = backend.projectRelations
      .filter((r) => r.projectId === project.id && r.role === params[0])
      .map((r) => memberOf(backend, r.userId, params[0]));
    return { members, total: members.length } satisfies RoleMembersPage;
  });
  backend.on('GET', '/roles/:slug/members', ({ params }) => {
    const { tenant } = backend.auth();
    backend.requireScope('role:read');
    if (!globalRoleOf(backend, tenant.id, params[0])) {
      throw new HttpError(404, 'not_found', `Role "${params[0]}" not found`);
    }
    const members = backend.memberships
      .filter((m) => m.tenantId === tenant.id && m.role === params[0])
      .map((m) => memberOf(backend, m.userId, params[0]));
    return { members, total: members.length } satisfies RoleMembersPage;
  });
}

const invalid = (message: string) => new HttpError(400, 'bad_request', message);

const isSystemSlug = (slug: string): boolean =>
  (GLOBAL_ROLE_SLUGS as readonly string[]).includes(slug) ||
  (ASSIGNABLE_PROJECT_ROLE_SLUGS as readonly string[]).includes(slug) ||
  (RESOURCE_ROLE_SLUGS as readonly string[]).includes(slug);

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'role';

/** `role:manage` for a workspace role; `role:manageProject` also serves a project role */
function requireManage(backend: MockBackend, roleType: 'project' | 'global'): void {
  try {
    backend.requireScope('role:manage');
  } catch (error) {
    if (roleType !== 'project') throw error;
    backend.requireScope('role:manageProject');
  }
}

function requireManageAny(backend: MockBackend): void {
  requireManage(backend, 'project');
}

/** the scopes of a write: every one on the type's allow list (a workspace role also gets the baseline) */
function checkedScopes(roleType: 'project' | 'global', raw: unknown): Scope[] {
  if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) throw invalid('scopes must be a list');
  const allowed = customRoleAllowedScopes(roleType);
  const unique = [...new Set(raw as Scope[])];
  const refused = unique.filter((scope) => !allowed.has(scope));
  if (refused.length) {
    throw invalid(`The following scopes are not allowed for ${roleType} roles: ${refused.join(', ')}`);
  }
  return roleType === 'global' ? [...new Set([...unique, ...MANDATORY_INSTANCE_SCOPES])] : unique;
}

function assertNameFree(
  backend: MockBackend,
  tenantId: string,
  roleType: 'project' | 'global',
  displayName: string,
  exceptSlug?: string,
): void {
  const wanted = displayName.toLowerCase();
  const custom = demoRoles(backend, tenantId).some(
    (r) => r.slug !== exceptSlug && r.displayName.toLowerCase() === wanted,
  );
  const system = Object.entries(DISPLAY_NAMES).some(
    ([slug, name]) =>
      name.toLowerCase() === wanted &&
      (roleType === 'global'
        ? (GLOBAL_ROLE_SLUGS as readonly string[]).includes(slug)
        : slug.startsWith('project:')),
  );
  if (custom || system) {
    throw new HttpError(409, 'conflict', `A role with the name "${displayName}" already exists`);
  }
}

function publicRole(role: StoredRole): CustomRole {
  const { tenantId: _t, ...rest } = copy(role);
  return rest as CustomRole;
}

function roleOf(backend: MockBackend, tenantId: string, slug: string, withUsage: boolean): CustomRole {
  const map = rolesMap(backend, tenantId, withUsage);
  const found = [
    ...map.global,
    ...map.project,
    ...map.workflow,
    ...map.credential,
    ...map.secretsProviderConnection,
  ].find((r) => r.slug === slug);
  if (!found) throw new HttpError(404, 'not_found', `Role "${slug}" not found`);
  return found;
}

function projectRoleOf(backend: MockBackend, tenantId: string, slug: string): CustomRole {
  const role = roleOf(backend, tenantId, slug, false);
  if (role.roleType !== 'project') throw new HttpError(404, 'not_found', `Role "${slug}" not found`);
  return role;
}

function globalRoleOf(backend: MockBackend, tenantId: string, slug: string): CustomRole | undefined {
  try {
    const role = roleOf(backend, tenantId, slug, false);
    return role.roleType === 'global' ? role : undefined;
  } catch {
    return undefined;
  }
}

function memberOf(backend: MockBackend, userId: string, role: string): RoleMember {
  const user = backend.users.find((u) => u.id === userId);
  return { userId, name: user?.name ?? '', email: user?.email ?? '', role };
}
