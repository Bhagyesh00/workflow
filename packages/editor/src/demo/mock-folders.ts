/**
 * Demo routes for folders, favorites, archive and move (P3-07), registered by the MockBackend
 * constructor, plus the folder and archived filter of GET /workflows.
 *
 * C0 STUB: lane L8 writes them. Until then lists answer empty and writes answer 501.
 * Lane state lives in `backend.ext` (e.g. `backend.ext.folders`).
 */
import type { MockBackend, StoredWorkflow } from './mock-backend';
import { listResult, notImplemented } from './mock-http';

export function registerFolderRoutes(backend: MockBackend): void {
  backend.on('GET', '/folders', () => {
    backend.auth();
    return listResult({ data: [], nextCursor: null });
  });
  backend.on('GET', '/folders/:id', () => notImplemented('L8'));
  backend.on('POST', '/folders', () => notImplemented('L8'));
  backend.on('PATCH', '/folders/:id', () => notImplemented('L8'));
  backend.on('DELETE', '/folders/:id', () => notImplemented('L8'));
  backend.on('GET', '/favorites', () => {
    backend.auth();
    return [];
  });
  backend.on('POST', '/favorites', () => notImplemented('L8'));
  backend.on('DELETE', '/favorites/:resourceType/:resourceId', () => notImplemented('L8'));
  backend.on('POST', '/workflows/move', () => notImplemented('L8'));
  backend.on('POST', '/workflows/:id/archive', () => notImplemented('L8'));
  backend.on('POST', '/workflows/:id/unarchive', () => notImplemented('L8'));
}

/**
 * GET /workflows filters `folderId` (an id or 'root'; omitted = all) and `archived` ('false'
 * default hides archived, 'true' only archived, 'all'), applied before search and paging.
 */
export function filterWorkflowList(
  _backend: MockBackend,
  workflows: StoredWorkflow[],
  _query: Record<string, string>,
): StoredWorkflow[] {
  return workflows;
}
