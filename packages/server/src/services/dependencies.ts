/**
 * P6-86 (L18): what uses what, computed from `workflows.nodes` and `settings` (no table). Keys
 * `credentialId`, `dataTableId`, `errorWorkflow`, `errorWorkflowParent`, `workflowCall`, `workflowParent`
 * (`agentUsage` left out). At most 100 ids a call. Rows the caller cannot read are dropped through
 * `listFilter`, in REST and public alike, and the counts follow. The public answers are n8n's
 * `DependencyListPublicDto` shape with paging.
 *
 * For a credential or a data table the details are the workflows that name it (`credentialId`,
 * `dataTableId`). For a workflow: `workflowParent` the workflows that call it, `errorWorkflowParent` the
 * workflows that name it as their error workflow, `workflowCall` the sub-workflows it calls, `errorWorkflow`
 * its own error workflow, `credentialId` and `dataTableId` what its nodes use.
 */
import type { ServerContext, ServiceDeps } from '../context';
import type { AuthContext } from '../http/auth';
import { ApiError } from '../http/errors';
import type { DependencyRow, ResourceName } from '../repositories/dependencies';
import { isUuid } from '../repositories/util';
import { type AccessFilter, MISSING_SCOPE_MESSAGE } from './access';

/** at most this many ids per counts or details call */
export const DEPENDENCY_BATCH_LIMIT = 100;

export type DependencyResourceKind = 'workflow' | 'credential' | 'dataTable';

export type DependencyKey =
  | 'credentialId'
  | 'dataTableId'
  | 'errorWorkflow'
  | 'errorWorkflowParent'
  | 'workflowCall'
  | 'workflowParent';

/** counts per key for one resource (a missing key is 0) */
export type DependencyCounts = Partial<Record<DependencyKey, number>>;

/** one related resource the caller may read */
export interface DependencyDetail {
  key: DependencyKey;
  id: string;
  name: string;
  resourceType: DependencyResourceKind;
  projectId: string | null;
  /** a related workflow is published */
  active?: boolean;
}

/** the folder's whole tree: workflows that other resources use, each with what uses it */
export interface FolderDependencies {
  workflows: Array<{ id: string; name: string; dependencies: DependencyDetail[] }>;
}

/** one public page */
export interface DependencyPage {
  data: DependencyDetail[];
  nextCursor: string | null;
}

export interface DependencyPageQuery {
  limit?: number;
  cursor?: string;
}

const KEY_ORDER: DependencyKey[] = [
  'workflowParent',
  'errorWorkflowParent',
  'workflowCall',
  'errorWorkflow',
  'credentialId',
  'dataTableId',
];

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const CURSOR_PREFIX = 'o';

/** the read scope that shows one resource kind */
const READ_SCOPE = {
  workflow: 'workflow:read',
  credential: 'credential:read',
  dataTable: 'dataTable:read',
} as const;

function allows(filter: AccessFilter, kind: DependencyResourceKind, row: ResourceName): boolean {
  if (filter.all) return true;
  if (row.projectId && filter.projectIds.includes(row.projectId)) return true;
  if (kind === 'workflow') return filter.workflowIds.includes(row.id);
  if (kind === 'credential') return filter.credentialIds.includes(row.id);
  return false;
}

