/**
 * P6-86 (L18): the reads behind the dependency counts: workflows whose nodes or settings name a resource
 * (credential ids, data table ids, `settings.errorWorkflow`, sub-workflow calls). Every query filters
 * tenant_id with bound values; the caller's access filter is applied in the service.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { credentials, dataTables, folders, workflows } from '../db/schema';
import { isUuid } from './util';

/** one workflow that names the resource, and how */
export interface DependencyRow {
  /** the workflow that holds the reference */
  workflowId: string;
  workflowName: string;
  projectId: string | null;
  active: boolean;
  /** the resource it names */
  resourceId: string;
  key: 'credentialId' | 'dataTableId' | 'errorWorkflow' | 'workflowCall';
}

/** the name and owner of a resource, no data */
export interface ResourceName {
  id: string;
  name: string;
  projectId: string | null;
  isGlobal?: boolean;
  active?: boolean;
}

/** the nodes that run a database sub-workflow: the Execute Workflow node and the two agent nodes that wrap one */
const SUB_WORKFLOW_NODE_TYPES = ['core.executeWorkflow', 'ai.toolWorkflow', 'ai.retrieverWorkflow'];
const DATA_TABLE_NODE_TYPES = ['core.dataTable', 'core.dataTableTool'];

const typeList = (types: string[]) =>
  sql.join(
    types.map((type) => sql`${type}`),
    sql`, `,
  );
