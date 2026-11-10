/**
 * P6-13 (C0): the demo's SSO settings. `GET /auth/sso-options` is FULL here (public, as the server's: the sign-in
 * page asks it before anyone is signed in), because L6's sign-in page test needs it before L11 builds the rest:
 * it answers what `MockBackend.setDemoSso` set, else email. The SSO method, the per-member manual login flag and
 * the SAML and OIDC settings answer 501 until L11 fills them. L11 owns this file after C0.
 */
import type { SsoOptions } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, notImplemented } from './mock-http';

interface SsoState {
  /** what `setDemoSso` set (null: the workspace signs in by email and password) */
  options: SsoOptions | null;
}

function state(backend: MockBackend): SsoState {
  let s = backend.ext.sso as SsoState | undefined;
  if (!s) {
    s = { options: null };
    backend.ext.sso = s;
  }
  return s;
}

/** the sign-in options of the demo, as `GET /auth/sso-options` answers them (email when none is set) */
export function demoSsoOptions(backend: MockBackend): SsoOptions {
  return copy(state(backend).options ?? { method: 'email', redirect: false });
}

/** tests and demo (`MockBackend.setDemoSso`): the sign-in options; null goes back to email */
export function setDemoSsoOptions(backend: MockBackend, options: SsoOptions | null): void {
  state(backend).options = options ? copy(options) : null;
}

export function registerSsoRoutes(backend: MockBackend): void {
  // public, as the server's: the sign-in page reads the method before a session exists (`?workspace=<slug>`)
  backend.on('GET', '/auth/sso-options', () => demoSsoOptions(backend));
  // stub (L11): the workspace's SSO method
  backend.on('GET', '/sso/method', () => notImplemented('L11'));
  backend.on('PUT', '/sso/method', () => notImplemented('L11'));
  // stub (L11): a member's manual login under SSO
  backend.on('PATCH', '/members/:userId/sso-settings', () => notImplemented('L11'));
  // stub (L11): SAML settings
  backend.on('GET', '/sso/saml/config', () => notImplemented('L11'));
  backend.on('POST', '/sso/saml/config', () => notImplemented('L11'));
  backend.on('POST', '/sso/saml/config/toggle', () => notImplemented('L11'));
  backend.on('POST', '/sso/saml/config/test', () => notImplemented('L11'));
  // stub (L11): OIDC settings
  backend.on('GET', '/sso/oidc/config', () => notImplemented('L11'));
  backend.on('POST', '/sso/oidc/config', () => notImplemented('L11'));
  backend.on('POST', '/sso/oidc/config/test', () => notImplemented('L11'));
}