function decodeCursor(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const skip = text.startsWith(CURSOR_PREFIX) ? Number(text.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (!Number.isSafeInteger(skip) || skip < 0 || Buffer.from(text, 'utf8').toString('base64url') !== raw) {
    throw ApiError.badRequest('Invalid cursor');
  }
  return skip;
}

const encodeCursor = (skip: number) => Buffer.from(`${CURSOR_PREFIX}${skip}`, 'utf8').toString('base64url');

const sortDetails = (details: DependencyDetail[]): DependencyDetail[] =>
  details.sort(
    (a, b) =>
      KEY_ORDER.indexOf(a.key) - KEY_ORDER.indexOf(b.key) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

export class DependencyService {
  constructor(readonly deps: ServiceDeps) {}

  private get ctx(): ServerContext {
    return this.deps.context();
  }

  /** by resource id */
  async counts(
    auth: AuthContext,
    resourceType: DependencyResourceKind,
    resourceIds: string[],
  ): Promise<Record<string, DependencyCounts>> {
    const details = await this.collect(auth, resourceType, resourceIds);
    const out: Record<string, DependencyCounts> = {};
    for (const [id, list] of details) {
      const counts: DependencyCounts = {};
      for (const detail of list) counts[detail.key] = (counts[detail.key] ?? 0) + 1;
      out[id] = counts;
    }
    return out;
  }

  /** by resource id */
  async details(
    auth: AuthContext,
    resourceType: DependencyResourceKind,
    resourceIds: string[],
  ): Promise<Record<string, DependencyDetail[]>> {
    return Object.fromEntries(await this.collect(auth, resourceType, resourceIds));
  }

  async folderDependencies(
    auth: AuthContext,
    projectId: string,
    folderId: string,
  ): Promise<FolderDependencies> {
    const tenantId = auth.tenant.id;
    const { repos } = this.deps;
    const folder = isUuid(folderId) ? await repos.folders.get(tenantId, folderId) : undefined;
    if (!folder || folder.projectId !== projectId) throw ApiError.notFound('Folder');
    const visible = await this.ctx.access.listFilter(auth, READ_SCOPE.workflow);
    const inTree = (await repos.dependencies.workflowsInFolderTree(tenantId, projectId, folderId)).filter(
      (workflow) => allows(visible, 'workflow', { id: workflow.id, name: workflow.name, projectId }),
    );
    const treeIds = new Set(inTree.map((workflow) => workflow.id));
    const byTarget = await this.parents(auth, [...treeIds]);
    const out: FolderDependencies['workflows'] = [];
    for (const workflow of inTree) {
      // a workflow that moves with the folder is no outside user
      const dependencies = sortDetails((byTarget.get(workflow.id) ?? []).filter((d) => !treeIds.has(d.id)));
      if (dependencies.length) out.push({ id: workflow.id, name: workflow.name, dependencies });
    }
    return { workflows: out };
  }

  async forWorkflow(
    auth: AuthContext,
    workflowId: string,
    page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    return this.pageOf(auth, 'workflow', workflowId, page);
  }

  async forCredential(
    auth: AuthContext,
    credentialId: string,
    page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    return this.pageOf(auth, 'credential', credentialId, page);
  }

  async forDataTable(
    auth: AuthContext,
    dataTableId: string,
    page: DependencyPageQuery = {},
  ): Promise<DependencyPage> {
    return this.pageOf(auth, 'dataTable', dataTableId, page);
  }

  // ---- internals ----

  private async pageOf(
    auth: AuthContext,
    kind: DependencyResourceKind,
    id: string,
    page: DependencyPageQuery,
  ): Promise<DependencyPage> {
    const skip = decodeCursor(page.cursor);
    const take = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const [row] = await this.deps.repos.dependencies.namesOf(auth.tenant.id, kind, [id]);
    if (!row)
      throw ApiError.notFound(
        kind === 'dataTable' ? 'Data table' : kind === 'workflow' ? 'Workflow' : 'Credential',
      );
    const visible = await this.ctx.access.listFilter(auth, READ_SCOPE[kind]);
    if (!allows(visible, kind, row)) throw ApiError.forbidden(MISSING_SCOPE_MESSAGE);
    const all = (await this.collect(auth, kind, [id])).get(id) ?? [];
    const data = all.slice(skip, skip + take);
    const end = skip + data.length;
    return { data, nextCursor: data.length > 0 && end < all.length ? encodeCursor(end) : null };
  }

  /** the workflows that call or name (as error workflow) each of `workflowIds`, the ones the caller reads */
  private async parents(auth: AuthContext, workflowIds: string[]): Promise<Map<string, DependencyDetail[]>> {
    const out = new Map<string, DependencyDetail[]>();
    if (!workflowIds.length) return out;
    const visible = await this.ctx.access.listFilter(auth, READ_SCOPE.workflow);
    const rows = await this.deps.repos.dependencies.workflowsReferencing(auth.tenant.id, workflowIds);
    for (const row of rows) {
      const holder = { id: row.workflowId, name: row.workflowName, projectId: row.projectId };
      if (!allows(visible, 'workflow', holder)) continue;
      push(out, row.resourceId, {
        key: row.key === 'errorWorkflow' ? 'errorWorkflowParent' : 'workflowParent',
        id: row.workflowId,
        name: row.workflowName,
        resourceType: 'workflow',
        projectId: row.projectId,
        active: row.active,
      });
    }
    return out;
  }

  /** the readable resources among `ids`, each with the details the caller may see (empty when none) */
  private async collect(
    auth: AuthContext,
    kind: DependencyResourceKind,
    ids: string[],
  ): Promise<Map<string, DependencyDetail[]>> {
    const unique = [...new Set(ids)];
    if (unique.length > DEPENDENCY_BATCH_LIMIT) {
      throw ApiError.badRequest(`At most ${DEPENDENCY_BATCH_LIMIT} ids are allowed`);
    }
    const tenantId = auth.tenant.id;
    const repo = this.deps.repos.dependencies;
    const access = this.ctx.access;
    const ownFilter = await access.listFilter(auth, READ_SCOPE[kind]);
    const resources = (await repo.namesOf(tenantId, kind, unique)).filter((row) =>
      allows(ownFilter, kind, row),
    );
    const readable = resources.map((row) => row.id);
    const out = new Map<string, DependencyDetail[]>(readable.map((id) => [id, []]));
    if (!readable.length) return out;

    if (kind === 'workflow') {
      for (const [id, list] of await this.parents(auth, readable)) out.get(id)?.push(...list);
      const own = await repo.referencesOf(tenantId, readable);
      const names = new Map<DependencyResourceKind, Map<string, ResourceName>>();
      const filters = new Map<DependencyResourceKind, AccessFilter>();
      const kindOf = (row: DependencyRow): DependencyResourceKind =>
        row.key === 'credentialId' ? 'credential' : row.key === 'dataTableId' ? 'dataTable' : 'workflow';
      for (const target of ['workflow', 'credential', 'dataTable'] as const) {
        const wanted = own.filter((row) => kindOf(row) === target).map((row) => row.resourceId);
        names.set(
          target,
          new Map((await repo.namesOf(tenantId, target, wanted)).map((row) => [row.id, row])),
        );
        filters.set(target, await access.listFilter(auth, READ_SCOPE[target]));
      }
      for (const row of own) {
        const target = kindOf(row);
        const resource = names.get(target)?.get(row.resourceId);
        if (!resource || !allows(filters.get(target) as AccessFilter, target, resource)) continue;
        push(out, row.workflowId, {
          key: row.key === 'workflowCall' ? 'workflowCall' : row.key,
          id: resource.id,
          name: resource.name,
          resourceType: target,
          projectId: resource.projectId,
          ...(target === 'workflow' ? { active: resource.active } : {}),
        });
      }
    } else {
      const rows =
        kind === 'credential'
          ? await repo.workflowsUsingCredentials(tenantId, readable)
          : await repo.workflowsUsingDataTables(tenantId, readable);
      const visible = await access.listFilter(auth, READ_SCOPE.workflow);
      for (const row of rows) {
        if (
          !allows(visible, 'workflow', {
            id: row.workflowId,
            name: row.workflowName,
            projectId: row.projectId,
          })
        ) {
          continue;
        }
        push(out, row.resourceId, {
          key: row.key,
          id: row.workflowId,
          name: row.workflowName,
          resourceType: 'workflow',
          projectId: row.projectId,
          active: row.active,
        });
      }
    }
    for (const [id, list] of out) out.set(id, sortDetails(dedupe(list)));
    return out;
  }
}

function push(map: Map<string, DependencyDetail[]>, id: string, detail: DependencyDetail): void {
  const list = map.get(id);
  if (list) list.push(detail);
  else map.set(id, [detail]);
}

function dedupe(list: DependencyDetail[]): DependencyDetail[] {
  const seen = new Set<string>();
  return list.filter((detail) => {
    const key = `${detail.key}:${detail.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
