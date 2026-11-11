/**
 * P6-74 (L3): the export side. `exportFiles` writes the tenant's resources in `scope` ('all' or a set of project
 * ids, from `pushableProjects`) as n8n's work folder files, by path, ids rewritten to git ids through the map.
 * `sanitizeCredentialData` keeps no secret: strings emptied unless an expression, `oauthTokenData` and nulls dropped,
 * numbers and booleans kept. `readLocalFiles` is the one reader of the workspace side (files in local ids); status
 * hashes its answer, export rewrites it. Every query filters tenant_id with a bound value; no pin data, static data,
 * table rows or run data is read.
 */
import { createHash } from 'node:crypto';
import {
  type DataObject,
  pathFor,
  SOURCE_CONTROL_LIMITS,
  type SourceControlledFileType,
} from '@workflow/workflow';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ServiceDeps } from '../../context';
import {
  type CredentialRow,
  credentials,
  dataTableColumns,
  dataTables,
  type FolderRow,
  folders,
  type ProjectRow,
  projects,
  type TagRow,
  tags,
  type VariableRow,
  variables,
  type WorkflowRow,
  workflows,
  workflowTags,
  workflowVersions,
} from '../../db/schema';
import { ApiError } from '../../http/errors';
import type { SyncIdMap } from './id-map';
import type {
  CredentialStubFile,
  DataTableFile,
  FileOwner,
  FoldersFile,
  ProjectFile,
  TagsFile,
  VariableStub,
  WorkflowFile,
} from './import-schemas';

/** a file of the work folder that no schema accepts: too big, not JSON, not a managed path or the wrong shape */
export class SourceControlFormatError extends ApiError {
  constructor(message: string) {
    super(400, 'source_control_format', message);
    this.name = 'SourceControlFormatError';
  }
}

/** 'all', or the project ids a caller may sync */
export type SyncScope = 'all' | Set<string>;

/** a string that holds an expression (n8n marks one with a leading `=`) */
const isExpression = (value: string) => value.startsWith('=');

/**
 * A credential's data as a stub keeps it: a string is emptied unless it is an expression, `oauthTokenData` and
 * nulls are dropped, numbers and booleans are kept. Nested objects and lists are cleaned the same way.
 */
