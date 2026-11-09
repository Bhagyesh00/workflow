/**
 * Custom roles (P6-32, L11): system roles live in code (workflow/src/permissions), custom project and
 * global roles in `roles` per workspace (`repos.roles`). Writes need `role:manage`, or
 * `role:manageProject` for project roles; scopes come from the allow lists (`customRoleAllowedScopes`);
 * a global custom role gets n8n's baseline. Texts as n8n: "Cannot delete system roles", "Cannot delete
 * role assigned to users" (unless `reassignRoleSlug`, global roles only, `user:changeRole`), "Cannot
 * update system roles", `A role with the name "..." already exists`. S3's P6-11 adds `roleDeletionCheck`
 * to `delete`.
 */
import { randomBytes } from 'node:crypto';
import {
  ASSIGNABLE_PROJECT_ROLE_SLUGS,
  customRoleAllowedScopes,
  GLOBAL_ROLE_SCOPES,
  GLOBAL_ROLE_SLUGS,
  MANDATORY_INSTANCE_SCOPES,
  PROJECT_ROLE_SCOPES,
  PROJECT_ROLE_SLUGS,
  RESOURCE_ROLE_SCOPES,
  RESOURCE_ROLE_SLUGS,
  type Scope,
} from '@workflow/workflow';
import type { ServiceDeps } from '../context';
import type { CustomRoleRow, ProjectIcon } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { createRepositories } from '../repositories';
import { isUniqueViolation } from '../repositories/util';
import { MISSING_SCOPE_MESSAGE } from './access';

/** POST /roles */
export interface RoleCreateInput {
  /** 2 to 100 characters */
  displayName: string;
  /** at most 500 characters */
  description?: string;
  roleType: 'project' | 'global';
  scopes: Scope[];
}

/** PATCH /roles/:slug */
export interface RoleUpdateInput {
  displayName?: string;
  description?: string;
  scopes?: Scope[];
}

export interface RoleDeleteOptions {
  /** global roles only: move the members holding the role to this slug (needs `user:changeRole`) */
  reassignRoleSlug?: string;
  /** who deletes it (audit log, and the `user:changeRole` check of `reassignRoleSlug`) */
  actor?: AuthContext;
}

export type RoleKind = 'global' | 'project' | 'workflow' | 'credential' | 'secretsProviderConnection';

/** one role of the answers: the shape of the editor's `CustomRole` */
export interface RoleDTO {
  slug: string;
  displayName: string;
  description: string | null;
  systemRole: boolean;
  roleType: RoleKind;
  scopes: Scope[];
  usedByUsers?: number;
  usedByProjects?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** GET /roles: every role by type, as n8n's `AllRolesMap` */
export interface RolesMapDTO {
  global: RoleDTO[];
  project: RoleDTO[];
  workflow: RoleDTO[];
  credential: RoleDTO[];
  secretsProviderConnection: RoleDTO[];
}

export interface RoleAssignmentDTO {
  projectId: string;
  projectName: string;
  projectIcon: ProjectIcon | null;
  memberCount: number;
  lastAssigned: string | null;
}

export interface RoleMemberDTO {
  userId: string;
  name: string;
  email: string;
  role: string;
}

const SYSTEM_DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  'project:admin': 'Admin',
  'project:editor': 'Editor',
  'project:viewer': 'Viewer',
  'project:personalOwner': 'Personal Owner',
  'workflow:owner': 'Workflow Owner',
  'workflow:editor': 'Workflow Editor',
  'credential:owner': 'Credential Owner',
  'credential:user': 'Credential User',
  'secretsProviderConnection:owner': 'Secrets Provider Connection Owner',
  'secretsProviderConnection:user': 'Secrets Provider Connection User',
};

function missingScope(): ApiError {
  return new ApiError(403, 'forbidden', MISSING_SCOPE_MESSAGE);
}

function systemRole(slug: string, roleType: RoleKind, scopes: ReadonlySet<Scope>): RoleDTO {
  return {
    slug,
    displayName: SYSTEM_DISPLAY_NAMES[slug] ?? slug,
    description: null,
    systemRole: true,
    roleType,
    scopes: [...scopes],
  };
}

/** a role that lives in code, by slug */
function findSystemRole(slug: string): RoleDTO | undefined {
  if ((GLOBAL_ROLE_SLUGS as readonly string[]).includes(slug)) {
    return systemRole(slug, 'global', GLOBAL_ROLE_SCOPES[slug as keyof typeof GLOBAL_ROLE_SCOPES]);
  }
  if ((PROJECT_ROLE_SLUGS as readonly string[]).includes(slug)) {
    return systemRole(slug, 'project', PROJECT_ROLE_SCOPES[slug as keyof typeof PROJECT_ROLE_SCOPES]);
  }
  if ((RESOURCE_ROLE_SLUGS as readonly string[]).includes(slug)) {
    const kind = slug.slice(0, slug.indexOf(':')) as RoleKind;
    return systemRole(slug, kind, RESOURCE_ROLE_SCOPES[slug as keyof typeof RESOURCE_ROLE_SCOPES]);
  }
  return undefined;
}

