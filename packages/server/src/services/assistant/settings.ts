/**
 * The Assistant's workspace settings (P5-71). `read` and `assistantFeature` are FULL from C0: the gate
 * of every Assistant route and the `features.assistant` flag read them. `dto` and `patch` are stubs that
 * lane L8 writes (routes/assistant-settings.ts, admin only).
 */
import type { NodeTypeRegistry } from '@workflow/core';
import {
  ASSISTANT_ALWAYS_ALLOW_KEYS,
  ASSISTANT_PERMISSION_MODES,
  type AssistantPermissionKey,
  type AssistantPermissionMode,
  type AssistantSettingsDTO,
  isAssistantPermissionKey,
  resolveAssistantPermissions,
} from '@workflow/workflow';
import type { Config } from '../../config';
import type { ServiceDeps } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import { ApiError } from '../../http/errors';
import type { TenantSettings } from '../../plans';
import { CREDENTIAL_MISMATCH, credentialFitsModel, isBuilderModelNode } from '../ai-builder/model';
import { assertCredentialsUsable } from '../credential-usable';
import { isProtected, type ProtectedAction } from '../protected';
import type { Actor } from '../workflows';
import type { EffectiveAssistantSettings } from './types';

/** the credential types a web search key can be */
const SEARCH_CREDENTIAL_TYPES = ['braveSearchApi', 'searXngApi'];

/** the saved `TenantSettings.assistant` */
export type AssistantTenantSettings = NonNullable<TenantSettings['assistant']>;

/** a PATCH body as L8's schema gives it: each field optional, null clears a field that can be cleared */
export type AssistantSettingsPatch = {
  [K in keyof AssistantTenantSettings]?: AssistantTenantSettings[K] | null;
};

function tenantAssistant(settings: TenantSettings | null | undefined): AssistantTenantSettings {
  const value = settings?.assistant;
  return value && typeof value === 'object' ? value : {};
}

/** on unless the workspace turned it off; with no saved choice `INSTANCE_AI_ENABLED`, then on */
function isEnabled(config: Config, saved: AssistantTenantSettings): boolean {
  if (typeof saved.enabled === 'boolean') return saved.enabled;
  return config.assistant.enabled ?? true;
}

/** the model the admin chose, or null while any of the three parts is missing */
function modelOf(saved: AssistantTenantSettings): EffectiveAssistantSettings['model'] {
  const { credentialId, nodeType, model } = saved;
  if (typeof credentialId !== 'string' || !credentialId) return null;
  if (typeof nodeType !== 'string' || !nodeType) return null;
  if (typeof model !== 'string' || !model.trim()) return null;
  return { credentialId, nodeType, model };
}

/** the settings a turn and a route use, from the config and the tenant's saved settings (no plan rule) */
export function effectiveAssistantSettings(
  config: Config,
  settings: TenantSettings | null | undefined,
): EffectiveAssistantSettings {
  const saved = tenantAssistant(settings);
  const model = modelOf(saved);
  const instanceAllows = config.ai.allowSendingParameterValues;
  const allowSending = saved.allowSendingParameterValues ?? true;
  return {
    enabled: isEnabled(config, saved),
    model,
    modelSet: model !== null,
    searchCredentialId: typeof saved.searchCredentialId === 'string' ? saved.searchCredentialId : null,
    searchDisabled: saved.searchDisabled === true,
    mcpAccessEnabled: saved.mcpAccessEnabled === true,
    permissions: resolveAssistantPermissions(saved.permissions ?? null),
    allowSendingParameterValues: allowSending,
    instanceAllowsSendingParameterValues: instanceAllows,
    sendValues: instanceAllows && allowSending,
  };
}

/**
 * `features.assistant` of GET /rest/settings: whether the Assistant is on for this workspace and a model
 * is set (a chat model node that exists here). Never a credential id.
 */
export function assistantFeature(
  config: Config,
  settings: TenantSettings | null | undefined,
  nodeTypes: NodeTypeRegistry,
): { enabled: boolean; modelSet: boolean } {
  const saved = tenantAssistant(settings);
  const model = modelOf(saved);
  return {
    enabled: isEnabled(config, saved),
    modelSet: model !== null && isBuilderModelNode(nodeTypes, model.nodeType),
  };
}

/**
 * The permission keys whose action the server refuses on a protected workspace, with the refusal each one
 * carries. Publish, credential delete, table row writes, test run cleanup, fetch, web search and MCP read
 * stay allowed (as in n8n).
 */