export function sanitizeCredentialData(data: DataObject): DataObject {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return isExpression(value) ? value : '';
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.filter((item) => item !== null && item !== undefined).map(clean);
    if (value !== null && typeof value === 'object') return sanitizeCredentialData(value as DataObject);
    return undefined;
  };
  const out: DataObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'oauthTokenData' || value === null || value === undefined) continue;
    const cleaned = clean(value);
    if (cleaned === undefined) continue;
    // defineProperty, so a key named `__proto__` from parsed JSON stays a key
    Object.defineProperty(out, key, { value: cleaned, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** JSON with every object's keys sorted: the same content always gives the same text */
export function stableStringify(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = sort((input as Record<string, unknown>)[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const byKey =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    key(a).localeCompare(key(b));

/**
 * The version of a file that is not a workflow: a hash of what a sync carries (no timestamps, no id of the file's
 * own resource). Local and remote content hash the same when they hold the same data in the same id space.
 */
export function contentVersion(type: Exclude<SourceControlledFileType, 'workflow'>, data: unknown): string {
  switch (type) {
    case 'credential': {
      const d = data as CredentialStubFile;
      return sha(
        stableStringify({
          name: d.name,
          type: d.type,
          isGlobal: d.isGlobal,
          isResolvable: d.isResolvable,
          data: d.data,
        }),
      );
    }
    case 'datatable': {
      const d = data as DataTableFile;
      return sha(
        stableStringify({
          name: d.name,
          columns: [...d.columns]
            .sort((a, b) => a.index - b.index)
            .map((c) => ({ name: c.name, type: c.type })),
        }),
      );
    }
    case 'project': {
      const d = data as ProjectFile;
      return sha(
        stableStringify({
          name: d.name,
          icon: d.icon,
          description: d.description,
          variables: [...(d.variableStubs ?? [])]
            .sort(byKey((v) => v.key))
            .map((v) => ({ key: v.key, type: v.type })),
        }),
      );
    }
    case 'folders': {
      const d = data as FoldersFile;
      return sha(
        stableStringify(
          [...d.folders].sort(byKey((f) => f.id)).map((f) => ({
            id: f.id,
            name: f.name,
            parentFolderId: f.parentFolderId,
            homeProjectId: f.homeProjectId,
          })),
        ),
      );
    }
    case 'tags': {
      const d = data as TagsFile;
      return sha(
        stableStringify({
          tags: [...d.tags].sort(byKey((t) => t.name)).map((t) => ({ id: t.id, name: t.name })),
          mappings: [...d.mappings].sort(byKey((m) => `${m.workflowId}:${m.tagId}`)),
        }),
      );
    }
    case 'variables': {
      const d = data as VariableStub[];
      return sha(
        stableStringify(
          [...d].sort(byKey((v) => `${v.projectId ?? ''}:${v.key}`)).map((v) => ({
            id: v.id,
            key: v.key,
            type: v.type,
            projectId: v.projectId ?? null,
          })),
        ),
      );
    }
  }
}

/** one file of the workspace side, in local ids */
export type LocalFile =
  | {
      type: 'workflow';
      id: string;
      projectId: string;
      updatedAt: string;
      row: WorkflowRow;
      data: WorkflowFile;
    }
  | { type: 'credential'; id: string; projectId: string; updatedAt: string; data: CredentialStubFile }
  | { type: 'datatable'; id: string; projectId: string; updatedAt: string; data: DataTableFile }
  | { type: 'project'; id: string; projectId: string; updatedAt: string; data: ProjectFile }
  | { type: 'variables'; updatedAt: string; data: VariableStub[] }
  | { type: 'tags'; updatedAt: string; data: TagsFile }
  | { type: 'folders'; updatedAt: string; data: FoldersFile };

/** everything the workspace side of a sync reads, in `scope` */
export interface LocalFiles {
  files: LocalFile[];
  /** every project of the tenant by id (status names owners from it) */
  projects: Map<string, ProjectRow>;
  /** every folder of the tenant */
  folders: FolderRow[];
  /** the email of each member by user id */
  emails: Map<string, string>;
}

const inScope = (scope: SyncScope, projectId: string | null) =>
  scope === 'all' ? true : projectId !== null && scope.has(projectId);

/** n8n counts the enabled nodes that start a run: triggers, pollers and webhooks */
function triggerCountOf(deps: ServiceDeps, nodes: unknown[]): number {
  const types = deps.context().registries.nodeTypes;
  let count = 0;
  for (const node of nodes as Array<{ type?: string; disabled?: boolean }>) {
    if (node.disabled || typeof node.type !== 'string') continue;
    const type = types.get(node.type);
    if (!type) continue;
    if (type.trigger || type.poll || type.webhook || type.description.group.includes('trigger')) count++;
  }
  return count;
}

/**
 * The workspace's files in `scope`, ids local. The single files (`variables`, `tags`, `folders`) come only for 'all':
 * a file that holds a part of the workspace never overwrites the whole remote file.
 */
export async function readLocalFiles(
  deps: ServiceDeps,
  tenantId: string,
  scope: SyncScope,
): Promise<LocalFiles> {
  const { db } = deps.database;
  const projectRows = await db.select().from(projects).where(eq(projects.tenantId, tenantId));
  const projectMap = new Map(projectRows.map((p) => [p.id, p]));
  const members = await deps.repos.memberships.listForTenant(tenantId);
  const emails = new Map(members.map((m) => [m.userId, m.email]));

  const ownerOf = (projectId: string): FileOwner | null => {
    const project = projectMap.get(projectId);
    if (!project) return null;
    if (project.type === 'team') return { type: 'team', teamId: project.id, teamName: project.name };
    const email = project.ownerUserId ? emails.get(project.ownerUserId) : undefined;
    return email ? { type: 'personal', personalEmail: email } : null;
  };

  const files: LocalFile[] = [];
  const variableRows: VariableRow[] = await db
    .select()
    .from(variables)
    .where(eq(variables.tenantId, tenantId))
    .orderBy(asc(variables.key));
  const stubOf = (v: VariableRow): VariableStub => ({
    id: v.id,
    key: v.key,
    type: 'string',
    value: '',
    projectId: v.projectId,
  });

  // team projects, with their variables
  for (const project of [...projectRows].sort(byKey((p) => p.id))) {
    if (project.type !== 'team' || !inScope(scope, project.id)) continue;
    files.push({
      type: 'project',
      id: project.id,
      projectId: project.id,
      updatedAt: project.updatedAt.toISOString(),
      data: {
        id: project.id,
        name: project.name,
        type: 'team',
        icon: project.icon ?? null,
        description: project.description ?? null,
        owner: { type: 'team', teamId: project.id, teamName: project.name },
        variableStubs: variableRows.filter((v) => v.projectId === project.id).map(stubOf),
      },
    });
  }

  // workflows, with the description of their current version
  const workflowRows: WorkflowRow[] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.tenantId, tenantId))
    .orderBy(asc(workflows.id));
  const versionIds = workflowRows.map((w) => w.versionId);
  const descriptions = new Map<string, string | null>();
  for (let start = 0; start < versionIds.length; start += 500) {
    const rows = await db
      .select({ id: workflowVersions.id, description: workflowVersions.description })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.tenantId, tenantId),
          inArray(workflowVersions.id, versionIds.slice(start, start + 500)),
        ),
      );
    for (const row of rows) descriptions.set(row.id, row.description);
  }
  for (const row of workflowRows) {
    if (!inScope(scope, row.projectId)) continue;
    files.push({
      type: 'workflow',
      id: row.id,
      projectId: row.projectId,
      updatedAt: row.updatedAt.toISOString(),
      row,
      data: {
        id: row.id,
        name: row.name,
        description: descriptions.get(row.versionId) ?? null,
        nodes: row.nodes as WorkflowFile['nodes'],
        connections: row.connections as WorkflowFile['connections'],
        settings: row.settings as WorkflowFile['settings'],
        triggerCount: triggerCountOf(deps, row.nodes),
        versionId: row.versionId,
        owner: ownerOf(row.projectId),
        parentFolderId: row.folderId,
        isArchived: row.isArchived,
        nodeGroups: row.nodeGroups as WorkflowFile['nodeGroups'],
        stickyNotes: row.stickyNotes as WorkflowFile['stickyNotes'],
      },
    });
  }

  // credential stubs: the data goes through sanitizeCredentialData, nothing else of the secret leaves this function
  const credentialRows: CredentialRow[] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.tenantId, tenantId))
    .orderBy(asc(credentials.id));
  const cipherOwner = deps.context().credentials;
  for (const row of credentialRows) {
    if (!inScope(scope, row.projectId)) continue;
    files.push({
      type: 'credential',
      id: row.id,
      projectId: row.projectId,
      updatedAt: row.updatedAt.toISOString(),
      data: {
        id: row.id,
        name: row.name,
        type: row.type,
        isGlobal: row.isGlobal,
        isResolvable: row.isResolvable,
        owner: ownerOf(row.projectId),
        data: sanitizeCredentialData(cipherOwner.decrypt(row)),
      },
    });
  }

  // data table schemas, no rows
  const tableRows = await db
    .select()
    .from(dataTables)
    .where(eq(dataTables.tenantId, tenantId))
    .orderBy(asc(dataTables.id));
  const columnRows = await db
    .select()
    .from(dataTableColumns)
    .where(eq(dataTableColumns.tenantId, tenantId))
    .orderBy(asc(dataTableColumns.position));
  for (const table of tableRows) {
    if (!inScope(scope, table.projectId)) continue;
    files.push({
      type: 'datatable',
      id: table.id,
      projectId: table.projectId,
      updatedAt: table.updatedAt.toISOString(),
      data: {
        id: table.id,
        name: table.name,
        projectId: table.projectId,
        columns: columnRows
          .filter((c) => c.tableId === table.id)
          .map((c) => ({ id: c.id, name: c.name, type: c.type, index: c.position })),
      },
    });
  }

  const folderRows: FolderRow[] = await db
    .select()
    .from(folders)
    .where(eq(folders.tenantId, tenantId))
    .orderBy(asc(folders.id));

  if (scope === 'all') {
    const latest = (dates: Date[]) => new Date(Math.max(0, ...dates.map((d) => d.getTime()))).toISOString();
    files.push({
      type: 'variables',
      updatedAt: latest(variableRows.map((v) => v.updatedAt)),
      data: variableRows.filter((v) => v.projectId === null).map(stubOf),
    });
    const tagRows: TagRow[] = await db
      .select()
      .from(tags)
      .where(eq(tags.tenantId, tenantId))
      .orderBy(asc(tags.name));
    const mappingRows = await db
      .select({ workflowId: workflowTags.workflowId, tagId: workflowTags.tagId })
      .from(workflowTags)
      .where(eq(workflowTags.tenantId, tenantId));
    files.push({
      type: 'tags',
      updatedAt: latest(tagRows.map((tag) => tag.updatedAt)),
      data: {
        tags: tagRows.map((t) => ({ id: t.id, name: t.name })),
        mappings: mappingRows
          .map((m) => ({ workflowId: m.workflowId, tagId: m.tagId }))
          .sort(byKey((m) => `${m.workflowId}:${m.tagId}`)),
      },
    });
    files.push({
      type: 'folders',
      updatedAt: latest(folderRows.map((f) => f.updatedAt)),
      data: {
        folders: folderRows.map((f) => ({
          id: f.id,
          name: f.name,
          parentFolderId: f.parentFolderId,
          homeProjectId: f.projectId,
          createdAt: f.createdAt.toISOString(),
          updatedAt: f.updatedAt.toISOString(),
        })),
      },
    });
  }
  return { files, projects: projectMap, folders: folderRows, emails };
}

