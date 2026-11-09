/**
 * P5-67, P5-71: who sees the Assistant link. n8n's rule (useInstanceAiAvailability) with a model in place of
 * its setup step: the Assistant must be on for the workspace, and then a member sees the link once a model is
 * set, while one who manages the Assistant (`instanceAi:manage`: owner and admin) sees it before, so they can
 * reach the setup wizard on the page. P6 S1 (C0): reads the me's global scopes instead of the role word.
 */
import type { AssistantFeature, Me } from '../api/types';
import { canWith } from './permissions';

export function assistantLinkVisible(
  features: AssistantFeature,
  me: Pick<Me, 'globalScopes'> | null | undefined,
): boolean {
  if (!features.enabled) return false;
  return features.modelSet || canWith(me, 'instanceAi:manage');
}
