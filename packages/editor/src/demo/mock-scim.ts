/**
 * P6-02 (C0): the demo's SCIM settings: the config, the deprovisioning choice, the token and the transfer
 * targets. The routes answer 501 until L13 fills them. L13 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerScimRoutes(backend: MockBackend): void {
  // stub (L13)
  backend.on('GET', '/scim/config', () => notImplemented('L13'));
  backend.on('PATCH', '/scim/config', () => notImplemented('L13'));
  backend.on('PUT', '/scim/deprovisioning', () => notImplemented('L13'));
  backend.on('POST', '/scim/token', () => notImplemented('L13'));
  backend.on('DELETE', '/scim/token', () => notImplemented('L13'));
  backend.on('GET', '/scim/transfer-targets', () => notImplemented('L13'));
}
