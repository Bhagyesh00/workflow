/**
 * P6-51 (L6): the decision of a type in a project: the workspace's AND the project's. A project can only
 * restrict; a workspace `delegate` is met only by an explicit project `allow` rule (`matchedRuleId` set),
 * never by the project's default; a project denial says `scope: 'project'` and never names the project.
 * `project` undefined: the project has no scope (the workspace decides; `delegate` then denies).
 * Stub from C0: PASSES, returns the workspace's decision unchanged, until L6.
 */
import type { TypeDecision } from './types';

export function composeDecisions(tenant: TypeDecision, _project?: TypeDecision): TypeDecision {
  // stub (L6): PASSES, the workspace decides
  return tenant;
}
