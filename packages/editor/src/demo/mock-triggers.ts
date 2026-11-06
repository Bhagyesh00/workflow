/** Demo routes for test-listening on a trigger without a URL. Stubs: L12 (P4-21) writes them. */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerTriggerListenRoutes(backend: MockBackend): void {
  backend.on('POST', '/workflows/:id/listen-test-trigger', () => notImplemented('L12'));
  backend.on('DELETE', '/workflows/:id/listen-test-trigger', () => notImplemented('L12'));
}
