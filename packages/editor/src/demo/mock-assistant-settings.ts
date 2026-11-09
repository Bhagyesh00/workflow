/**
 * Demo Assistant settings (P5-71, lane L8): GET and PATCH `/assistant/settings` (`assistantApi.settings`,
 * `patchSettings`) on the in-memory MockBackend, an admin's page. The state is kept per workspace and per
 * backend; it starts from `options.assistant`, and every PATCH writes `options.assistant` back so
 * `features.assistant` of GET /settings follows (the link and the page's no-model state).
 */
import {
  ASSISTANT_ALWAYS_ALLOW_KEYS,
  ASSISTANT_PERMISSION_KEYS,
  ASSISTANT_PERMISSION_MODES,
  isAssistantPermissionKey,
  resolveAssistantPermissions,
} from '@workflow/workflow';
import type { AssistantPermissionMode, AssistantSettingsDTO } from '../api/types';
import { HttpError, type MockBackend } from './mock-backend';

const SEARCH_TYPES = ['braveSearchApi', 'searXngApi'];

const states = new WeakMap<MockBackend, Map<string, AssistantSettingsDTO>>();

function stateOf(backend: MockBackend, tenantId: string): AssistantSettingsDTO {
  let byTenant = states.get(backend);
  if (!byTenant) {
    byTenant = new Map();
    states.set(backend, byTenant);
  }
  let state = byTenant.get(tenantId);
  if (!state) {
    const feature = backend.options.assistant ?? { enabled: true, modelSet: true };
    const credential = backend.credentials.find((c) => c.tenantId === tenantId);
    state = {
      enabled: feature.enabled,
      credentialId: feature.modelSet ? (credential?.id ?? null) : null,
      nodeType: feature.modelSet ? 'ai.lmChatDemo' : null,
      model: feature.modelSet ? 'fast' : null,
      modelSet: feature.modelSet,
      searchCredentialId: null,
      searchDisabled: false,
      mcpAccessEnabled: false,
      permissions: resolveAssistantPermissions(null),
      allowSendingParameterValues: true,
      instanceAllowsSendingParameterValues: true,
    };
    byTenant.set(tenantId, state);
  }
  return state;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** P5-71: registers the demo Assistant settings routes (L8). */
export function registerAssistantSettingsRoutes(backend: MockBackend): void {
  backend.on('GET', '/assistant/settings', () => {
    const { tenant } = backend.requireScope('instanceAi:manage');
    return structuredClone(stateOf(backend, tenant.id));
  });

  backend.on('PATCH', '/assistant/settings', ({ body }) => {
    const { tenant } = backend.requireScope('instanceAi:manage');
    const state = stateOf(backend, tenant.id);
    const next = structuredClone(state);
    const credentialOf = (id: string) =>
      backend.credentials.find((c) => c.id === id && c.tenantId === tenant.id);

    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.allowSendingParameterValues === 'boolean') {
      next.allowSendingParameterValues = body.allowSendingParameterValues;
    }
    if (typeof body.mcpAccessEnabled === 'boolean') next.mcpAccessEnabled = body.mcpAccessEnabled;

    for (const key of ['credentialId', 'nodeType', 'model'] as const) {
      const value = body[key];
      if (value === null) next[key] = null;
      else if (isString(value)) next[key] = key === 'model' ? value.trim() : value;
    }
    if (isString(body.nodeType) && !body.nodeType.startsWith('ai.lmChat')) {
      throw new HttpError(400, 'bad_request', `"${body.nodeType}" is not a chat model node type`);
    }
    if (isString(body.credentialId) && !credentialOf(body.credentialId)) {
      throw new HttpError(400, 'bad_request', 'The AI credential was not found in this workspace');
    }
    if ('credentialId' in body || 'nodeType' in body || 'model' in body) {
      next.modelSet = Boolean(next.credentialId && next.nodeType && next.model);
    }

    if (body.searchCredentialId === null) next.searchCredentialId = null;
    else if (isString(body.searchCredentialId)) {
      const credential = credentialOf(body.searchCredentialId);
      if (!credential) {
        throw new HttpError(400, 'bad_request', 'The search credential was not found in this workspace');
      }
      if (!SEARCH_TYPES.includes(credential.type)) {
        throw new HttpError(
          400,
          'bad_request',
          'The search credential must be a Brave Search or SearXNG credential',
        );
      }
      next.searchCredentialId = credential.id;
      next.searchDisabled = false;
    }
    if (typeof body.searchDisabled === 'boolean') {
      next.searchDisabled = body.searchDisabled;
      if (body.searchDisabled) next.searchCredentialId = null;
    }

    if (body.permissions && typeof body.permissions === 'object') {
      for (const [key, mode] of Object.entries(body.permissions as Record<string, unknown>)) {
        if (!isAssistantPermissionKey(key) || !ASSISTANT_PERMISSION_KEYS.includes(key)) {
          throw new HttpError(400, 'bad_request', `"${key}" is not a permission`);
        }
        if (!ASSISTANT_PERMISSION_MODES.includes(mode as AssistantPermissionMode)) {
          throw new HttpError(400, 'bad_request', `"${String(mode)}" is not a permission mode`);
        }
        if (mode === 'always_allow' && !ASSISTANT_ALWAYS_ALLOW_KEYS.includes(key)) {
          throw new HttpError(400, 'bad_request', `"${key}" always needs approval`);
        }
        next.permissions[key] = mode as AssistantPermissionMode;
      }
    }

    const byTenant = states.get(backend);
    byTenant?.set(tenant.id, next);
    backend.options.assistant = { enabled: next.enabled, modelSet: next.modelSet };
    return structuredClone(next);
  });
}
