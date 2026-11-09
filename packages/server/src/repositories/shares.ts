/**
 * Shares (P6-29): a workflow or credential shared with another project. The owning project is the row's
 * `project_id`; a share row gives the sharee project the share's resource role (`workflow:editor`,
 * `credential:user`). Every query filters tenant_id.
 *
 * The list filter helpers at the end are the one filter shape every list repository uses
 * (`filter?: AccessFilter`, `projectId?: string`, `onlySharedWithMe?: boolean`).
 */
import { type AnyColumn, and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  type CredentialShareRow,
  credentialShares,
  credentials,
  type ProjectIcon,
  projects,
  type WorkflowShareRow,
  workflowShares,
} from '../db/schema';
import type { AccessFilter } from '../services/access';
import { isUuid } from './util';

export type ShareKind = 'workflow' | 'credential';

/** the default resource role a new share gives (n8n's) */
export const DEFAULT_SHARE_ROLE: Readonly<Record<ShareKind, string>> = {
  workflow: 'workflow:editor',
  credential: 'credential:user',
};

/** the sharee project as lists show it */
export interface ShareProjectRef {
  id: string;
  name: string;
  type: 'personal' | 'team';
  icon: ProjectIcon | null;
}

export type WorkflowShareRecord = WorkflowShareRow & { project: ShareProjectRef };
export type CredentialShareRecord = CredentialShareRow & { project: ShareProjectRef };

export interface ShareSetResult {
  /** project ids that gained a share */
  added: string[];
  /** project ids that lost their share */
  removed: string[];
}

const projectRef = {
  id: projects.id,
  name: projects.name,
  type: projects.type,
  icon: projects.icon,
};

function uuids(values: readonly string[]): string[] {
  return [...new Set(values.filter(isUuid))];
}

