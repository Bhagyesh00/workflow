/**
 * P6-81 (C0): the demo's collaboration: who has a workflow open (presence) and who holds its write access. The
 * routes answer 501 until L14 fills them. L14 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerCollaborationRoutes(backend: MockBackend): void {
  // stub (L14)
  backend.on('POST', '/workflows/:id/presence', () => notImplemented('L14'));
  backend.on('POST', '/workflows/:id/write-access', () => notImplemented('L14'));
}