function customRole(row: CustomRoleRow): RoleDTO {
  return {
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    systemRole: false,
    roleType: row.roleType,
    scopes: [...row.scopes],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** the slug of a new custom role: its type, the name in kebab case and a random suffix */
function slugFor(roleType: 'project' | 'global', displayName: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${roleType}:${base || 'role'}-${randomBytes(3).toString('hex')}`;
}

export class RoleService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private get access() {
    return this.deps.context().access;
  }

  /** the scopes a write on a role of this type needs: `role:manage`, or `role:manageProject` for a project role */
  private async assertManage(auth: AuthContext, roleType: 'project' | 'global'): Promise<void> {
    const scopes = await this.access.scopesForAuth(auth);
    // `role:manage` covers both types, `role:manageProject` project roles only
    if (!scopes.has('role:manage') && !(roleType === 'project' && scopes.has('role:manageProject'))) {
      throw missingScope();
    }
  }

  /** a caller of a write needs one of the two scopes before anything else is said about a slug */
  private async assertAnyManage(auth: AuthContext): Promise<void> {
    const scopes = await this.access.scopesForAuth(auth);
    if (!scopes.has('role:manage') && !scopes.has('role:manageProject')) throw missingScope();
  }

  /**
   * A role never gives what its writer lacks (an owner holds every scope): the scopes must all be in
   * `held`, the caller's scopes where the role applies.
   */
  private assertHeld(
    auth: AuthContext,
    scopes: Iterable<Scope>,
    held: ReadonlySet<Scope>,
    action = 'save the role',
  ): void {
    if (auth.role === 'owner') return;
    const missing = [...scopes].filter((scope) => !held.has(scope));
    if (missing.length) {
      throw ApiError.forbidden(`Couldn't ${action}: you don't have these scopes: ${missing.join(', ')}`);
    }
  }

  /**
   * The scopes an update adds must be the caller's where the role applies: in the workspace for a global
   * role, in every project that uses it for a project role (so a holder cannot widen its own role).
   */
  private async assertAddedHeld(auth: AuthContext, existing: CustomRoleRow, scopes: Scope[]): Promise<void> {
    const added = scopes.filter((scope) => !existing.scopes.includes(scope));
    if (!added.length || auth.role === 'owner') return;
    if (existing.roleType === 'global') {
      this.assertHeld(auth, added, await this.access.scopesForAuth(auth));
      return;
    }
    for (const { projectId } of await this.repos.roles.assignmentsOf(auth.tenant.id, existing.slug)) {
      this.assertHeld(auth, added, await this.access.scopesForAuth(auth, { projectId }));
    }
  }

  /** every scope must be on the type's allow list; a global role also gets n8n's baseline */
  private checkedScopes(roleType: 'project' | 'global', scopes: Scope[]): Scope[] {
    const allowed = customRoleAllowedScopes(roleType);
    const unique = [...new Set(scopes)];
    const refused = unique.filter((scope) => !allowed.has(scope));
    if (refused.length) {
      throw ApiError.badRequest(
        `The following scopes are not allowed for ${roleType} roles: ${refused.join(', ')}`,
      );
    }
    return roleType === 'global' ? [...new Set([...unique, ...MANDATORY_INSTANCE_SCOPES])] : unique;
  }

  /** a name no other role of the workspace has (case-insensitive), nor a system role of the type */
  private async assertNameFree(
    tenantId: string,
    roleType: 'project' | 'global',
    displayName: string,
    exceptSlug?: string,
  ): Promise<void> {
    const wanted = displayName.trim().toLowerCase();
    const custom = await this.repos.roles.list(tenantId);
    const clash =
      custom.some((r) => r.slug !== exceptSlug && r.displayName.toLowerCase() === wanted) ||
      Object.entries(SYSTEM_DISPLAY_NAMES).some(
        ([slug, name]) => findSystemRole(slug)?.roleType === roleType && name.toLowerCase() === wanted,
      );
    if (clash) throw ApiError.conflict(`A role with the name "${displayName}" already exists`);
  }

  private async audit(
    auth: AuthContext | undefined,
    tenantId: string,
    action: string,
    slug: string,
    metadata: Record<string, unknown> = {},
    repos = this.repos,
  ): Promise<void> {
    await repos.audit.add(tenantId, {
      userId: auth?.user.id ?? null,
      action,
      resourceType: 'role',
      resourceId: slug,
      metadata: { ...metadata, slug },
    });
  }

  private async find(tenantId: string, slug: string): Promise<RoleDTO | undefined> {
    const system = findSystemRole(slug);
    if (system) return system;
    const row = await this.repos.roles.get(tenantId, slug);
    return row ? customRole(row) : undefined;
  }

  private withUsage(role: RoleDTO, usage: Map<string, { users: number; projects: number }> | null): RoleDTO {
    if (!usage || (role.roleType !== 'global' && role.roleType !== 'project')) return role;
    const used = usage.get(role.slug);
    return role.roleType === 'global'
      ? { ...role, usedByUsers: used?.users ?? 0 }
      : { ...role, usedByUsers: used?.users ?? 0, usedByProjects: used?.projects ?? 0 };
  }

  /** every role grouped by type (system and custom), with usage counts when asked */
  async list(auth: AuthContext, options: { withUsageCount?: boolean } = {}): Promise<RolesMapDTO> {
    const tenantId = auth.tenant.id;
    const usage = options.withUsageCount ? await this.repos.roles.usageBySlug(tenantId) : null;
    const custom = (await this.repos.roles.list(tenantId)).map(customRole);
    const system = (slugs: readonly string[]) =>
      slugs.map((slug) => findSystemRole(slug)).filter((r): r is RoleDTO => r !== undefined);
    const resource = (prefix: string) =>
      system(RESOURCE_ROLE_SLUGS.filter((slug) => slug.startsWith(`${prefix}:`)));
    return {
      global: [...system(GLOBAL_ROLE_SLUGS), ...custom.filter((r) => r.roleType === 'global')].map((r) =>
        this.withUsage(r, usage),
      ),
      project: [
        ...system(ASSIGNABLE_PROJECT_ROLE_SLUGS),
        ...custom.filter((r) => r.roleType === 'project'),
      ].map((r) => this.withUsage(r, usage)),
      workflow: resource('workflow'),
      credential: resource('credential'),
      secretsProviderConnection: resource('secretsProviderConnection'),
    };
  }

  async get(auth: AuthContext, slug: string, options: { withUsageCount?: boolean } = {}): Promise<RoleDTO> {
    const role = await this.find(auth.tenant.id, slug);
    if (!role) throw ApiError.notFound(`Role "${slug}"`);
    const usage = options.withUsageCount ? await this.repos.roles.usageBySlug(auth.tenant.id) : null;
    return this.withUsage(role, usage);
  }

  async create(auth: AuthContext, input: RoleCreateInput): Promise<RoleDTO> {
    await this.assertManage(auth, input.roleType);
    const tenantId = auth.tenant.id;
    const scopes = this.checkedScopes(input.roleType, input.scopes);
    // a project role gives nothing until a project member manager assigns it there
    if (input.roleType === 'global') this.assertHeld(auth, scopes, await this.access.scopesForAuth(auth));
    await this.assertNameFree(tenantId, input.roleType, input.displayName);
    let row: CustomRoleRow;
    try {
      row = await this.repos.roles.create(tenantId, {
        slug: slugFor(input.roleType, input.displayName),
        displayName: input.displayName,
        description: input.description ?? null,
        roleType: input.roleType,
        scopes,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiError.conflict(`A role with the name "${input.displayName}" already exists`);
      }
      throw error;
    }
    await this.audit(auth, tenantId, 'role.created', row.slug, { roleType: row.roleType });
    return customRole(row);
  }

  async update(auth: AuthContext, slug: string, patch: RoleUpdateInput): Promise<RoleDTO> {
    const tenantId = auth.tenant.id;
    await this.assertAnyManage(auth);
    const system = findSystemRole(slug);
    if (system) {
      if (system.roleType === 'global' || system.roleType === 'project') {
        await this.assertManage(auth, system.roleType);
      }
      throw ApiError.badRequest('Cannot update system roles');
    }
    const existing = await this.repos.roles.get(tenantId, slug);
    if (!existing) throw ApiError.notFound(`Role "${slug}"`);
    await this.assertManage(auth, existing.roleType);
    const scopes = patch.scopes ? this.checkedScopes(existing.roleType, patch.scopes) : undefined;
    if (scopes) await this.assertAddedHeld(auth, existing, scopes);
    if (patch.displayName !== undefined) {
      await this.assertNameFree(tenantId, existing.roleType, patch.displayName, slug);
    }
    let row: CustomRoleRow | undefined;
    try {
      row = await this.repos.roles.update(tenantId, slug, {
        displayName: patch.displayName,
        description: patch.description,
        scopes,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiError.conflict(`A role with the name "${patch.displayName}" already exists`);
      }
      throw error;
    }
    if (!row) throw ApiError.notFound(`Role "${slug}"`);
    await this.audit(auth, tenantId, 'role.updated', slug, { fields: Object.keys(patch) });
    return customRole(row);
  }

  async delete(tenantId: string, slug: string, options: RoleDeleteOptions = {}): Promise<RoleDTO> {
    const { actor } = options;
    if (actor) await this.assertAnyManage(actor);
    const system = findSystemRole(slug);
    if (system) {
      if (actor && (system.roleType === 'global' || system.roleType === 'project')) {
        await this.assertManage(actor, system.roleType);
      }
      throw ApiError.badRequest('Cannot delete system roles');
    }
    const existing = await this.repos.roles.get(tenantId, slug);
    if (!existing) throw ApiError.notFound(`Role "${slug}"`);
    if (actor) await this.assertManage(actor, existing.roleType);

    // as n8n: a holder of the role cannot move its holders, itself among them, to another role
    const reassignTo = actor?.role === slug ? undefined : options.reassignRoleSlug;
    const inUse = (await this.repos.roles.usageBySlug(tenantId)).get(slug);
    // a pending invitation that gives the role is a holder too
    const held = (inUse?.users ?? 0) > 0 || (await this.repos.roles.pendingInvitations(tenantId, slug)) > 0;
    if (held && !(reassignTo && existing.roleType === 'global')) {
      throw ApiError.badRequest('Cannot delete role assigned to users');
    }
    if (held && reassignTo) {
      if (actor && !(await this.access.scopesForAuth(actor)).has('user:changeRole')) throw missingScope();
      const target =
        reassignTo === slug || reassignTo === 'owner' ? undefined : await this.find(tenantId, reassignTo);
      if (target?.roleType !== 'global') {
        throw ApiError.badRequest(`Cannot reassign the members to the role "${reassignTo}"`);
      }
      // `member` is the floor every workspace user starts from
      if (actor && reassignTo !== 'member') {
        this.assertHeld(
          actor,
          await this.access.globalScopes(tenantId, reassignTo),
          await this.access.scopesForAuth(actor),
          'move the members',
        );
      }
    }

    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      const moved = held && reassignTo ? await repos.roles.reassignMembers(tenantId, slug, reassignTo) : 0;
      if (!(await repos.roles.delete(tenantId, slug))) throw ApiError.notFound(`Role "${slug}"`);
      await this.audit(
        actor,
        tenantId,
        'role.deleted',
        slug,
        { roleType: existing.roleType, reassignedTo: reassignTo ?? null, moved },
        repos,
      );
    });
    return customRole(existing);
  }

  /** the project role `slug` (system or custom), or 404 */
  private async projectRole(tenantId: string, slug: string): Promise<RoleDTO> {
    const role = await this.find(tenantId, slug);
    if (role?.roleType !== 'project') throw ApiError.notFound(`Role "${slug}"`);
    return role;
  }

  /** the projects that use a project role, limited to those the caller can list */
  async assignments(
    auth: AuthContext,
    slug: string,
  ): Promise<{ projects: RoleAssignmentDTO[]; totalProjects: number }> {
    const tenantId = auth.tenant.id;
    await this.projectRole(tenantId, slug);
    const visible = new Set(await this.access.accessibleProjectIds(auth, 'project:list'));
    const rows = (await this.repos.roles.assignmentsOf(tenantId, slug)).filter((r) =>
      visible.has(r.projectId),
    );
    const projects = rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      projectIcon: r.projectIcon ?? null,
      memberCount: r.memberCount,
      lastAssigned: r.lastAssigned ? new Date(r.lastAssigned).toISOString() : null,
    }));
    return { projects, totalProjects: projects.length };
  }

  /** the members of one project holding the role (the project must be listable by the caller) */
  async projectMembers(
    auth: AuthContext,
    slug: string,
    projectId: string,
  ): Promise<{ members: RoleMemberDTO[]; total: number }> {
    const tenantId = auth.tenant.id;
    await this.projectRole(tenantId, slug);
    const project = await this.repos.projects.get(tenantId, projectId);
    if (!project) throw ApiError.notFound('Project');
    const visible = await this.access.accessibleProjectIds(auth, 'project:list');
    if (!visible.includes(project.id)) throw missingScope();
    const members = await this.repos.roles.projectMembersWithRole(tenantId, project.id, slug);
    return { members, total: members.length };
  }

  /** the workspace members holding a global role */
  async members(auth: AuthContext, slug: string): Promise<{ members: RoleMemberDTO[]; total: number }> {
    const tenantId = auth.tenant.id;
    const role = await this.find(tenantId, slug);
    if (role?.roleType !== 'global') throw ApiError.notFound(`Role "${slug}"`);
    const members = await this.repos.roles.membersWithRole(tenantId, slug);
    return { members, total: members.length };
  }
}