/** `expr in (ids)` with each id bound as a uuid; the caller makes sure `ids` is not empty */
export function inUuids(expr: SQL | AnyColumn, ids: readonly string[]): SQL {
  return sql`${expr} in (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export class ShareRepository {
  constructor(private readonly db: DbOrTx) {}

  /** the projects a workflow is shared with (not its owner), oldest share first */
  async listForWorkflow(tenantId: string, workflowId: string): Promise<WorkflowShareRecord[]> {
    if (!isUuid(workflowId)) return [];
    const rows = await this.db
      .select({ share: workflowShares, project: projectRef })
      .from(workflowShares)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, workflowShares.tenantId), eq(projects.id, workflowShares.projectId)),
      )
      .where(and(eq(workflowShares.tenantId, tenantId), eq(workflowShares.workflowId, workflowId)))
      .orderBy(asc(workflowShares.createdAt), asc(workflowShares.projectId));
    return rows.map((row) => ({ ...row.share, project: row.project }));
  }

  /** the projects a credential is shared with (not its owner), oldest share first */
  async listForCredential(tenantId: string, credentialId: string): Promise<CredentialShareRecord[]> {
    if (!isUuid(credentialId)) return [];
    const rows = await this.db
      .select({ share: credentialShares, project: projectRef })
      .from(credentialShares)
      .innerJoin(
        projects,
        and(eq(projects.tenantId, credentialShares.tenantId), eq(projects.id, credentialShares.projectId)),
      )
      .where(and(eq(credentialShares.tenantId, tenantId), eq(credentialShares.credentialId, credentialId)))
      .orderBy(asc(credentialShares.createdAt), asc(credentialShares.projectId));
    return rows.map((row) => ({ ...row.share, project: row.project }));
  }

  /**
   * Makes `projectIds` the full share list of the resource: missing shares are added with `role` (the
   * kind's default), shares of other projects are removed, kept shares keep their role. The caller has
   * checked the projects (same tenant, not the owner) and the `:share` / `:unshare` scopes.
   */
  async set(
    tenantId: string,
    kind: ShareKind,
    resourceId: string,
    projectIds: string[],
    role: string = DEFAULT_SHARE_ROLE[kind],
  ): Promise<ShareSetResult> {
    if (!isUuid(resourceId)) return { added: [], removed: [] };
    const wanted = uuids(projectIds);
    const current =
      kind === 'workflow'
        ? (await this.listForWorkflow(tenantId, resourceId)).map((s) => s.projectId)
        : (await this.listForCredential(tenantId, resourceId)).map((s) => s.projectId);
    const removed = current.filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !current.includes(id));
    if (kind === 'workflow') {
      if (removed.length) {
        await this.db
          .delete(workflowShares)
          .where(
            and(
              eq(workflowShares.tenantId, tenantId),
              eq(workflowShares.workflowId, resourceId),
              inArray(workflowShares.projectId, removed),
            ),
          );
      }
      if (added.length) {
        await this.db
          .insert(workflowShares)
          .values(added.map((projectId) => ({ tenantId, workflowId: resourceId, projectId, role })))
          .onConflictDoNothing();
      }
    } else {
      if (removed.length) {
        await this.db
          .delete(credentialShares)
          .where(
            and(
              eq(credentialShares.tenantId, tenantId),
              eq(credentialShares.credentialId, resourceId),
              inArray(credentialShares.projectId, removed),
            ),
          );
      }
      if (added.length) {
        await this.db
          .insert(credentialShares)
          .values(added.map((projectId) => ({ tenantId, credentialId: resourceId, projectId, role })))
          .onConflictDoNothing();
      }
    }
    return { added, removed };
  }

  /** drops every share of the resource (a move does this); returns how many went */
  async clear(tenantId: string, kind: ShareKind, resourceId: string): Promise<number> {
    if (!isUuid(resourceId)) return 0;
    if (kind === 'workflow') {
      const rows = await this.db
        .delete(workflowShares)
        .where(and(eq(workflowShares.tenantId, tenantId), eq(workflowShares.workflowId, resourceId)))
        .returning({ projectId: workflowShares.projectId });
      return rows.length;
    }
    const rows = await this.db
      .delete(credentialShares)
      .where(and(eq(credentialShares.tenantId, tenantId), eq(credentialShares.credentialId, resourceId)))
      .returning({ projectId: credentialShares.projectId });
    return rows.length;
  }

  /** the sharee projects of a workflow (not its owner) */
  async projectsSharingWorkflow(tenantId: string, workflowId: string): Promise<string[]> {
    if (!isUuid(workflowId)) return [];
    const rows = await this.db
      .select({ projectId: workflowShares.projectId })
      .from(workflowShares)
      .where(and(eq(workflowShares.tenantId, tenantId), eq(workflowShares.workflowId, workflowId)));
    return rows.map((row) => row.projectId);
  }

  /** ids of the credentials shared with any of `projectIds` (owned ones are not included) */
  async credentialIdsSharedTo(tenantId: string, projectIds: string[]): Promise<string[]> {
    const ids = uuids(projectIds);
    if (!ids.length) return [];
    const rows = await this.db
      .selectDistinct({ id: credentialShares.credentialId })
      .from(credentialShares)
      .where(and(eq(credentialShares.tenantId, tenantId), inArray(credentialShares.projectId, ids)));
    return rows.map((row) => row.id);
  }

  /** ids of the workflows shared with any of `projectIds` (owned ones are not included) */
  async workflowIdsSharedTo(tenantId: string, projectIds: string[]): Promise<string[]> {
    const ids = uuids(projectIds);
    if (!ids.length) return [];
    const rows = await this.db
      .selectDistinct({ id: workflowShares.workflowId })
      .from(workflowShares)
      .where(and(eq(workflowShares.tenantId, tenantId), inArray(workflowShares.projectId, ids)));
    return rows.map((row) => row.id);
  }

  /** the share rows of a workflow (project id and resource role) */
  async workflowSharesFor(
    tenantId: string,
    workflowId: string,
  ): Promise<Array<{ projectId: string; role: string }>> {
    if (!isUuid(workflowId)) return [];
    return this.db
      .select({ projectId: workflowShares.projectId, role: workflowShares.role })
      .from(workflowShares)
      .where(and(eq(workflowShares.tenantId, tenantId), eq(workflowShares.workflowId, workflowId)));
  }

  /** the share rows of a credential (project id and resource role) */
  async credentialSharesFor(
    tenantId: string,
    credentialId: string,
  ): Promise<Array<{ projectId: string; role: string }>> {
    if (!isUuid(credentialId)) return [];
    return this.db
      .select({ projectId: credentialShares.projectId, role: credentialShares.role })
      .from(credentialShares)
      .where(and(eq(credentialShares.tenantId, tenantId), eq(credentialShares.credentialId, credentialId)));
  }

  /**
   * Every share into any of `projectIds`, of one kind: the shared row's id, the sharee project and the
   * share's resource role (the access service masks the project role with it).
   */
  async sharesInto(
    tenantId: string,
    kind: ShareKind,
    projectIds: string[],
  ): Promise<Array<{ resourceId: string; projectId: string; role: string }>> {
    const ids = uuids(projectIds);
    if (!ids.length) return [];
    if (kind === 'workflow') {
      return this.db
        .select({
          resourceId: workflowShares.workflowId,
          projectId: workflowShares.projectId,
          role: workflowShares.role,
        })
        .from(workflowShares)
        .where(and(eq(workflowShares.tenantId, tenantId), inArray(workflowShares.projectId, ids)));
    }
    return this.db
      .select({
        resourceId: credentialShares.credentialId,
        projectId: credentialShares.projectId,
        role: credentialShares.role,
      })
      .from(credentialShares)
      .where(and(eq(credentialShares.tenantId, tenantId), inArray(credentialShares.projectId, ids)));
  }

  /** ids of the global credentials (usable by every project of the workspace) */
  async globalCredentialIds(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.tenantId, tenantId), eq(credentials.isGlobal, true)));
    return rows.map((row) => row.id);
  }
}

/** the filter arguments every list repository takes (plan-S1 section 3, C0c1 item 2) */
export interface AccessListOptions {
  /** from `AccessService.listFilter`; absent = no access narrowing (system callers) */
  filter?: AccessFilter;
  /** only rows of this project: owned by it or, for shareable rows, shared with it */
  projectId?: string;
  /**
   * only rows shared with `projectId` (the service passes the caller's personal project), never rows it
   * owns; without `projectId`, or for rows that cannot be shared, nothing matches
   */
  onlySharedWithMe?: boolean;
}

/**
 * Conditions that narrow a workflow or credential query (`id`, `project` are the row's id and owning
 * project expressions; an execution passes its workflow id and that workflow's project). Returns null
 * when nothing can match, so the caller answers an empty list without a query.
 */
export function sharedRowConditions(input: {
  tenantId: string;
  kind: ShareKind;
  id: SQL | AnyColumn;
  project: SQL | AnyColumn;
  options: AccessListOptions;
}): SQL[] | null {
  const { tenantId, kind, id, project, options } = input;
  const shares =
    kind === 'workflow'
      ? { table: workflowShares, resource: workflowShares.workflowId, projectCol: workflowShares.projectId }
      : {
          table: credentialShares,
          resource: credentialShares.credentialId,
          projectCol: credentialShares.projectId,
        };
  const sharedInto = (projectIds: string[]) =>
    sql`${id} in (select ${shares.resource} from ${shares.table} where ${shares.table.tenantId} = ${tenantId}::uuid and ${inUuids(shares.projectCol, projectIds)})`;
  const conditions: SQL[] = [];
  const { filter } = options;
  if (filter && !filter.all) {
    const projectIds = uuids(filter.projectIds);
    const rowIds = uuids(kind === 'workflow' ? filter.workflowIds : filter.credentialIds);
    const alternatives: SQL[] = [];
    if (projectIds.length) alternatives.push(inUuids(project, projectIds));
    if (rowIds.length) alternatives.push(inUuids(id, rowIds));
    if (!alternatives.length) return null;
    conditions.push(
      alternatives.length === 1 ? alternatives[0] : sql`(${sql.join(alternatives, sql` or `)})`,
    );
  }
  if (options.onlySharedWithMe) {
    if (options.projectId === undefined || !isUuid(options.projectId)) return null;
    conditions.push(sharedInto([options.projectId]));
  } else if (options.projectId !== undefined) {
    if (!isUuid(options.projectId)) return null;
    conditions.push(sql`(${project} = ${options.projectId}::uuid or ${sharedInto([options.projectId])})`);
  }
  return conditions;
}

/**
 * Conditions that narrow a query of rows that belong to one project and cannot be shared (folders, data
 * tables). Returns null when nothing can match.
 */
export function projectRowConditions(project: SQL | AnyColumn, options: AccessListOptions): SQL[] | null {
  const conditions: SQL[] = [];
  const { filter } = options;
  if (filter && !filter.all) {
    const projectIds = uuids(filter.projectIds);
    if (!projectIds.length) return null;
    conditions.push(inUuids(project, projectIds));
  }
  if (options.onlySharedWithMe) return null;
  if (options.projectId !== undefined) {
    if (!isUuid(options.projectId)) return null;
    conditions.push(sql`${project} = ${options.projectId}::uuid`);
  }
  return conditions;
}
