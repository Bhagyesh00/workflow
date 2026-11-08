/**
 * The Assistant's chat model (P5-67, lane L1): `TenantSettings.assistant`'s credential, node type and
 * model id through `loadModelFromSetting` (C0e, services/ai-builder/model.ts), so `AI_ENABLED` does not
 * gate it. C0 stub with the final signature.
 */
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import type { BuilderModel } from '../ai-builder/model';
import type { EffectiveAssistantSettings } from './types';

/** the model and its `close` (run in the turn's `finally`); refuses with a readable text when none is set */
export async function loadAssistantModel(
  _ctx: ServerContext,
  _tenant: TenantRow,
  _settings: EffectiveAssistantSettings,
  _signal: AbortSignal,
): Promise<BuilderModel> {
  throw new Error('not implemented (L1)');
}
