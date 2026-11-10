/**
 * P6-12 (C0): the demo's LDAP settings: the config, the connection test and the sync runs. The routes answer 501
 * until L10 fills them. L10 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerLdapRoutes(backend: MockBackend): void {
  // stub (L10)
  backend.on('GET', '/ldap/config', () => notImplemented('L10'));
  backend.on('PUT', '/ldap/config', () => notImplemented('L10'));
  backend.on('POST', '/ldap/test-connection', () => notImplemented('L10'));
  backend.on('GET', '/ldap/sync', () => notImplemented('L10'));
  backend.on('POST', '/ldap/sync', () => notImplemented('L10'));
}
