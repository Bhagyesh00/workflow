/**
 * P6-18 (C0): the demo's two-factor sign-in: setup, enable, disable, verify and the workspace's enforcement.
 * mock-backend.ts reads `MockBackend.mfaEnabledUsers` (`/auth/me` `mfaEnabled`, the `/auth/login` step) and
 * calls `MockBackend.mfaCheck` for a code, so L2 writes both from here and needs no mock-backend.ts edit. The
 * routes answer 501 until L2 fills them. L2 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerMfaRoutes(backend: MockBackend): void {
  // stub (L2)
  backend.on('GET', '/auth/mfa/setup', () => notImplemented('L2'));
  backend.on('POST', '/auth/mfa/enable', () => notImplemented('L2'));
  backend.on('POST', '/auth/mfa/disable', () => notImplemented('L2'));
  backend.on('POST', '/auth/mfa/verify', () => notImplemented('L2'));
  backend.on('POST', '/settings/mfa-enforce', () => notImplemented('L2'));
}