/** the path of a local file once its ids are git ids */
export function pathOfLocal(file: LocalFile, map: SyncIdMap): string {
  switch (file.type) {
    case 'workflow':
      return pathFor('workflow', map.gitIdFor('workflow', file.id));
    case 'credential':
      return pathFor('credential', map.gitIdFor('credential', file.id));
    case 'datatable':
      return pathFor('datatable', map.gitIdFor('datatable', file.id));
    case 'project':
      return pathFor('project', map.gitIdFor('project', file.id));
    case 'variables':
      return pathFor('variables');
    case 'tags':
      return pathFor('tags');
    case 'folders':
      return pathFor('folders');
  }
}

/**
 * The work folder files of the tenant in `scope`, by path. Ids are git ids (the first pusher's local id, or the id
 * the map holds); every file is pretty JSON with 2 spaces and a final newline. No pin data, static data, table rows
 * or secret value is in any file.
 */
export async function exportFiles(
  deps: ServiceDeps,
  tenantId: string,
  scope: SyncScope,
  map: SyncIdMap,
): Promise<Map<string, Uint8Array>> {
  const local = await readLocalFiles(deps, tenantId, scope);
  const out = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  for (const file of local.files) {
    const path = pathOfLocal(file, map);
    const body = map.rewriteDefinition(file.data, 'toGit');
    const bytes = encoder.encode(`${JSON.stringify(body, null, 2)}\n`);
    if (bytes.byteLength > SOURCE_CONTROL_LIMITS.fileBytes) {
      throw new SourceControlFormatError(`The file ${path} is over the size limit`);
    }
    out.set(path, bytes);
  }
  return out;
}
