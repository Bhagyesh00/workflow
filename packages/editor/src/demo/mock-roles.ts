/**
 * P6-46: the demo's roles. GET /roles is FULL here (C0), because L19's project role dropdown and L22's members
 * page render it before L23 builds the rest: the system roles from the catalog's maps plus the workspace's
 * custom roles, one custom project role seeded per workspace. Every other /roles route answers 501 until L23
 * (stub (L23)). L23 owns this file after C0.
 */
import {
  ASSIGNABLE_PROJECT_ROLE_SLUGS,
  GLOBAL_ROLE_SCOPES,
  GLOBAL_ROLE_SLUGS,
  PROJECT_CUSTOM_ROLE_SCOPES,
  PROJECT_ROLE_SCOPES,
  RESOURCE_ROLE_SCOPES,
  RESOURCE_ROLE_SLUGS,
  type Scope,
} from '@workflow/workflow';
import type { CustomRole, RolesMap } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, notImplemented } from './mock-http';

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
      const usedByUsers = members.filter((m) => (m.globalRole ?? m.role) === role.slug).length;
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
  // stub (L23): one role, create, update, delete, assignments and members
  backend.on('GET', '/roles/:slug', () => notImplemented('L23'));
  backend.on('POST', '/roles', () => notImplemented('L23'));
  backend.on('PATCH', '/roles/:slug', () => notImplemented('L23'));
  backend.on('DELETE', '/roles/:slug', () => notImplemented('L23'));
  backend.on('GET', '/roles/:slug/assignments', () => notImplemented('L23'));
  backend.on('GET', '/roles/:slug/assignments/:projectId/members', () => notImplemented('L23'));
  backend.on('GET', '/roles/:slug/members', () => notImplemented('L23'));
}
