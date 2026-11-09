/**
 * P6-29, P6-30: the demo's sharing and moving. The share store is here so Settings > Security can count what
 * personal projects share (C0). Routes: PUT /workflows/:id/share and /credentials/:id/share (the full list of
 * project ids), the transfer previews and the transfers of workflows, credentials and folders (a folder moves
 * with its whole tree). A move drops every share of what it moves, as the server does.
 */
import type { Scope } from '@workflow/workflow';
import type { PolicyViolation, TransferPreview } from '../api/types';
import type { MockBackend, StoredProject, StoredWorkflow } from './mock-backend';
import { folderState } from './mock-folders';
import { HttpError, now } from './mock-http';

/** a share of a workflow or credential with a project (the server's shared_workflow, shared_credentials rows) */
export interface StoredShare {
  tenantId: string;
  resourceType: 'workflow' | 'credential';
  resourceId: string;
  projectId: string;
  /** the resource role of the share: `workflow:editor` or `credential:user` */
  role: string;
}

interface SharingState {
  shares: StoredShare[];
}

function state(backend: MockBackend): SharingState {
  let s = backend.ext.sharing as SharingState | undefined;
  if (!s) {
    s = { shares: [] };
    backend.ext.sharing = s;
  }
  return s;
}

/** every share of the demo (all workspaces); callers filter by `tenantId` */
export function demoShares(backend: MockBackend): StoredShare[] {
  return state(backend).shares;
}

const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function projectIn(backend: MockBackend, id: unknown): StoredProject {
  const { tenant } = backend.auth();
  const project = typeof id === 'string' ? backend.projects.find((p) => p.id === id) : undefined;
  if (!project || project.tenantId !== tenant.id) throw new HttpError(404, 'not_found', 'Project not found');
  return project;
}

function destinationOf(backend: MockBackend, value: unknown, create: string): StoredProject {
  if (typeof value !== 'string' || !value) throw badRequest('destinationProjectId is required');
  const project = projectIn(backend, value);
  backend.requireScope(create as Scope, { scopes: backend.projectScopes(project) });
  return project;
}

const idList = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw badRequest(`${field} must be a list of ids`);
  return [...new Set(value as string[])];
};

const unpublish = (wf: StoredWorkflow) => {
  wf.active = false;
  wf.publishedVersionId = null;
};

/** why moving published work into `project` unpublishes it (personal space publishing off for the caller) */
function publishViolations(backend: MockBackend, project: StoredProject): PolicyViolation[] {
  const me = backend.auth().user.id;
  if (project.type !== 'personal' || project.ownerUserId !== me) return [];
  if (backend.projectScopes(project).includes('workflow:publish')) return [];
  return [
    {
      kind: 'personalSpacePublishing',
      checkId: 'personal-space-publishing',
      message: 'Publishing is disabled in personal spaces.',
      subjectType: 'workflow',
      projectId: project.id,
    },
  ];
}

