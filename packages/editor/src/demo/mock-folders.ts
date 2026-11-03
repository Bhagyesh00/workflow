/**
 * Demo routes for folders, favorites, archive and move (P3-07), registered by the MockBackend
 * constructor, plus the folder and archived filter of GET /workflows.
 *
 * They follow the server's rules: the folder name rule, no move into itself or a subfolder, delete
 * with or without a transfer folder, archive unpublishes first, an archived workflow is deleted only
 * after archiving, favorites are per user. State lives in `backend.ext.folders`.
 */
import type { Favorite, FavoriteResourceType, Folder, FolderDetail } from '../api/types';
import { folderNameError } from '../components/workflow/FolderDialog';
import { newId } from '../lib/ids';
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { copy, HttpError, listResult, now, page } from './mock-http';

interface StoredFolder {
  id: string;
  tenantId: string;
  name: string;
  parentFolderId: string | null;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface StoredFavorite {
  tenantId: string;
  userId: string;
  resourceType: FavoriteResourceType;
  resourceId: string;
  createdAt: string;
}

interface FolderState {
  folders: StoredFolder[];
  favorites: StoredFavorite[];
}

/** the folders and favorites of every workspace in the demo */
export function folderState(backend: MockBackend): FolderState {
  backend.ext.folders ??= { folders: [], favorites: [] } satisfies FolderState;
  return backend.ext.folders as FolderState;
}

const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  const error = folderNameError(name);
  if (error) throw new HttpError(400, 'validation_error', error);
  return name;
}

