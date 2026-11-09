/**
 * Projects (P6-03) and project relations. Every workspace has team projects and one personal project per
 * member (`owner_user_id`); a member reaches a project through a `project_relations` row with a project
 * role slug (`project:admin`, `project:editor`, `project:viewer`, `project:personalOwner` or a custom
 * project role). Every query filters tenant_id.
 */
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  credentialShares,
  credentials,
  dataTables,
  folders,
  type ProjectIcon,
  type ProjectRelationRow,
  type ProjectRow,
  projectRelations,
  projects,
  tenants,
  type UserRow,
  users,
  workflowShares,
  workflows,
} from '../db/schema';
import { isUuid, now } from './util';

/** the role a personal project's owner holds on it */
export const PERSONAL_OWNER_ROLE = 'project:personalOwner';

export interface ProjectCreateInput {
  name: string;
  type: 'personal' | 'team';
  icon?: ProjectIcon | null;
  description?: string | null;
  /** personal projects only: the member it belongs to */
  ownerUserId?: string | null;
  creatorId?: string | null;
}

export interface ProjectPatch {
  name?: string;
  icon?: ProjectIcon | null;
  description?: string | null;
  customTelemetryTags?: unknown[];
}

/** a project with the caller's role on it */
export type UserProjectRecord = ProjectRow & { role: string };

/** a project relation with the member's name and email (the members table) */
export type ProjectMemberRecord = ProjectRelationRow & { email: string; name: string };

/** what `moveResources` moved */
export interface MovedResources {
  workflows: number;
  credentials: number;
  folders: number;
  dataTables: number;
}

export class ProjectRelationRepository {
  constructor(private readonly db: DbOrTx) {}

  async get(tenantId: string, projectId: string, userId: string): Promise<ProjectRelationRow | undefined> {
    if (!isUuid(projectId) || !isUuid(userId)) return undefined;
    const [row] = await this.db
      .select()
      .from(projectRelations)
      .where(
        and(
          eq(projectRelations.tenantId, tenantId),
          eq(projectRelations.projectId, projectId),
          eq(projectRelations.userId, userId),
        ),
      );
    return row;
  }

  /** the members of a project, oldest relation first */
  async listForProject(tenantId: string, projectId: string): Promise<ProjectMemberRecord[]> {
    if (!isUuid(projectId)) return [];
    const rows = await this.db
      .select({ relation: projectRelations, email: users.email, name: users.name })
      .from(projectRelations)
      .innerJoin(users, eq(users.id, projectRelations.userId))
      .where(and(eq(projectRelations.tenantId, tenantId), eq(projectRelations.projectId, projectId)))
      .orderBy(asc(projectRelations.createdAt), asc(projectRelations.userId));
    return rows.map((row) => ({ ...row.relation, email: row.email, name: row.name }));
  }

  /** every relation of one member in this workspace */
  async listForUser(tenantId: string, userId: string): Promise<ProjectRelationRow[]> {
    if (!isUuid(userId)) return [];
    return this.db
      .select()
      .from(projectRelations)
      .where(and(eq(projectRelations.tenantId, tenantId), eq(projectRelations.userId, userId)))
      .orderBy(asc(projectRelations.createdAt), asc(projectRelations.projectId));
  }

  /** true when the relation was added; false when the member already had one (its role is kept) */
  async add(tenantId: string, projectId: string, userId: string, role: string): Promise<boolean> {
    if (!isUuid(projectId) || !isUuid(userId)) return false;
    const rows = await this.db
      .insert(projectRelations)
      .values({ tenantId, projectId, userId, role, createdAt: now() })
      .onConflictDoNothing()
      .returning({ userId: projectRelations.userId });
    return rows.length > 0;
  }

  async updateRole(tenantId: string, projectId: string, userId: string, role: string): Promise<boolean> {
    if (!isUuid(projectId) || !isUuid(userId)) return false;
    const rows = await this.db
      .update(projectRelations)
      .set({ role })
      .where(
        and(
          eq(projectRelations.tenantId, tenantId),
          eq(projectRelations.projectId, projectId),
          eq(projectRelations.userId, userId),
        ),
      )
      .returning({ userId: projectRelations.userId });
    return rows.length > 0;
  }

