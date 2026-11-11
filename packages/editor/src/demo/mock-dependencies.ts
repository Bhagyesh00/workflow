/**
 * P6-86: the demo's dependency counts and details (what uses a workflow, a credential or a data table, and
 * what a folder's workflows use), computed from the stored workflows as the server does (no table). Rows the
 * signed-in user cannot read (`workflow:read`, `credential:read`) are left out and the counts follow; at most
 * 100 ids a call.
 */
import { isResourceLocatorValue, type WorkflowNode } from '@workflow/workflow';
import type { DependencyCounts, DependencyDetail, DependencyKey, DependencyResourceKind } from '../api/types';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { dataTableName } from './mock-data-tables';
import { folderState } from './mock-folders';
import { HttpError } from './mock-http';

const BATCH_LIMIT = 100;
const SUB_WORKFLOW_NODES = ['core.executeWorkflow', 'ai.toolWorkflow', 'ai.retrieverWorkflow'];
const DATA_TABLE_NODES = ['core.dataTable', 'core.dataTableTool'];
const KEY_ORDER: DependencyKey[] = [
  'workflowParent',
  'errorWorkflowParent',
  'workflowCall',
  'errorWorkflow',
  'credentialId',
  'dataTableId',
];

const locatorValue = (raw: unknown): string | undefined =>
  typeof raw === 'string' ? raw : isResourceLocatorValue(raw) ? String(raw.value) : undefined;

/** the sub-workflow a node calls from the workspace (an inline definition names none) */
function calledWorkflow(node: WorkflowNode): string | undefined {
  if (!SUB_WORKFLOW_NODES.includes(node.type)) return undefined;
  if ((node.parameters?.source ?? 'database') === 'parameter') return undefined;
  return locatorValue(node.parameters?.workflowId);
}

/** whether a Data Table node names the table (by id, or by name in name mode) */
function namesTable(node: WorkflowNode, table: { id: string; name: string }): boolean {
  if (!DATA_TABLE_NODES.includes(node.type)) return false;
  const ref = node.parameters?.dataTableId;
  if (isResourceLocatorValue(ref) && ref.mode === 'name') return ref.value === table.name;
  return locatorValue(ref) === table.id;
}

const credentialIdsOf = (node: WorkflowNode): string[] => {
  const slots = node.credentials as Record<string, { id?: unknown } | null> | undefined;
  return Object.values(slots ?? {}).flatMap((ref) => (typeof ref?.id === 'string' ? [ref.id] : []));
};

const sortDetails = (details: DependencyDetail[]) =>
  details.sort(
    (a, b) =>
      KEY_ORDER.indexOf(a.key) - KEY_ORDER.indexOf(b.key) ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );

export function registerDependencyRoutes(backend: MockBackend): void {
  const tenantWorkflows = (): StoredWorkflow[] => {
    const { tenant } = backend.auth();
    return backend.workflows.filter((w) => w.tenantId === tenant.id);
  };
  const canReadWorkflow = (w: StoredWorkflow) => backend.rowScopes(w).includes('workflow:read');
  const detailOf = (key: DependencyKey, w: StoredWorkflow): DependencyDetail => ({
    key,
    id: w.id,
    name: w.name,
    resourceType: 'workflow',
    projectId: w.projectId ?? null,
    active: w.active,
  });

  /** the workflows that call or name `id` as their error workflow, the ones the caller reads */
  const parentsOf = (id: string): DependencyDetail[] => {
    const out: DependencyDetail[] = [];
    for (const w of tenantWorkflows()) {
      if (!canReadWorkflow(w)) continue;
      if (w.nodes.some((node) => calledWorkflow(node) === id)) out.push(detailOf('workflowParent', w));
      if (w.settings?.errorWorkflow === id) out.push(detailOf('errorWorkflowParent', w));
    }
    return out;
  };

  /** undefined when the resource is missing or the caller cannot read it */
  const detailsFor = (kind: DependencyResourceKind, id: string): DependencyDetail[] | undefined => {
    const all = tenantWorkflows();
    if (kind === 'credential') {
      const credential = backend.credentials.find(
        (c) => c.id === id && c.tenantId === backend.auth().tenant.id,
      );
      if (!credential || !backend.rowScopes(credential).includes('credential:read')) return undefined;
      return sortDetails(
        all
          .filter((w) => canReadWorkflow(w) && w.nodes.some((node) => credentialIdsOf(node).includes(id)))
          .map((w) => detailOf('credentialId', w)),
      );
    }
    if (kind === 'dataTable') {
      const name = dataTableName(id);
      if (name === undefined) return undefined;
      return sortDetails(
        all
          .filter((w) => canReadWorkflow(w) && w.nodes.some((node) => namesTable(node, { id, name })))
          .map((w) => detailOf('dataTableId', w)),
      );
    }
    const self = all.find((w) => w.id === id);
    if (!self || !canReadWorkflow(self)) return undefined;
    const out = parentsOf(id);
    const target = (key: 'workflowCall' | 'errorWorkflow', ref: string | undefined) => {
      const w = all.find((candidate) => candidate.id === ref);
      if (w && canReadWorkflow(w)) out.push(detailOf(key, w));
    };
    for (const node of self.nodes) {
      target('workflowCall', calledWorkflow(node));
      for (const credentialId of credentialIdsOf(node)) {
        const credential = backend.credentials.find(
          (c) => c.id === credentialId && c.tenantId === self.tenantId,
        );
        if (credential && backend.rowScopes(credential).includes('credential:read')) {
          out.push({
            key: 'credentialId',
            id: credential.id,
            name: credential.name,
            resourceType: 'credential',
            projectId: credential.projectId ?? null,
          });
        }
      }
      if (DATA_TABLE_NODES.includes(node.type)) {
        const ref = locatorValue(node.parameters?.dataTableId);
        const name = ref ? dataTableName(ref) : undefined;
        if (ref && name !== undefined && !isNameMode(node)) {
          out.push({
            key: 'dataTableId',
            id: ref,
            name,
            resourceType: 'dataTable',
            projectId: null,
          });
        }
      }
    }
    target(
      'errorWorkflow',
      typeof self.settings?.errorWorkflow === 'string' ? self.settings.errorWorkflow : undefined,
    );
    const seen = new Set<string>();
    return sortDetails(
      out.filter((d) => {
        const k = `${d.key}:${d.id}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    );
  };

  const isNameMode = (node: WorkflowNode) => {
    const ref = node.parameters?.dataTableId;
    return isResourceLocatorValue(ref) && ref.mode === 'name';
  };

  const readQuery = (body: Record<string, unknown>): { kind: DependencyResourceKind; ids: string[] } => {
    const kind = body.resourceType;
    if (kind !== 'workflow' && kind !== 'credential' && kind !== 'dataTable') {
      throw new HttpError(400, 'bad_request', 'resourceType must be workflow, credential or dataTable');
    }
    const ids = Array.isArray(body.resourceIds) ? [...new Set(body.resourceIds.map(String))] : [];
    if (ids.length > BATCH_LIMIT) {
      throw new HttpError(400, 'bad_request', `At most ${BATCH_LIMIT} ids are allowed`);
    }
    return { kind, ids };
  };

  backend.on('POST', '/workflow-dependencies/counts', ({ body }) => {
    const { kind, ids } = readQuery(body);
    const out: Record<string, DependencyCounts> = {};
    for (const id of ids) {
      const details = detailsFor(kind, id);
      if (!details) continue;
      const counts: DependencyCounts = {};
      for (const detail of details) counts[detail.key] = (counts[detail.key] ?? 0) + 1;
      out[id] = counts;
    }
    return out;
  });

  backend.on('POST', '/workflow-dependencies/details', ({ body }) => {
    const { kind, ids } = readQuery(body);
    const out: Record<string, DependencyDetail[]> = {};
    for (const id of ids) {
      const details = detailsFor(kind, id);
      if (details) out[id] = details;
    }
    return out;
  });

  backend.on('GET', '/workflow-dependencies/projects/:projectId/folders/:folderId', ({ params }) => {
    const { tenant } = backend.auth();
    const folders = folderState(backend).folders.filter((f) => f.tenantId === tenant.id);
    const root = folders.find((f) => f.id === params[1]);
    if (!root || (root.projectId !== undefined && root.projectId !== params[0])) {
      throw new HttpError(404, 'not_found', 'Folder not found');
    }
    const tree = [root.id];
    for (let i = 0; i < tree.length; i++) {
      for (const f of folders) if (f.parentFolderId === tree[i] && !tree.includes(f.id)) tree.push(f.id);
    }
    const inTree = tenantWorkflows().filter(
      (w) =>
        w.folderId !== null && w.folderId !== undefined && tree.includes(w.folderId) && canReadWorkflow(w),
    );
    const treeIds = new Set(inTree.map((w) => w.id));
    const workflows = inTree.flatMap((w) => {
      const dependencies = sortDetails(parentsOf(w.id).filter((d) => !treeIds.has(d.id)));
      return dependencies.length ? [{ id: w.id, name: w.name, dependencies }] : [];
    });
    return { workflows };
  });
}
