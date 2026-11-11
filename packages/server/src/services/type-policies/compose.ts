/**
 * P6-51 (L6): the decision of a type in a project: the workspace's AND the project's. A project can only
 * restrict; a workspace `delegate` is met only by an explicit project `allow` rule (`matchedRuleId` set),
 * never by the project's default; a project denial says `scope: 'project'` and never names the project.
 * `project` undefined: the project has no scope (the workspace decides; `delegate` then denies).
 * The answer's action is `allow` or `deny`, never `delegate`.
 */
import type { TypeDecision } from './types';

export function composeDecisions(tenant: TypeDecision, project?: TypeDecision): TypeDecision {
  if (tenant.action === 'deny') return { ...tenant, action: 'deny', optInAvailable: false };
  if (tenant.action === 'allow') {
    // a project can only restrict
    if (project && project.action !== 'allow') {
      return {
        action: 'deny',
        matchedRuleId: project.matchedRuleId,
        scope: 'project',
        optInAvailable: false,
      };
    }
    return tenant;
  }
  // the workspace delegates the type: only an explicit project allow rule opts in
  if (project) {
    if (project.action === 'allow' && project.matchedRuleId !== null) {
      return {
        action: 'allow',
        matchedRuleId: project.matchedRuleId,
        scope: 'project',
        optInAvailable: false,
      };
    }
    if (project.action === 'deny' && project.matchedRuleId !== null) {
      return {
        action: 'deny',
        matchedRuleId: project.matchedRuleId,
        scope: 'project',
        optInAvailable: false,
      };
    }
  }
  return { action: 'deny', matchedRuleId: tenant.matchedRuleId, scope: 'workspace', optInAvailable: true };
}
