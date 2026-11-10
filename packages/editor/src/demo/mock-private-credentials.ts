/**
 * P6-15 (C0): the demo's private credentials: a user connects their own account to a shared credential and
 * clears their own connection. The routes answer 501 until L14 fills them. L14 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerPrivateCredentialRoutes(backend: MockBackend): void {
  // stub (L14)
  backend.on('POST', '/credentials/:id/authorize', () => notImplemented('L14'));
  backend.on('DELETE', '/credentials/:id/my-connection', () => notImplemented('L14'));
}
