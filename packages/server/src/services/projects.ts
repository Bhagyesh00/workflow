/**
 * Projects (P6-03, L1): n8n's `/rest/projects`. The route gates live in routes/projects.ts
 * (`requireScope`); this service re-checks what a route cannot: personal project rules, member roles,
 * the team project limit `PlanLimits.maxTeamProjects` and transfer targets. Every query filters tenant_id.
 */
import {
  ASSIGNABLE_PROJECT_ROLE_SLUGS,
  IMPLICIT_TEAM_PROJECT_MEMBER_ROLES,
  type Scope,
} from '@workflow/workflow';
import { sql } from 'drizzle-orm';
import type { ServiceDeps } from '../context';
import type { ProjectIcon, ProjectRow } from '../db/schema';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import { effectiveLimits, type TenantSettings } from '../plans';
import { createRepositories } from '../repositories';
import { PERSONAL_OWNER_ROLE } from '../repositories/projects';
import { MISSING_SCOPE_MESSAGE } from './access';

/** GET /projects: a bare array, or `{ count, data }` when `take` or `skip` is given */
export interface ProjectListQuery {
  take?: number;
  skip?: number;
}

/** POST /projects (`project:create`); the caller becomes `project:admin` */
export interface ProjectCreateInput {
  name: string;
  icon?: ProjectIcon | null;
  description?: string | null;
}

/** PATCH /projects/:projectId (`project:update`) */
export interface ProjectUpdateInput {
  name?: string;
  icon?: ProjectIcon | null;
  description?: string | null;
}

/** one member of POST /projects/:projectId/users: a project role slug, system or custom */
export interface ProjectRelationInput {
  userId: string;
  role: string;
}

/** DELETE /projects/:projectId?transferId=: move the work to `transferId`, else delete it */
export interface ProjectDeleteOptions {
  transferId?: string;
}

/** a row of the lists: the project with the caller's role and scopes on it */
export interface ProjectListRow {
  id: string;
  name: string;
  type: 'personal' | 'team';
  icon: ProjectIcon | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** the caller's project role; absent when the caller reaches the project through a global role */
  role?: string;
  scopes: Scope[];
}

