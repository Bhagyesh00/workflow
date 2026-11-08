/**
 * The Assistant's chat model (P5-67, lane L1): `TenantSettings.assistant`'s credential, node type and
 * model id through `loadModelFromSetting` (C0e, services/ai-builder/model.ts), so `AI_ENABLED` does not
 * gate it.
 */
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import { type BuilderModel, BuilderModelError, loadModelFromSetting } from '../ai-builder/model';
import type { EffectiveAssistantSettings } from './types';

/** the chat's refusal while no model is set for the workspace */
export const ASSISTANT_NO_MODEL = 'Set a model in Settings first';

/** the model and its `close` (run in the turn's `finally`); refuses with a readable text when none is set */
export async function loadAssistantModel(
  ctx: ServerContext,
  tenant: TenantRow,
  settings: EffectiveAssistantSettings,
  signal: AbortSignal,
): Promise<BuilderModel> {
  if (!settings.model) throw new BuilderModelError(ASSISTANT_NO_MODEL);
  return loadModelFromSetting(ctx, tenant, settings.model, signal);
}
