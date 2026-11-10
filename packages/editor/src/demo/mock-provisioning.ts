/**
 * P6-11 (C0): the demo's role provisioning. `GET /sso/provisioning/config` is FULL here (`provisioning:manage`, as
 * the server's), because L11's Invite tooltip reads it before L9 builds the rest: it answers what
 * `MockBackend.setDemoProvisioning` set, else provisioning off. Saving the config and the role mapping rules answer
 * 501 until L9 fills them. L9 owns this file after C0.
 */
import type { ProvisioningConfig } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, notImplemented } from './mock-http';

/** provisioning off: no role comes from the identity provider (our claim names, not n8n's) */
export const DEMO_PROVISIONING_OFF: ProvisioningConfig = {
  scopesProvisionInstanceRole: false,
  scopesProvisionProjectRoles: false,
  scopesUseExpressionMapping: false,
  scopesName: 'workflow',
  scopesInstanceRoleClaimName: 'instance_role',
  scopesProjectsRolesClaimName: 'projects',
};

interface ProvisioningState {
  /** what `setDemoProvisioning` set (null: provisioning off) */
  config: ProvisioningConfig | null;
}

function state(backend: MockBackend): ProvisioningState {
  let s = backend.ext.provisioning as ProvisioningState | undefined;
  if (!s) {
    s = { config: null };
    backend.ext.provisioning = s;
  }
  return s;
}

/** the provisioning config of the demo, as `GET /sso/provisioning/config` answers it */
export function demoProvisioningConfig(backend: MockBackend): ProvisioningConfig {
  return copy(state(backend).config ?? DEMO_PROVISIONING_OFF);
}

/** tests and demo (`MockBackend.setDemoProvisioning`): the provisioning config; null turns it off */
export function setDemoProvisioningConfig(backend: MockBackend, config: ProvisioningConfig | null): void {
  state(backend).config = config ? copy(config) : null;
}

export function registerProvisioningRoutes(backend: MockBackend): void {
  backend.on('GET', '/sso/provisioning/config', () => {
    backend.requireScope('provisioning:manage');
    return demoProvisioningConfig(backend);
  });
  // stub (L9): save the config
  backend.on('PATCH', '/sso/provisioning/config', () => notImplemented('L9'));
  // stub (L9): role mapping rules
  backend.on('GET', '/sso/role-mapping-rules', () => notImplemented('L9'));
  backend.on('POST', '/sso/role-mapping-rules', () => notImplemented('L9'));
  backend.on('POST', '/sso/role-mapping-rules/:id/move', () => notImplemented('L9'));
  backend.on('PATCH', '/sso/role-mapping-rules/:id', () => notImplemented('L9'));
  backend.on('DELETE', '/sso/role-mapping-rules/:id', () => notImplemented('L9'));
}
