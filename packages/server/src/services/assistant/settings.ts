/**
 * The Assistant's workspace settings (P5-71). `read` and `assistantFeature` are FULL from C0: the gate
 * of every Assistant route and the `features.assistant` flag read them. `dto` and `patch` are stubs that
 * lane L8 writes (routes/assistant-settings.ts, admin only).
 */
import type { NodeTypeRegistry } from '@workflow/core';
import { type AssistantSettingsDTO, resolveAssistantPermissions } from '@workflow/workflow';
import type { Config } from '../../config';
import type { ServiceDeps } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { AuthContext } from '../../http/auth';
import type { TenantSettings } from '../../plans';
import { isBuilderModelNode } from '../ai-builder/model';
import type { Actor } from '../workflows';
import type { EffectiveAssistantSettings } from './types';

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

export class AssistantSettingsService {
  constructor(readonly deps: ServiceDeps) {}

  /** FULL: the effective settings of `tenant` (its saved settings as loaded with the row) */
  async read(tenant: TenantRow): Promise<EffectiveAssistantSettings> {
    return effectiveAssistantSettings(this.deps.config, tenant.settings as TenantSettings);
  }

  /** the settings page's view (admins only; credential ids shown) */
  async dto(_tenant: TenantRow): Promise<AssistantSettingsDTO> {
    throw new Error('not implemented (L8)');
  }

  /** checks and saves a change (audit `tenant.settings_updated`), then the new view */
  async patch(
    _auth: AuthContext,
    _patch: AssistantSettingsPatch,
    _actor?: Actor,
  ): Promise<AssistantSettingsDTO> {
    throw new Error('not implemented (L8)');
  }
}
