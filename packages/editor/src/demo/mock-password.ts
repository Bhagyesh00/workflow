/**
 * P6-19 (C0): the demo's password reset, email change and profile: forgot and reset password, the reset link of
 * a member, the account's name, password and email. The routes answer 501 until L3 fills them. L3 owns this file
 * after C0.
 */
import type { MockBackend } from './mock-backend';
import { notImplemented } from './mock-http';

export function registerPasswordRoutes(backend: MockBackend): void {
  // stub (L3)
  backend.on('POST', '/auth/forgot-password', () => notImplemented('L3'));
  backend.on('POST', '/auth/reset-token/resolve', () => notImplemented('L3'));
  backend.on('POST', '/auth/reset-password', () => notImplemented('L3'));
  backend.on('POST', '/auth/confirm-email-change', () => notImplemented('L3'));
  backend.on('PATCH', '/auth/me', () => notImplemented('L3'));
  backend.on('PATCH', '/auth/me/password', () => notImplemented('L3'));
  backend.on('POST', '/auth/change-email', () => notImplemented('L3'));
  backend.on('GET', '/members/:userId/password-reset-link', () => notImplemented('L3'));
}