  async remove(tenantId: string, projectId: string, userId: string): Promise<boolean> {
    if (!isUuid(projectId) || !isUuid(userId)) return false;
    const rows = await this.db
      .delete(projectRelations)
      .where(
        and(
          eq(projectRelations.tenantId, tenantId),
          eq(projectRelations.projectId, projectId),
          eq(projectRelations.userId, userId),
        ),
      )
      .returning({ userId: projectRelations.userId });
    return rows.length > 0;
  }
}

export class ProjectRepository {
  readonly relations: ProjectRelationRepository;

  constructor(private readonly db: DbOrTx) {
    this.relations = new ProjectRelationRepository(db);
  }

  async create(tenantId: string, input: ProjectCreateInput): Promise<ProjectRow> {
    const [row] = await this.db
      .insert(projects)
      .values({
        tenantId,
        name: input.name,
        type: input.type,
        icon: input.icon ?? null,
        description: input.description ?? null,
        ownerUserId: input.type === 'personal' ? (input.ownerUserId ?? null) : null,
        creatorId: input.creatorId ?? null,
        createdAt: now(),
        updatedAt: now(),
      })
      .returning();
    return row;
  }

  async get(tenantId: string, id: string): Promise<ProjectRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, id)));
    return row;
  }

  /** the member's personal project in this workspace */
  async getPersonal(tenantId: string, userId: string): Promise<ProjectRow | undefined> {
    if (!isUuid(userId)) return undefined;
    const [row] = await this.db
      .select()
      .from(projects)
      .where(
        and(eq(projects.tenantId, tenantId), eq(projects.type, 'personal'), eq(projects.ownerUserId, userId)),
      );
    return row;
  }

  /**
   * The member's personal project, made on first use (named after the user, as migration 0022), with the
   * owner's `project:personalOwner` relation. The membership must exist (the project's foreign key).
   */
  async ensurePersonal(tenantId: string, user: Pick<UserRow, 'id' | 'name'>): Promise<ProjectRow> {
    let project = await this.getPersonal(tenantId, user.id);
    if (!project) {
      const [created] = await this.db
        .insert(projects)
        .values({
          tenantId,
          name: user.name.slice(0, 255),
          type: 'personal',
          ownerUserId: user.id,
          creatorId: user.id,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing()
        .returning();
      // a concurrent call made it first
      project = created ?? (await this.getPersonal(tenantId, user.id));
      if (!project) throw new Error('The personal project could not be made');
    }
    await this.relations.add(tenantId, project.id, user.id, PERSONAL_OWNER_ROLE);
    return project;
  }

  /** the workspace's oldest team project */
  async oldestTeam(tenantId: string): Promise<ProjectRow | undefined> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.type, 'team')))
      .orderBy(asc(projects.createdAt), asc(projects.id))
      .limit(1);
    return row;
  }

  /**
   * The project a create without a `projectId` goes to until the cutover: the oldest team project, made
   * (named after the workspace, as migration 0022) when the workspace has none. L24 removes it.
   */
  async defaultProjectFor(tenantId: string): Promise<string> {
    const existing = await this.oldestTeam(tenantId);
    if (existing) return existing.id;
    const [tenant] = await this.db
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant) throw new Error('The workspace does not exist');
    await this.create(tenantId, { name: tenant.name.slice(0, 255), type: 'team' });
    // two first calls may each make one; the oldest wins for both
    const oldest = await this.oldestTeam(tenantId);
    if (!oldest) throw new Error('The default project could not be made');
    return oldest.id;
  }

  /** the projects the member has a relation on, with that role; personal first, then by name */
  async listForUser(tenantId: string, userId: string): Promise<UserProjectRecord[]> {
    if (!isUuid(userId)) return [];
    const rows = await this.db
      .select({ project: projects, role: projectRelations.role })
      .from(projectRelations)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, projectRelations.tenantId), eq(projects.id, projectRelations.projectId)),
      )
      .where(and(eq(projectRelations.tenantId, tenantId), eq(projectRelations.userId, userId)))
      .orderBy(sql`${projects.type} = 'team'`, asc(projects.name), asc(projects.id));
    return rows.map((row) => ({ ...row.project, role: row.role }));
  }

  /** every project of the workspace (owners and admins see them all); personal first, then by name */
  async listAll(tenantId: string): Promise<ProjectRow[]> {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.tenantId, tenantId))
      .orderBy(sql`${projects.type} = 'team'`, asc(projects.name), asc(projects.id));
  }

  /** team projects of the workspace (the `maxTeamProjects` limit) */
  async countTeam(tenantId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.type, 'team')));
    return row?.n ?? 0;
  }

  async update(tenantId: string, id: string, patch: ProjectPatch): Promise<ProjectRow | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await this.db
      .update(projects)
      .set({ ...patch, updatedAt: now() })
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, id)))
      .returning();
    return row;
  }

  /**
   * Deletes the project; its relations, shares into it, project variables and vault connections go with it.
   * Its workflows, credentials, folders and data tables must be moved (`moveResources`) or deleted first:
   * the foreign keys refuse the delete otherwise.
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const rows = await this.db
      .delete(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, id)))
      .returning({ id: projects.id });
    return rows.length > 0;
  }

  /**
   * Moves every workflow, credential, folder (with its tree) and data table of `fromId` to `toId`, in one
   * transaction. Shares the target project held on a moved row are dropped (it owns the row now); other
   * shares stay. A data table whose name the target already uses makes the move fail (unique per
   * project), so the caller checks names first.
   */
  async moveResources(tenantId: string, fromId: string, toId: string): Promise<MovedResources> {
    if (!isUuid(fromId) || !isUuid(toId) || fromId === toId) {
      return { workflows: 0, credentials: 0, folders: 0, dataTables: 0 };
    }
    return this.db.transaction(async (tx) => {
      const at = now();
      const movedWorkflows = await tx
        .update(workflows)
        .set({ projectId: toId, updatedAt: at })
        .where(and(eq(workflows.tenantId, tenantId), eq(workflows.projectId, fromId)))
        .returning({ id: workflows.id });
      const movedCredentials = await tx
        .update(credentials)
        .set({ projectId: toId, updatedAt: at })
        .where(and(eq(credentials.tenantId, tenantId), eq(credentials.projectId, fromId)))
        .returning({ id: credentials.id });
      const movedFolders = await tx
        .update(folders)
        .set({ projectId: toId, updatedAt: at })
        .where(and(eq(folders.tenantId, tenantId), eq(folders.projectId, fromId)))
        .returning({ id: folders.id });
      const movedTables = await tx
        .update(dataTables)
        .set({ projectId: toId, updatedAt: at })
        .where(and(eq(dataTables.tenantId, tenantId), eq(dataTables.projectId, fromId)))
        .returning({ id: dataTables.id });
      const workflowIds = movedWorkflows.map((row) => row.id);
      if (workflowIds.length) {
        await tx
          .delete(workflowShares)
          .where(
            and(
              eq(workflowShares.tenantId, tenantId),
              eq(workflowShares.projectId, toId),
              inArray(workflowShares.workflowId, workflowIds),
            ),
          );
      }
      const credentialIds = movedCredentials.map((row) => row.id);
      if (credentialIds.length) {
        await tx
          .delete(credentialShares)
          .where(
            and(
              eq(credentialShares.tenantId, tenantId),
              eq(credentialShares.projectId, toId),
              inArray(credentialShares.credentialId, credentialIds),
            ),
          );
      }
      return {
        workflows: workflowIds.length,
        credentials: credentialIds.length,
        folders: movedFolders.length,
        dataTables: movedTables.length,
      };
    });
  }
}
