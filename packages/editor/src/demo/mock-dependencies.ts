/**
 * P6-86 (C0): the demo's dependency counts and details (what uses a workflow, a credential or a data table, and
 * what a folder's workflows use). The routes answer 501 until L18 fills them. L18 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerDependencyRoutes(backend: MockBackend): void {
  // stub (L18)
  backend.on('POST', '/workflow-dependencies/counts', () => notImplemented('L18'));
  backend.on('POST', '/workflow-dependencies/details', () => notImplemented('L18'));
  backend.on('GET', '/workflow-dependencies/projects/:projectId/folders/:folderId', () =>
    notImplemented('L18'),
  );
}