export function registerFolderRoutes(backend: MockBackend): void {
  const folderOf = (id: string): StoredFolder => {
    const { tenant } = backend.auth();
    const folder = folderState(backend).folders.find((f) => f.id === id && f.tenantId === tenant.id);
    if (!folder) throw notFound('Folder');
    return folder;
  };
  const subtree = (id: string): string[] => {
    const all = folderState(backend).folders;
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const f of all) if (f.parentFolderId === ids[i] && !ids.includes(f.id)) ids.push(f.id);
    }
    return ids;
  };
  const dto = (f: StoredFolder): Folder => ({
    id: f.id,
    name: f.name,
    parentFolderId: f.parentFolderId,
    tags: backend.tags.filter((t) => f.tagIds.includes(t.id)).map(({ id, name }) => ({ id, name })),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  });
  const checkParent = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw badRequest('The parent folder id is not valid');
    return folderOf(value).id;
  };
  const unpublish = (wf: StoredWorkflow) => {
    wf.active = false;
    wf.publishedVersionId = null;
  };
  const archive = (wf: StoredWorkflow, publicApi = false) => {
    if (wf.isArchived) {
      if (publicApi) return;
      throw badRequest('The workflow is already archived.');
    }
    unpublish(wf);
    wf.isArchived = true;
    wf.updatedAt = now();
  };

  backend.on('GET', '/folders', ({ query }) => {
    const { tenant } = backend.auth();
    const search = (query.search ?? '').toLowerCase();
    const tagNames = (query.tags ?? '').split(',').filter(Boolean);
    const list = folderState(backend)
      .folders.filter((f) => f.tenantId === tenant.id)
      .filter((f) => {
        if (query.parentFolderId === undefined) return true;
        return query.parentFolderId === 'root'
          ? f.parentFolderId === null
          : f.parentFolderId === query.parentFolderId;
      })
      .filter((f) => !search || f.name.toLowerCase().includes(search))
      .filter((f) => {
        const names = dto(f).tags.map((t) => t.name);
        return tagNames.every((n) => names.includes(n));
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(dto);
    return listResult(page(list, query));
  });

  backend.on('GET', '/folders/:id', ({ params }) => {
    const folder = folderOf(params[0]);
    const { tenant } = backend.auth();
    const path: Folder['id'][] = [];
    const names: Array<{ id: string; name: string }> = [];
    let parent = folder.parentFolderId;
    while (parent && !path.includes(parent)) {
      const up = folderOf(parent);
      path.push(up.id);
      names.unshift({ id: up.id, name: up.name });
      parent = up.parentFolderId;
    }
    const ids = subtree(folder.id);
    const detail: FolderDetail = {
      ...dto(folder),
      path: names,
      workflowCount: backend.workflows.filter(
        (w) => w.tenantId === tenant.id && !w.isArchived && w.folderId !== null && ids.includes(w.folderId),
      ).length,
      subFolderCount: ids.length - 1,
    };
    return detail;
  });

  backend.on('POST', '/folders', ({ body }) => {
    const { tenant } = backend.requireRole('editor');
    const name = parseName(body.name);
    const parentFolderId = checkParent(body.parentFolderId);
    const folder: StoredFolder = {
      id: newId(),
      tenantId: tenant.id,
      name,
      parentFolderId,
      tagIds: [],
      createdAt: now(),
      updatedAt: now(),
    };
    folderState(backend).folders.push(folder);
    return dto(folder);
  });

  backend.on('PATCH', '/folders/:id', ({ params, body }) => {
    backend.requireRole('editor');
    const folder = folderOf(params[0]);
    if (body.name === undefined && body.parentFolderId === undefined && body.tagIds === undefined)
      throw new HttpError(400, 'validation_error', 'Nothing to update');
    const name = body.name === undefined ? undefined : parseName(body.name);
    const parent = body.parentFolderId === undefined ? undefined : checkParent(body.parentFolderId);
    if (parent && subtree(folder.id).includes(parent))
      throw badRequest('A folder cannot be moved into itself or one of its subfolders.');
    if (Array.isArray(body.tagIds)) {
      const known = backend.tags.filter((t) => (body.tagIds as string[]).includes(t.id));
      if (known.length !== new Set(body.tagIds as string[]).size) throw notFound('Tag');
      folder.tagIds = known.map((t) => t.id);
    }
    if (name !== undefined) folder.name = name;
    if (parent !== undefined) folder.parentFolderId = parent;
    folder.updatedAt = now();
    return dto(folder);
  });

  backend.on('DELETE', '/folders/:id', ({ params, body }) => {
    const { tenant } = backend.requireRole('editor');
    const folder = folderOf(params[0]);
    const state = folderState(backend);
    const ids = subtree(folder.id);
    const transfer = body.transferToFolderId;
    if (transfer === undefined) {
      for (const wf of backend.workflows) {
        if (wf.tenantId !== tenant.id || wf.folderId === null || !ids.includes(wf.folderId)) continue;
        archive(wf, true);
        wf.folderId = null;
      }
      state.folders = state.folders.filter((f) => !ids.includes(f.id));
      state.favorites = state.favorites.filter(
        (f) => !(f.resourceType === 'folder' && ids.includes(f.resourceId)),
      );
      return { ok: true };
    }
    const target = transfer === 'root' ? null : folderOf(String(transfer)).id;
    if (target && ids.includes(target))
      throw badRequest('The workflows cannot be moved into the folder that is being deleted.');
    for (const wf of backend.workflows) {
      if (wf.tenantId === tenant.id && wf.folderId === folder.id) wf.folderId = target;
    }
    for (const f of state.folders) if (f.parentFolderId === folder.id) f.parentFolderId = target;
    state.folders = state.folders.filter((f) => f.id !== folder.id);
    state.favorites = state.favorites.filter(
      (f) => !(f.resourceType === 'folder' && f.resourceId === folder.id),
    );
    return { ok: true };
  });

  // favorites: per user ---------------------------------------------------------------------------
  backend.on('GET', '/favorites', () => {
    const { tenant, user } = backend.auth();
    const state = folderState(backend);
    const list: Favorite[] = [];
    for (const fav of state.favorites) {
      if (fav.tenantId !== tenant.id || fav.userId !== user.id) continue;
      const name =
        fav.resourceType === 'workflow'
          ? backend.workflows.find(
              (w) => w.id === fav.resourceId && w.tenantId === tenant.id && !w.isArchived,
            )?.name
          : state.folders.find((f) => f.id === fav.resourceId && f.tenantId === tenant.id)?.name;
      if (name !== undefined)
        list.push({
          resourceType: fav.resourceType,
          resourceId: fav.resourceId,
          name,
          createdAt: fav.createdAt,
        });
    }
    return list;
  });
  backend.on('POST', '/favorites', ({ body }) => {
    const { tenant, user } = backend.auth();
    const type = body.resourceType;
    if (type !== 'workflow' && type !== 'folder') throw new HttpError(400, 'validation_error', 'Bad type');
    const id = String(body.resourceId ?? '');
    const name = type === 'workflow' ? backend.workflow(id).name : folderOf(id).name;
    const state = folderState(backend);
    let existing = state.favorites.find(
      (f) => f.userId === user.id && f.resourceType === type && f.resourceId === id,
    );
    if (!existing) {
      existing = {
        tenantId: tenant.id,
        userId: user.id,
        resourceType: type,
        resourceId: id,
        createdAt: now(),
      };
      state.favorites.push(existing);
    }
    return { resourceType: type, resourceId: id, name, createdAt: existing.createdAt } satisfies Favorite;
  });
  backend.on('DELETE', '/favorites/:resourceType/:resourceId', ({ params }) => {
    const { user } = backend.auth();
    const state = folderState(backend);
    state.favorites = state.favorites.filter(
      (f) => !(f.userId === user.id && f.resourceType === params[0] && f.resourceId === params[1]),
    );
    return { ok: true };
  });

  // workflows: move and archive -------------------------------------------------------------------
  backend.on('POST', '/workflows/move', ({ body }) => {
    backend.requireRole('editor');
    const ids = Array.isArray(body.workflowIds) ? (body.workflowIds as string[]) : [];
    const folderId = checkParent(body.folderId);
    const list = ids.map((id) => backend.workflow(id));
    for (const wf of list) {
      wf.folderId = folderId;
      wf.updatedAt = now();
    }
    return { moved: list.map((w) => w.id) };
  });
  backend.on('POST', '/workflows/:id/archive', ({ params }) => {
    backend.requireRole('editor');
    const wf = backend.workflow(params[0]);
    archive(wf);
    return backend.toDto(wf);
  });
  backend.on('POST', '/workflows/:id/unarchive', ({ params }) => {
    backend.requireRole('editor');
    const wf = backend.workflow(params[0]);
    if (!wf.isArchived) throw badRequest('The workflow is not archived.');
    wf.isArchived = false;
    wf.updatedAt = now();
    return backend.toDto(wf);
  });
}

/**
 * GET /workflows filters `folderId` (an id or 'root'; omitted = all) and `archived` ('false'
 * default hides archived, 'true' only archived, 'all'), applied before search and paging.
 */
export function filterWorkflowList(
  _backend: MockBackend,
  workflows: StoredWorkflow[],
  query: Record<string, string>,
): StoredWorkflow[] {
  const archived = query.archived ?? 'false';
  return workflows
    .filter((w) => archived === 'all' || w.isArchived === (archived === 'true'))
    .filter((w) => {
      if (query.folderId === undefined) return true;
      return query.folderId === 'root' ? w.folderId === null : w.folderId === query.folderId;
    });
}

/** a deep copy of the demo folders of the signed-in workspace (tests) */
export function folderRows(backend: MockBackend): StoredFolder[] {
  return copy(folderState(backend).folders);
}
