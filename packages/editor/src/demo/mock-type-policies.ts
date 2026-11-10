/**
 * P6-50 (C0): the demo's node and credential type policies as the editor reads them: the types a project may use
 * (`/projects/:projectId/available-types`, `/available-credential-types`), the sub-workflow policy check, and
 * `restrictedDemoTypes`, the types GET /workflows `executionBlockedBy=restrictedNode` looks for. The routes answer
 * 501 and `restrictedDemoTypes` answers [] until L5 fills them. L5 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

/** which policy a type belongs to (the server's `restrictedTypes(deps, tenantId, projectId, kind)`) */
export type DemoPolicyKind = 'node' | 'credential';

/**
 * The types the workspace's (and the project's) policy blocks, for GET /workflows `executionBlockedBy`.
 * stub (L5): nothing is blocked until L5 keeps the demo's policies.
 */
export function restrictedDemoTypes(
  _backend: MockBackend,
  _tenantId: string,
  _projectId: string | null | undefined,
  _kind: DemoPolicyKind = 'node',
): string[] {
  return [];
}

export function registerTypePolicyRoutes(backend: MockBackend): void {
  // stub (L5)
  backend.on('GET', '/projects/:projectId/available-types', () => notImplemented('L5'));
  backend.on('GET', '/projects/:projectId/available-credential-types', () => notImplemented('L5'));
  backend.on('GET', '/workflows/:id/sub-workflows/:subId/policy-check', () => notImplemented('L5'));
}