export interface ProjectRelationDTO {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface ProjectImplicitMemberDTO {
  id: string;
  email: string;
  name: string;
  globalRole: { slug: string; displayName: string };
}

export interface ProjectDetailDTO extends ProjectListRow {
  relations: ProjectRelationDTO[];
  implicitMembers: ProjectImplicitMemberDTO[];
  customTelemetryTags: unknown[];
  creatorId: string | null;
}

export interface ProjectConflict {
  userId: string;
  currentRole: string;
  requestedRole: string;
}

/** what `addUsers` did; the route turns it into 201, 409 or 200 */
export interface ProjectAddUsersResult {
  added: number;
  conflicts: ProjectConflict[];
}

const GLOBAL_ROLE_NAMES: Record<string, string> = { owner: 'Owner', admin: 'Admin' };

function missingScope(): ApiError {
  return new ApiError(403, 'forbidden', MISSING_SCOPE_MESSAGE);
}

export class ProjectService {
  constructor(readonly deps: ServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private get access() {
    return this.deps.context().access;
  }

  /**
   * The projects the caller sees: those they have a relation on, and, with the global `project:list`, every
   * team project too. Another member's personal project is never listed.
   */
  private async visible(auth: AuthContext): Promise<Array<{ project: ProjectRow; role?: string }>> {
    const tenantId = auth.tenant.id;
    const mine = await this.repos.projects.listForUser(tenantId, auth.user.id);
    const roles = new Map(mine.map((p) => [p.id, p.role]));
    const global = await this.access.scopesForAuth(auth);
    if (!global.has('project:list')) {
      return mine.map(({ role, ...project }) => ({ project, role }));
    }
    const all = await this.repos.projects.listAll(tenantId);
    return all
      .filter((p) => p.type === 'team' || p.ownerUserId === auth.user.id)
      .map((project) => ({ project, role: roles.get(project.id) }));
  }

  private async scopesOf(auth: AuthContext, projectId: string): Promise<Scope[]> {
    return [...(await this.access.scopesForAuth(auth, { projectId }))].sort();
  }

  private async row(
    auth: AuthContext,
    project: ProjectRow,
    role: string | undefined,
  ): Promise<ProjectListRow> {
    return {
      id: project.id,
      name: project.name,
      type: project.type,
      icon: project.icon ?? null,
      description: project.description ?? null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(role ? { role } : {}),
      scopes: await this.scopesOf(auth, project.id),
    };
  }

  private async detail(auth: AuthContext, project: ProjectRow): Promise<ProjectDetailDTO> {
    const tenantId = auth.tenant.id;
    const relations = await this.repos.projects.relations.listForProject(tenantId, project.id);
    const own = relations.find((r) => r.userId === auth.user.id)?.role;
    const implicitMembers: ProjectImplicitMemberDTO[] = [];
    if (project.type === 'team') {
      for (const member of await this.repos.memberships.listForTenant(tenantId)) {
        if (!(IMPLICIT_TEAM_PROJECT_MEMBER_ROLES as readonly string[]).includes(member.role)) continue;
        implicitMembers.push({
          id: member.userId,
          email: member.email,
          name: member.name,
          globalRole: { slug: member.role, displayName: GLOBAL_ROLE_NAMES[member.role] ?? member.role },
        });
      }
    }
    return {
      ...(await this.row(auth, project, own)),
      relations: relations.map((r) => ({ id: r.userId, email: r.email, name: r.name, role: r.role })),
      implicitMembers,
      customTelemetryTags: project.customTelemetryTags ?? [],
      creatorId: project.creatorId ?? null,
    };
  }

  private async require(tenantId: string, projectId: string): Promise<ProjectRow> {
    const project = await this.repos.projects.get(tenantId, projectId);
    if (!project) throw ApiError.notFound('Project');
    return project;
  }

  /** a project role slug a member may be given: the three system roles or a custom role of type project */
  private async assertAssignableRole(tenantId: string, role: string): Promise<void> {
    if (role === PERSONAL_OWNER_ROLE) {
      throw ApiError.badRequest("Can't add a personalOwner to a team project.");
    }
    if ((ASSIGNABLE_PROJECT_ROLE_SLUGS as readonly string[]).includes(role)) return;
    const custom = await this.repos.roles.get(tenantId, role);
    if (custom?.roleType !== 'project') throw ApiError.badRequest(`Unknown project role "${role}"`);
  }

  private async audit(
    auth: AuthContext,
    action: string,
    projectId: string,
    metadata: Record<string, unknown> = {},
    repos = this.repos,
  ): Promise<void> {
    await repos.audit.add(auth.tenant.id, {
      userId: auth.user.id,
      action,
      resourceType: 'project',
      resourceId: projectId,
      metadata: { ...metadata, projectId },
    });
  }

  /** the projects the caller can see (team projects they relate to, all for `project:list` holders) */
  async list(
    auth: AuthContext,
    query: ProjectListQuery = {},
  ): Promise<ProjectListRow[] | { count: number; data: ProjectListRow[] }> {
    const visible = await this.visible(auth);
    const paged = query.take !== undefined || query.skip !== undefined;
    const skip = query.skip ?? 0;
    const slice = paged
      ? visible.slice(skip, query.take === undefined ? undefined : skip + query.take)
      : visible;
    const data = await Promise.all(slice.map((v) => this.row(auth, v.project, v.role)));
    return paged ? { count: visible.length, data } : data;
  }

  /** counts by type (personal, team) of what the caller sees */
  async count(auth: AuthContext): Promise<{ personal: number; team: number }> {
    const out = { personal: 0, team: 0 };
    for (const { project } of await this.visible(auth)) out[project.type] += 1;
    return out;
  }

  /**
   * `user:list`: the projects a resource can be shared with, peers' personal projects included. A team
   * project is offered only when the caller can see it.
   */
  async sharingCandidates(
    auth: AuthContext,
  ): Promise<Array<{ id: string; name: string; type: 'personal' | 'team'; icon: ProjectIcon | null }>> {
    const team = (await this.visible(auth)).filter((v) => v.project.type === 'team').map((v) => v.project);
    const personal = (await this.repos.projects.listAll(auth.tenant.id)).filter((p) => p.type === 'personal');
    return [...personal, ...team].map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      icon: p.icon ?? null,
    }));
  }

  async create(auth: AuthContext, input: ProjectCreateInput): Promise<ProjectDetailDTO> {
    const tenantId = auth.tenant.id;
    const limit = effectiveLimits(auth.tenant.plan, auth.tenant.settings as TenantSettings).maxTeamProjects;
    const project = await this.deps.database.db.transaction(async (tx) => {
      // one create at a time per workspace, so two calls cannot both pass the limit
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`projects:${tenantId}`}))`);
      const repos = createRepositories(tx);
      if (limit !== null && (await repos.projects.countTeam(tenantId)) >= limit) {
        throw ApiError.planLimit(
          `Attempted to create a new project but quota is already exhausted. You may have a maximum of ${limit} team projects`,
        );
      }
      const created = await repos.projects.create(tenantId, {
        name: input.name,
        type: 'team',
        icon: input.icon,
        description: input.description,
        creatorId: auth.user.id,
      });
      await repos.projects.relations.add(tenantId, created.id, auth.user.id, 'project:admin');
      await this.audit(auth, 'project.created', created.id, { name: created.name }, repos);
      return created;
    });
    return this.detail(auth, project);
  }

  /** the caller's own projects, each with the caller's role and scopes */
  async myProjects(auth: AuthContext): Promise<ProjectListRow[]> {
    const mine = await this.repos.projects.listForUser(auth.tenant.id, auth.user.id);
    return Promise.all(mine.map(({ role, ...project }) => this.row(auth, project, role)));
  }

  /** the caller's personal project with its scopes */
  async personal(auth: AuthContext): Promise<ProjectDetailDTO> {
    const project = await this.repos.projects.ensurePersonal(auth.tenant.id, auth.user);
    return this.detail(auth, project);
  }

  /** one project with its relations, implicit members and the caller's scopes */
  async get(auth: AuthContext, projectId: string): Promise<ProjectDetailDTO> {
    return this.detail(auth, await this.require(auth.tenant.id, projectId));
  }

  async update(auth: AuthContext, projectId: string, patch: ProjectUpdateInput): Promise<ProjectDetailDTO> {
    const tenantId = auth.tenant.id;
    const project = await this.require(tenantId, projectId);
    if (project.type === 'personal') throw ApiError.badRequest("Can't update a personal project.");
    const changes: ProjectUpdateInput = {};
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.icon !== undefined) changes.icon = patch.icon;
    if (patch.description !== undefined) changes.description = patch.description;
    const updated = (await this.repos.projects.update(tenantId, projectId, changes)) ?? project;
    await this.audit(auth, 'project.updated', projectId, { fields: Object.keys(changes) });
    return this.detail(auth, updated);
  }

  /** 201 with `conflicts`, 409 when none was added, 200 when nothing to do (the route sets the status) */
  async addUsers(
    auth: AuthContext,
    projectId: string,
    relations: ProjectRelationInput[],
  ): Promise<ProjectAddUsersResult> {
    const tenantId = auth.tenant.id;
    const project = await this.require(tenantId, projectId);
    if (project.type === 'personal') throw ApiError.badRequest("Can't add users to personal projects.");

    for (const role of new Set(relations.map((r) => r.role))) await this.assertAssignableRole(tenantId, role);
    const wanted = new Map<string, string>();
    for (const relation of relations) {
      if (!wanted.has(relation.userId)) wanted.set(relation.userId, relation.role);
    }

    const toAdd: ProjectRelationInput[] = [];
    const conflicts: ProjectConflict[] = [];
    for (const [userId, role] of wanted) {
      const membership = await this.repos.memberships.get(tenantId, userId);
      if (!membership) throw ApiError.notFound('User');
      // owners and admins already reach every team project
      if ((IMPLICIT_TEAM_PROJECT_MEMBER_ROLES as readonly string[]).includes(membership.role)) continue;
      const existing = await this.repos.projects.relations.get(tenantId, projectId, userId);
      if (!existing) toAdd.push({ userId, role });
      else if (existing.role !== role) {
        conflicts.push({ userId, currentRole: existing.role, requestedRole: role });
      }
    }

    let added = 0;
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      for (const { userId, role } of toAdd) {
        if (await repos.projects.relations.add(tenantId, projectId, userId, role)) {
          added += 1;
          await this.audit(auth, 'project.member.added', projectId, { userId, role }, repos);
        } else {
          // a concurrent call added it first: its role is kept
          const current = await repos.projects.relations.get(tenantId, projectId, userId);
          conflicts.push({ userId, currentRole: current?.role ?? role, requestedRole: role });
        }
      }
    });
    return { added, conflicts };
  }

  async changeUserRole(auth: AuthContext, projectId: string, userId: string, role: string): Promise<void> {
    const tenantId = auth.tenant.id;
    await this.require(tenantId, projectId);
    const relation = await this.repos.projects.relations.get(tenantId, projectId, userId);
    if (!relation) throw ApiError.notFound('Project member');
    if (relation.role === PERSONAL_OWNER_ROLE) {
      throw ApiError.badRequest("Can't change the role of a project owner.");
    }
    await this.assertAssignableRole(tenantId, role);
    if (!(await this.repos.projects.relations.updateRole(tenantId, projectId, userId, role))) {
      throw ApiError.notFound('Project member');
    }
    await this.audit(auth, 'project.member.role_changed', projectId, {
      userId,
      from: relation.role,
      to: role,
    });
  }

  async removeUser(auth: AuthContext, projectId: string, userId: string): Promise<void> {
    const tenantId = auth.tenant.id;
    await this.require(tenantId, projectId);
    const relation = await this.repos.projects.relations.get(tenantId, projectId, userId);
    if (!relation) throw ApiError.notFound('Project member');
    if (relation.role === PERSONAL_OWNER_ROLE) {
      throw ApiError.badRequest('Project owner cannot be removed from the project');
    }
    await this.repos.projects.relations.remove(tenantId, projectId, userId);
    await this.audit(auth, 'project.member.removed', projectId, { userId, role: relation.role });
  }

  /** a team project only; moves its work through `repos.projects.moveResources` or deletes it */
  async delete(auth: AuthContext, projectId: string, options: ProjectDeleteOptions = {}): Promise<void> {
    const tenantId = auth.tenant.id;
    const project = await this.require(tenantId, projectId);
    if (project.type !== 'team') {
      throw ApiError.badRequest(`Can't delete project. Project with ID ${projectId} is not a team project.`);
    }
    const contents = await this.repos.projects.contents(tenantId, projectId);

    if (options.transferId !== undefined) {
      if (options.transferId === projectId) {
        throw ApiError.badRequest("Can't move the work of a project into the project that is being deleted.");
      }
      const target = await this.require(tenantId, options.transferId);
      const scopes = await this.access.scopesForAuth(auth, { projectId: target.id });
      for (const scope of ['credential:create', 'workflow:create', 'dataTable:create'] as const) {
        if (!scopes.has(scope)) throw missingScope();
      }
      const clashes = await this.repos.projects.dataTableNamesIn(
        tenantId,
        target.id,
        contents.dataTables.map((t) => t.name),
      );
      if (clashes.length) {
        throw ApiError.conflict(
          `Can't delete project. The target project already has data tables named: ${clashes.join(', ')}. Rename them first.`,
          { dataTables: clashes },
        );
      }
      await this.deps.database.db.transaction(async (tx) => {
        const repos = createRepositories(tx);
        const moved = await repos.projects.moveResources(tenantId, projectId, target.id);
        await repos.projects.delete(tenantId, projectId);
        await this.audit(auth, 'project.deleted', projectId, { transferId: target.id, moved }, repos);
      });
      return;
    }

    const { workflows, dataTables } = this.deps.context();
    const actor = { userId: auth.user.id };
    for (const id of contents.workflowIds) await workflows.delete(tenantId, id, actor, { force: true });
    for (const table of contents.dataTables) await dataTables.delete(tenantId, table.id);
    await this.deps.database.db.transaction(async (tx) => {
      const repos = createRepositories(tx);
      for (const id of contents.credentialIds) await repos.credentials.delete(tenantId, id);
      for (const id of contents.folderIds) {
        await repos.favorites.removeForResource(tenantId, 'folder', id);
        await repos.folders.delete(tenantId, id);
      }
      await repos.projects.delete(tenantId, projectId);
      await this.audit(auth, 'project.deleted', projectId, { transferId: null, wiped: true }, repos);
    });
  }
}
