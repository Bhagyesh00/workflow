/**
 * P6-83 (C0): the demo's public API rate limit settings (Settings > Security). The routes answer 501 until L15
 * fills them. L15 owns this file after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerRateLimitRoutes(backend: MockBackend): void {
  // stub (L15)
  backend.on('GET', '/settings/policies/rate-limits', () => notImplemented('L15'));
  backend.on('PUT', '/settings/policies/rate-limits', () => notImplemented('L15'));
}