export const PROTECTED_PERMISSION_ACTIONS: Partial<Record<AssistantPermissionKey, ProtectedAction>> = {
  createWorkflow: 'workflowCreate',
  updateWorkflow: 'workflowUpdate',
  deleteWorkflow: 'workflowArchive',
  moveWorkflowToFolder: 'workflowUpdate',
  runWorkflow: 'manualRun',
  executeNode: 'manualRun',
  createCredential: 'credentialCreate',
  createFolder: 'folderCreate',
  deleteFolder: 'folderDelete',
  tagWorkflow: 'workflowUpdate',
  createDataTable: 'dataTableCreate',
  deleteDataTable: 'dataTableStructure',
  mutateDataTableSchema: 'dataTableStructure',
  restoreWorkflowVersion: 'workflowRestore',
  mcpWrite: 'workflowUpdate',
};

/** the refusal for a tool permission key on a protected workspace, or null when the key stays allowed */
export function protectedActionFor(
  settings: TenantSettings | null | undefined,
  key: AssistantPermissionKey,
): ProtectedAction | null {
  return isProtected(settings) ? (PROTECTED_PERMISSION_ACTIONS[key] ?? null) : null;
}

export class AssistantSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /**
   * The effective settings of `tenant` (its saved settings as loaded with the row). On a protected workspace
   * every key whose action the server refuses reads `blocked`, so a turn does not offer the tool and `gate`
   * refuses it before any approval card.
   */
  async read(tenant: TenantRow): Promise<EffectiveAssistantSettings> {
    const settings = tenant.settings as TenantSettings;
    const effective = effectiveAssistantSettings(this.deps.config, settings);
    if (!isProtected(settings)) return effective;
    const permissions = { ...effective.permissions };
    for (const key of Object.keys(PROTECTED_PERMISSION_ACTIONS) as AssistantPermissionKey[]) {
      permissions[key] = 'blocked';
    }
    return { ...effective, permissions };
  }

  /** the settings page's view (admins only; credential ids shown) */
  async dto(tenant: TenantRow): Promise<AssistantSettingsDTO> {
    const saved = tenantAssistant(tenant.settings as TenantSettings);
    const effective = effectiveAssistantSettings(this.deps.config, tenant.settings as TenantSettings);
    return {
      enabled: effective.enabled,
      credentialId: typeof saved.credentialId === 'string' && saved.credentialId ? saved.credentialId : null,
      nodeType: typeof saved.nodeType === 'string' && saved.nodeType ? saved.nodeType : null,
      model: typeof saved.model === 'string' && saved.model.trim() ? saved.model : null,
      modelSet: effective.modelSet,
      searchCredentialId: effective.searchCredentialId,
      searchDisabled: effective.searchDisabled,
      mcpAccessEnabled: effective.mcpAccessEnabled,
      // the saved modes: the protected block is shown by `read`, not here
      permissions: effective.permissions,
      allowSendingParameterValues: effective.allowSendingParameterValues,
      instanceAllowsSendingParameterValues: effective.instanceAllowsSendingParameterValues,
    };
  }

  /**
   * The credential an admin pins for the whole workspace (the model, the search key) must be one the
   * admin can use (`assertCredentialsUsable` in the admin's own project). Members' turns then use it
   * through the server's allow list, in whatever project they work.
   */
  private async assertAdminUsable(
    auth: AuthContext,
    credential: { id: string; name: string; type: string },
  ): Promise<void> {
    const ctx = this.deps.context();
    await assertCredentialsUsable(ctx, auth.tenant.id, await ctx.access.targetProject(auth), {
      name: 'Assistant settings',
      nodes: [
        {
          id: 'assistant-settings',
          name: 'Assistant settings',
          type: 'assistant.settings',
          typeVersion: 1,
          position: [0, 0],
          parameters: {},
          credentials: { [credential.type]: { id: credential.id, name: credential.name } },
        },
      ],
      connections: {},
    });
  }

  /** checks and saves a change (audit `tenant.settings_updated`), then the new view */
  async patch(
    auth: AuthContext,
    patch: AssistantSettingsPatch,
    actor?: Actor,
  ): Promise<AssistantSettingsDTO> {
    const { repos } = this.deps;
    const ctx = this.deps.context();
    const tenantId = auth.tenant.id;
    const tenant = (await repos.tenants.get(tenantId)) ?? auth.tenant;
    const settings = (tenant.settings ?? {}) as TenantSettings;
    const next: AssistantTenantSettings = { ...tenantAssistant(settings) };
    const changed: string[] = [];

    if (patch.enabled !== undefined && patch.enabled !== null) {
      next.enabled = patch.enabled;
      changed.push('enabled');
    }

    // the model: the three parts are checked together, as PATCH /settings checks `ai`
    if (patch.credentialId !== undefined || patch.nodeType !== undefined || patch.model !== undefined) {
      if (patch.nodeType === null) delete next.nodeType;
      else if (patch.nodeType !== undefined) next.nodeType = patch.nodeType;
      if (patch.credentialId === null) delete next.credentialId;
      else if (patch.credentialId !== undefined) next.credentialId = patch.credentialId;
      if (patch.model === null) delete next.model;
      else if (patch.model !== undefined) next.model = patch.model.trim();
      if (next.model !== undefined && !next.model) delete next.model;
      if (next.nodeType && !isBuilderModelNode(ctx.registries.nodeTypes, next.nodeType)) {
        throw ApiError.badRequest(`"${next.nodeType}" is not a chat model node type`);
      }
      if (next.credentialId) {
        const credential = await repos.credentials.get(tenantId, next.credentialId);
        if (!credential) throw ApiError.badRequest('The AI credential was not found in this workspace');
        if (next.nodeType && !credentialFitsModel(ctx, next.nodeType, credential.type)) {
          throw ApiError.badRequest(CREDENTIAL_MISMATCH);
        }
        // the admin who saves it must be able to use it; every project's turn then uses it (workspace-wide)
        if (patch.credentialId) await this.assertAdminUsable(auth, credential);
      }
      changed.push('model');
    }

    // web search: a key of this workspace, or switched off
    if (patch.searchCredentialId && patch.searchDisabled === true) {
      throw ApiError.badRequest('Choose a search key or turn search off, not both');
    }
    if (patch.searchCredentialId !== undefined) {
      if (patch.searchCredentialId === null) {
        next.searchCredentialId = null;
      } else {
        const credential = await repos.credentials.get(tenantId, patch.searchCredentialId);
        if (!credential) throw ApiError.badRequest('The search credential was not found in this workspace');
        if (!SEARCH_CREDENTIAL_TYPES.includes(credential.type)) {
          throw ApiError.badRequest('The search credential must be a Brave Search or SearXNG credential');
        }
        await this.assertAdminUsable(auth, credential);
        next.searchCredentialId = patch.searchCredentialId;
        next.searchDisabled = false;
      }
      changed.push('search');
    }
    if (patch.searchDisabled !== undefined && patch.searchDisabled !== null) {
      next.searchDisabled = patch.searchDisabled;
      if (patch.searchDisabled) next.searchCredentialId = null;
      if (!changed.includes('search')) changed.push('search');
    }

    if (patch.mcpAccessEnabled !== undefined && patch.mcpAccessEnabled !== null) {
      next.mcpAccessEnabled = patch.mcpAccessEnabled;
      changed.push('mcpAccessEnabled');
    }
    if (patch.allowSendingParameterValues !== undefined && patch.allowSendingParameterValues !== null) {
      next.allowSendingParameterValues = patch.allowSendingParameterValues;
      changed.push('allowSendingParameterValues');
    }

    if (patch.permissions) {
      const permissions: Record<string, AssistantPermissionMode> = { ...(next.permissions ?? {}) };
      for (const [key, mode] of Object.entries(patch.permissions)) {
        if (!isAssistantPermissionKey(key)) throw ApiError.badRequest(`"${key}" is not a permission`);
        if (mode === undefined) continue;
        if (!ASSISTANT_PERMISSION_MODES.includes(mode)) {
          throw ApiError.badRequest(`"${String(mode)}" is not a permission mode`);
        }
        if (mode === 'always_allow' && !ASSISTANT_ALWAYS_ALLOW_KEYS.includes(key)) {
          throw ApiError.badRequest(`"${key}" always needs approval and can't be set to always allow`);
        }
        permissions[key] = mode;
      }
      next.permissions = permissions;
      changed.push('permissions');
    }

    // P6-78: only the `assistant` key, merged
    const saved = await repos.tenants.mergeSettings(tenantId, { assistant: next });
    await repos.audit.add(tenantId, {
      userId: auth.user.id,
      action: 'tenant.settings_updated',
      resourceType: 'tenant',
      resourceId: tenantId,
      ip: actor?.ip,
      metadata: { area: 'assistant', changed },
    });
    return this.dto(saved ?? { ...tenant, settings: { ...settings, assistant: next } });
  }
}