export function registerSharingRoutes(backend: MockBackend): void {
  const dropShares = (type: 'workflow' | 'credential', id: string) => {
    const s = state(backend);
    s.shares = s.shares.filter((x) => !(x.resourceType === type && x.resourceId === id));
  };

  const credentialOf = (id: string) => {
    const { tenant } = backend.auth();
    const c = backend.credentials.find((x) => x.id === id && x.tenantId === tenant.id);
    if (!c) throw new HttpError(404, 'not_found', 'Credential not found');
    return c;
  };

  const shareRoute =
    (type: 'workflow' | 'credential') =>
    ({ params, body }: { params: string[]; body: Record<string, unknown> }) => {
      const { tenant } = backend.auth();
      const row = type === 'workflow' ? backend.workflow(params[0]) : credentialOf(params[0]);
      backend.requireScope(`${type}:share` as Scope, { scopes: backend.rowScopes(row) });
      const ids = idList(body.shareWithIds, 'shareWithIds');
      const targets = ids.map((id) => projectIn(backend, id)).filter((p) => p.id !== row.projectId);
      dropShares(type, row.id);
      for (const p of targets) {
        state(backend).shares.push({
          tenantId: tenant.id,
          resourceType: type,
          resourceId: row.id,
          projectId: p.id,
          role: type === 'workflow' ? 'workflow:editor' : 'credential:user',
        });
      }
      return { ok: true };
    };
  backend.on('PUT', '/workflows/:id/share', shareRoute('workflow'));
  backend.on('PUT', '/credentials/:id/share', shareRoute('credential'));

  const sameHome = (what: string) =>
    badRequest(
      what === 'workflow'
        ? "You can't transfer a workflow into the same destination it already belongs to."
        : what === 'credential'
          ? "You can't transfer a credential into the project that's already owning it."
          : "You can't transfer a folder into the same destination it already belongs to.",
    );

  const subtree = (rootId: string): string[] => {
    const all = folderState(backend).folders;
    const ids = [rootId];
    for (let i = 0; i < ids.length; i++)
      for (const f of all) if (f.parentFolderId === ids[i] && !ids.includes(f.id)) ids.push(f.id);
    return ids;
  };
  const folderOf = (id: string) => {
    const { tenant } = backend.auth();
    const f = folderState(backend).folders.find((x) => x.id === id && x.tenantId === tenant.id);
    if (!f) throw new HttpError(404, 'not_found', 'Folder not found');
    return f;
  };
  const workflowsIn = (folderIds: string[]) =>
    backend.workflows.filter(
      (w) =>
        w.tenantId === backend.auth().tenant.id &&
        !w.isArchived &&
        w.folderId !== null &&
        folderIds.includes(w.folderId),
    );

  const previewOf = (
    type: 'workflow' | 'credential' | 'folder',
    id: string,
    destinationId: string,
  ): TransferPreview => {
    const destination = projectIn(backend, destinationId);
    const row =
      type === 'workflow' ? backend.workflow(id) : type === 'credential' ? credentialOf(id) : folderOf(id);
    backend.requireScope(`${type}:move` as Scope, { scopes: backend.rowScopes(row) });
    if (row.projectId === destination.id) throw sameHome(type);
    const violations = publishViolations(backend, destination);
    const preview: TransferPreview = { restricted: [], checkFailed: false };
    if (type === 'workflow') {
      preview.unpublishReasons = backend.workflow(id).active ? violations : [];
    } else if (type === 'folder') {
      preview.workflowsToUnpublish =
        violations.length > 0
          ? workflowsIn(subtree(id))
              .filter((w) => w.active)
              .map((w) => ({ id: w.id, name: w.name }))
          : [];
    }
    return preview;
  };

  for (const type of ['workflow', 'credential', 'folder'] as const) {
    backend.on('GET', `/${type}s/:id/transfer-preview`, ({ params, query }) =>
      previewOf(type, params[0], query.destinationProjectId ?? ''),
    );
  }

  /** share the named credentials of the caller into `destination` (a pick the caller may share) */
  const shareCredentials = (ids: string[], destination: StoredProject) => {
    const { tenant } = backend.auth();
    for (const id of ids) {
      const c = credentialOf(id);
      backend.requireScope('credential:share', { scopes: backend.rowScopes(c) });
      const state1 = state(backend);
      if (c.projectId === destination.id) continue;
      if (
        state1.shares.some(
          (s) => s.resourceType === 'credential' && s.resourceId === id && s.projectId === destination.id,
        )
      )
        continue;
      state1.shares.push({
        tenantId: tenant.id,
        resourceType: 'credential',
        resourceId: id,
        projectId: destination.id,
        role: 'credential:user',
      });
    }
  };

  backend.on('PUT', '/workflows/:id/transfer', ({ params, body }) => {
    const wf = backend.workflow(params[0]);
    backend.requireScope('workflow:move', { scopes: backend.rowScopes(wf) });
    const destination = destinationOf(backend, body.destinationProjectId, 'workflow:create');
    if (wf.projectId === destination.id) throw sameHome('workflow');
    const picks = idList(body.shareCredentials, 'shareCredentials');
    if (publishViolations(backend, destination).length > 0 && wf.active) unpublish(wf);
    dropShares('workflow', wf.id);
    wf.projectId = destination.id;
    wf.folderId =
      typeof body.destinationParentFolderId === 'string' ? folderOf(body.destinationParentFolderId).id : null;
    wf.updatedAt = now();
    shareCredentials(picks, destination);
    return { ok: true };
  });

  backend.on('PUT', '/credentials/:id/transfer', ({ params, body }) => {
    const c = credentialOf(params[0]);
    backend.requireScope('credential:move', { scopes: backend.rowScopes(c) });
    const destination = destinationOf(backend, body.destinationProjectId, 'credential:create');
    if (c.projectId === destination.id) throw sameHome('credential');
    dropShares('credential', c.id);
    c.projectId = destination.id;
    c.updatedAt = now();
    return { ok: true };
  });

  backend.on('PUT', '/folders/:id/transfer', ({ params, body }) => {
    const folder = folderOf(params[0]);
    backend.requireScope('folder:move', { scopes: backend.rowScopes(folder) });
    const destination = destinationOf(backend, body.destinationProjectId, 'folder:create');
    if (folder.projectId === destination.id) throw sameHome('folder');
    const picks = idList(body.shareCredentials, 'shareCredentials');
    const parent =
      typeof body.destinationParentFolderId === 'string' ? folderOf(body.destinationParentFolderId) : null;
    if (parent && parent.projectId !== destination.id)
      throw badRequest('The destination folder is not in the destination project.');
    const tree = subtree(folder.id);
    const unpublishes = publishViolations(backend, destination).length > 0;
    for (const f of folderState(backend).folders.filter((x) => tree.includes(x.id))) {
      f.projectId = destination.id;
      f.updatedAt = now();
    }
    for (const wf of backend.workflows.filter((w) => w.tenantId === folder.tenantId)) {
      if (wf.folderId === null || !tree.includes(wf.folderId)) continue;
      if (unpublishes && wf.active) unpublish(wf);
      dropShares('workflow', wf.id);
      wf.projectId = destination.id;
      wf.updatedAt = now();
    }
    folder.parentFolderId = parent ? parent.id : null;
    shareCredentials(picks, destination);
    return { ok: true };
  });
}
