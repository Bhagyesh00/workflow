/**
 * P6-02: the demo's SCIM settings: the config, the deprovisioning choice, the token and the transfer
 * targets, with the server's rules and texts. SCIM turns on only while SAML or OIDC is the workspace's sign-in
 * (`setDemoSsoOptions`); a token is `wfs_scim_` and 43 characters, shown once; a new one replaces the old.
 * One state per workspace in `backend.ext.scim`.
 */
import type { ScimConfig, ScimTransferTarget } from '../api/types';
import type { MockBackend } from './mock-backend';
import { copy, HttpError } from './mock-http';
import { demoSsoOptions } from './mock-sso';

interface ScimState {
  enabled: boolean;
  /** the last four characters of the token; null: no token */
  tokenHint: string | null;
  onDelete: 'disable' | 'delete';
  dataAction: 'transfer' | 'delete';
  transferProjectId: string | null;
}

const BASE_URL = 'https://workflow.example.com/scim/v2';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function states(backend: MockBackend): Map<string, ScimState> {
  let map = backend.ext.scim as Map<string, ScimState> | undefined;
  if (!map) {
    map = new Map();
    backend.ext.scim = map;
  }
  return map;
}

function stateOf(backend: MockBackend, tenantId: string): ScimState {
  const map = states(backend);
  let state = map.get(tenantId);
  if (!state) {
    state = {
      enabled: false,
      tokenHint: null,
      onDelete: 'disable',
      dataAction: 'transfer',
      transferProjectId: null,
    };
    map.set(tenantId, state);
  }
  return state;
}

function configOf(state: ScimState): ScimConfig {
  return {
    enabled: state.enabled,
    hasToken: state.tokenHint !== null,
    tokenHint: state.tokenHint,
    baseUrl: BASE_URL,
    onDelete: state.onDelete,
    dataAction: state.dataAction,
    transferProjectId: state.transferProjectId,
  };
}

function randomChars(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => BASE64URL[b % 64]).join('');
}

/** team projects and the personal projects of active members, as the server lists them */
function targetsOf(backend: MockBackend, tenantId: string): ScimTransferTarget[] {
  const active = new Set(
    backend.memberships
      .filter((m) => m.tenantId === tenantId && m.status !== 'disabled')
      .map((m) => m.userId),
  );
  return backend.projects
    .filter((p) => p.tenantId === tenantId)
    .filter((p) => p.type === 'team' || (p.ownerUserId !== null && active.has(p.ownerUserId)))
    .map((p) => ({ id: p.id, name: p.name, type: p.type }));
}

export function registerScimRoutes(backend: MockBackend): void {
  backend.on('GET', '/scim/config', () => {
    const { tenant } = backend.requireScope('scim:manage');
    return configOf(stateOf(backend, tenant.id));
  });

  backend.on('PATCH', '/scim/config', ({ body }) => {
    const { tenant } = backend.requireScope('scim:manage');
    if (typeof body.enabled !== 'boolean')
      throw new HttpError(400, 'validation_error', 'Request validation failed');
    const method = demoSsoOptions(backend).method;
    if (body.enabled && method !== 'saml' && method !== 'oidc') {
      throw new HttpError(
        400,
        'bad_request',
        'Turn on SAML or OIDC single sign-on before you enable SCIM provisioning.',
      );
    }
    const state = stateOf(backend, tenant.id);
    state.enabled = body.enabled;
    return configOf(state);
  });

  backend.on('PUT', '/scim/deprovisioning', ({ body }) => {
    const { tenant } = backend.requireScope('scim:manage');
    const onDelete = body.onDelete;
    const dataAction = body.dataAction;
    if (
      (onDelete !== 'disable' && onDelete !== 'delete') ||
      (dataAction !== 'transfer' && dataAction !== 'delete')
    )
      throw new HttpError(400, 'validation_error', 'Request validation failed');
    let transferProjectId: string | null = null;
    if (dataAction === 'transfer' && typeof body.transferProjectId === 'string' && body.transferProjectId) {
      const project = backend.projects.find(
        (p) => p.tenantId === tenant.id && p.id === body.transferProjectId,
      );
      if (!project) throw new HttpError(404, 'not_found', 'Project not found');
      if (!targetsOf(backend, tenant.id).some((t) => t.id === project.id))
        throw new HttpError(
          400,
          'bad_request',
          'Pick a team project or the personal project of an active member.',
        );
      transferProjectId = project.id;
    }
    const state = stateOf(backend, tenant.id);
    state.onDelete = onDelete;
    state.dataAction = dataAction;
    state.transferProjectId = transferProjectId;
    return configOf(state);
  });

  backend.on('POST', '/scim/token', () => {
    const { tenant } = backend.requireScope('scim:manage');
    const token = `wfs_scim_${randomChars(43)}`;
    stateOf(backend, tenant.id).tokenHint = token.slice(-4);
    return { token, baseUrl: BASE_URL };
  });

  backend.on('DELETE', '/scim/token', () => {
    const { tenant } = backend.requireScope('scim:manage');
    stateOf(backend, tenant.id).tokenHint = null;
    return { ok: true as const };
  });

  backend.on('GET', '/scim/transfer-targets', () => {
    const { tenant } = backend.requireScope('scim:manage');
    return copy(targetsOf(backend, tenant.id));
  });
}
