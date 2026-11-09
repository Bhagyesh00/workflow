/**
 * P6-29, P6-30: the demo's sharing and moving. The share store is here so Settings > Security can count what
 * personal projects share (C0); every route answers 501 until L21 fills it (stub (L21)): PUT
 * /workflows/:id/share, /credentials/:id/share, the transfer previews and the transfers of workflows,
 * credentials and folders. L21 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

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

export function registerSharingRoutes(backend: MockBackend): void {
  // stub (L21)
  backend.on('PUT', '/workflows/:id/share', () => notImplemented('L21'));
  backend.on('PUT', '/credentials/:id/share', () => notImplemented('L21'));
  backend.on('GET', '/workflows/:id/transfer-preview', () => notImplemented('L21'));
  backend.on('GET', '/credentials/:id/transfer-preview', () => notImplemented('L21'));
  backend.on('GET', '/folders/:id/transfer-preview', () => notImplemented('L21'));
  backend.on('PUT', '/workflows/:id/transfer', () => notImplemented('L21'));
  backend.on('PUT', '/credentials/:id/transfer', () => notImplemented('L21'));
  backend.on('PUT', '/folders/:id/transfer', () => notImplemented('L21'));
}
