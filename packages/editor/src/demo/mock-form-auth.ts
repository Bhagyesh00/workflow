/** Demo route that issues the one-time form sign-in code. Stub: L2 (P4-16) writes it. */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerFormAuthRoutes(backend: MockBackend): void {
  backend.on('POST', '/form-auth/code', () => notImplemented('L2'));
}
