/**
 * P5-67, P5-71: who sees the Assistant link. n8n's rule (useInstanceAiAvailability) with a model in place of
 * its setup step: the Assistant must be on for the workspace, and then a member sees the link once a model is
 * set, while an owner or admin sees it before, so they can reach the setup wizard on the page.
 */
import type { AssistantFeature, Role } from '../api/types';

export function assistantLinkVisible(features: AssistantFeature, role: Role | null | undefined): boolean {
  if (!features.enabled) return false;
  return features.modelSet || role === 'owner' || role === 'admin';
}