const idList = (ids: string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
const uuidsOf = (ids: string[]) => [...new Set(ids.filter(isUuid))];

interface RawRow {
  workflow_id: string;
  workflow_name: string;
  project_id: string | null;
  active: boolean;
  resource_id: string;
  key: DependencyRow['key'];
}

const toRow = (row: RawRow): DependencyRow => ({
  workflowId: row.workflow_id,
  workflowName: row.workflow_name,
  projectId: row.project_id,
  active: row.active,
  resourceId: row.resource_id,
  key: row.key,
});

/** the id a sub-workflow node names: a resource locator's value, or a plain id */
const SUB_WORKFLOW_REF = sql`coalesce(n #>> '{parameters,workflowId,value}', n #>> '{parameters,workflowId}')`;
const IS_DATABASE_SOURCE = sql`coalesce(n #>> '{parameters,source}', 'database') <> 'parameter'`;

export class DependencyRepository {
  constructor(protected readonly db: DbOrTx) {}

  /** workflows whose nodes name one of the credentials */
  async workflowsUsingCredentials(tenantId: string, credentialIds: string[]): Promise<DependencyRow[]> {
    const ids = uuidsOf(credentialIds);
    if (!isUuid(tenantId) || !ids.length) return [];
    const result = await this.db.execute(sql`
      SELECT DISTINCT w.id AS workflow_id, w.name AS workflow_name, w.project_id, w.active,
        c.value ->> 'id' AS resource_id, 'credentialId' AS key
      FROM workflows w
      CROSS JOIN LATERAL jsonb_array_elements(w.nodes) n
      CROSS JOIN LATERAL jsonb_each(
        CASE WHEN jsonb_typeof(n -> 'credentials') = 'object' THEN n -> 'credentials' ELSE '{}'::jsonb END
      ) c
      WHERE w.tenant_id = ${tenantId}::uuid
        AND jsonb_typeof(c.value) = 'object'
        AND c.value ->> 'id' IN (${idList(ids)})
      ORDER BY w.name, w.id`);
    return (result.rows as unknown as RawRow[]).map(toRow);
  }

  /** workflows whose nodes name one of the data tables (by id, or by name inside the table's project) */
  async workflowsUsingDataTables(tenantId: string, dataTableIds: string[]): Promise<DependencyRow[]> {
    const ids = uuidsOf(dataTableIds);
    if (!isUuid(tenantId) || !ids.length) return [];
    const result = await this.db.execute(sql`
      SELECT DISTINCT w.id AS workflow_id, w.name AS workflow_name, w.project_id, w.active,
        t.id AS resource_id, 'dataTableId' AS key
      FROM data_tables t
      JOIN workflows w ON w.tenant_id = t.tenant_id AND w.project_id = t.project_id
      CROSS JOIN LATERAL jsonb_array_elements(w.nodes) n
      WHERE t.tenant_id = ${tenantId}::uuid
        AND t.id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
        AND n ->> 'type' IN (${typeList(DATA_TABLE_NODE_TYPES)})
        AND CASE
          WHEN n #>> '{parameters,dataTableId,mode}' = 'name'
            THEN n #>> '{parameters,dataTableId,value}' = t.name::text
          ELSE coalesce(n #>> '{parameters,dataTableId,value}', n #>> '{parameters,dataTableId}') = t.id::text
        END
      ORDER BY w.name, w.id`);
    return (result.rows as unknown as RawRow[]).map(toRow);
  }

  /** workflows that call one of the workflows, or name one as their error workflow */
  async workflowsReferencing(tenantId: string, workflowIds: string[]): Promise<DependencyRow[]> {
    const ids = uuidsOf(workflowIds);
    if (!isUuid(tenantId) || !ids.length) return [];
    const result = await this.db.execute(sql`
      SELECT DISTINCT w.id AS workflow_id, w.name AS workflow_name, w.project_id, w.active,
        ${SUB_WORKFLOW_REF} AS resource_id, 'workflowCall' AS key
      FROM workflows w
      CROSS JOIN LATERAL jsonb_array_elements(w.nodes) n
      WHERE w.tenant_id = ${tenantId}::uuid
        AND n ->> 'type' IN (${typeList(SUB_WORKFLOW_NODE_TYPES)})
        AND ${IS_DATABASE_SOURCE}
        AND ${SUB_WORKFLOW_REF} IN (${idList(ids)})
      UNION
      SELECT w.id, w.name, w.project_id, w.active, w.settings ->> 'errorWorkflow', 'errorWorkflow'
      FROM workflows w
      WHERE w.tenant_id = ${tenantId}::uuid
        AND w.settings ->> 'errorWorkflow' IN (${idList(ids)})
      ORDER BY 2, 1`);
    return (result.rows as unknown as RawRow[]).map(toRow);
  }

  /** what the workflows themselves name (their credentials, tables, sub-workflows, error workflow) */
  async referencesOf(tenantId: string, workflowIds: string[]): Promise<DependencyRow[]> {
    const ids = uuidsOf(workflowIds);
    if (!isUuid(tenantId) || !ids.length) return [];
    const rows = await this.db
      .select({
        id: workflows.id,
        name: workflows.name,
        projectId: workflows.projectId,
        active: workflows.active,
        nodes: workflows.nodes,
        settings: workflows.settings,
      })
      .from(workflows)
      .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids)));

    // a table named by name resolves inside the workflow's own project
    const tableNames = new Set<string>();
    const tablesByProject = new Map<string, Map<string, string>>();
    for (const row of rows) {
      for (const node of asNodes(row.nodes)) {
        const name = dataTableNameOf(node);
        if (name) tableNames.add(name);
      }
    }
    if (tableNames.size) {
      const found = await this.db
        .select({ id: dataTables.id, name: dataTables.name, projectId: dataTables.projectId })
        .from(dataTables)
        .where(and(eq(dataTables.tenantId, tenantId), inArray(dataTables.name, [...tableNames])));
      for (const table of found) {
        const byName = tablesByProject.get(table.projectId) ?? new Map<string, string>();
        byName.set(table.name, table.id);
        tablesByProject.set(table.projectId, byName);
      }
    }

    const out: DependencyRow[] = [];
    for (const row of rows) {
      const seen = new Set<string>();
      const add = (key: DependencyRow['key'], resourceId: string | undefined) => {
        if (!resourceId || !isUuid(resourceId) || seen.has(`${key}:${resourceId}`)) return;
        seen.add(`${key}:${resourceId}`);
        out.push({
          workflowId: row.id,
          workflowName: row.name,
          projectId: row.projectId,
          active: row.active,
          resourceId,
          key,
        });
      };
      for (const node of asNodes(row.nodes)) {
        const slots = node.credentials;
        if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
          for (const ref of Object.values(slots as Record<string, unknown>)) {
            const id = (ref as { id?: unknown } | null)?.id;
            if (typeof id === 'string') add('credentialId', id);
          }
        }
        const type = typeof node.type === 'string' ? node.type : '';
        const parameters = (node.parameters ?? {}) as Record<string, unknown>;
        if (SUB_WORKFLOW_NODE_TYPES.includes(type) && (parameters.source ?? 'database') !== 'parameter') {
          add('workflowCall', locatorValue(parameters.workflowId));
        }
        if (DATA_TABLE_NODE_TYPES.includes(type)) {
          const named = dataTableNameOf(node);
          add(
            'dataTableId',
            named ? tablesByProject.get(row.projectId)?.get(named) : locatorValue(parameters.dataTableId),
          );
        }
      }
      const errorWorkflow = (row.settings as { errorWorkflow?: unknown } | null)?.errorWorkflow;
      if (typeof errorWorkflow === 'string') add('errorWorkflow', errorWorkflow);
    }
    return out;
  }

  /** the name, project and flags of the resources of `kind` that exist in the tenant (no data) */
  async namesOf(
    tenantId: string,
    kind: 'workflow' | 'credential' | 'dataTable',
    resourceIds: string[],
  ): Promise<ResourceName[]> {
    const ids = uuidsOf(resourceIds);
    if (!isUuid(tenantId) || !ids.length) return [];
    if (kind === 'workflow') {
      return this.db
        .select({
          id: workflows.id,
          name: workflows.name,
          projectId: workflows.projectId,
          active: workflows.active,
        })
        .from(workflows)
        .where(and(eq(workflows.tenantId, tenantId), inArray(workflows.id, ids)));
    }
    if (kind === 'credential') {
      return this.db
        .select({
          id: credentials.id,
          name: credentials.name,
          projectId: credentials.projectId,
          isGlobal: credentials.isGlobal,
        })
        .from(credentials)
        .where(and(eq(credentials.tenantId, tenantId), inArray(credentials.id, ids)));
    }
    return this.db
      .select({ id: dataTables.id, name: dataTables.name, projectId: dataTables.projectId })
      .from(dataTables)
      .where(and(eq(dataTables.tenantId, tenantId), inArray(dataTables.id, ids)));
  }

  /** the workflows of a folder and of every folder below it, in one project */
  async workflowsInFolderTree(
    tenantId: string,
    projectId: string,
    folderId: string,
  ): Promise<Array<{ id: string; name: string; projectId: string }>> {
    if (!isUuid(tenantId) || !isUuid(projectId) || !isUuid(folderId)) return [];
    const [root] = await this.db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.tenantId, tenantId), eq(folders.projectId, projectId), eq(folders.id, folderId)));
    if (!root) return [];
    const result = await this.db.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders
        WHERE tenant_id = ${tenantId}::uuid AND project_id = ${projectId}::uuid AND id = ${folderId}::uuid
        UNION
        SELECT f.id FROM folders f JOIN tree t ON f.parent_folder_id = t.id
        WHERE f.tenant_id = ${tenantId}::uuid
      )
      SELECT w.id, w.name, w.project_id AS "projectId"
      FROM workflows w
      WHERE w.tenant_id = ${tenantId}::uuid AND w.folder_id IN (SELECT id FROM tree)
      ORDER BY w.name, w.id`);
    return result.rows as unknown as Array<{ id: string; name: string; projectId: string }>;
  }
}

function asNodes(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((node): node is Record<string, unknown> => !!node && typeof node === 'object')
    : [];
}

/** a resource locator's value, or a plain string */
function locatorValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  const value = (raw as { value?: unknown } | null | undefined)?.value;
  return typeof value === 'string' ? value : undefined;
}

/** the table name a Data Table node names in name mode */
function dataTableNameOf(node: Record<string, unknown>): string | undefined {
  const type = typeof node.type === 'string' ? node.type : '';
  if (!DATA_TABLE_NODE_TYPES.includes(type)) return undefined;
  const raw = (node.parameters as Record<string, unknown> | undefined)?.dataTableId as
    | { mode?: unknown; value?: unknown }
    | undefined;
  return raw && typeof raw === 'object' && raw.mode === 'name' && typeof raw.value === 'string'
    ? raw.value
    : undefined;
}
