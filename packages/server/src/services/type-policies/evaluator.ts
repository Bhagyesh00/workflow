/**
 * P6-48 (L1): the pure evaluator of one scope for one type. Floors first (priority ascending), then normal
 * attachments, rules flattened, first match wins, else the scope's default. `name` matches the type or its
 * base (`facts.baseName`, tool variants); `package` matches `facts.packageName`; `extends` (credential kind
 * only) matches the type or one of `facts.ancestors`.
 */
import type { PolicyAction, PolicyDocument, PolicyRule, PolicyScope, TypeDecision, TypeFacts } from './types';

/** the facts of one type plus the tenant's documents the scope's attachments name (`snapshot.policies`) */
export interface EvaluationFacts extends TypeFacts {
  policies: ReadonlyMap<string, PolicyDocument>;
}

/** does one rule's selector match the type; a selector with no field, or a field of the wrong kind, matches nothing */
function matches(rule: PolicyRule, scope: PolicyScope, type: string, facts: EvaluationFacts): boolean {
  const { name, package: packageName, extends: extended } = rule.selector;
  if (name !== undefined) return name === type || (facts.baseName !== undefined && name === facts.baseName);
  if (packageName !== undefined) return facts.packageName !== undefined && packageName === facts.packageName;
  if (extended !== undefined) {
    // `extends` is a credential selector: a node scope never matches it
    if (scope.kind !== 'credential') return false;
    return extended === type || (facts.ancestors ?? []).includes(extended);
  }
  return false;
}

/** the attachments in judging order: floors by priority, then the normal ones by priority */
function judgingOrder(scope: PolicyScope) {
  const byPriority = (a: { priority: number }, b: { priority: number }) => a.priority - b.priority;
  const floors = scope.attachments.filter((a) => a.isFloor).sort(byPriority);
  const normal = scope.attachments.filter((a) => !a.isFloor).sort(byPriority);
  return [...floors, ...normal];
}

export function evaluateScope(scope: PolicyScope, type: string, facts: EvaluationFacts): TypeDecision {
  const where = scope.projectId === null ? 'workspace' : 'project';
  // a project scope never delegates (the database and the store refuse it); one that did would deny
  const decide = (action: PolicyAction, matchedRuleId: string | null): TypeDecision => {
    const effective = where === 'project' && action === 'delegate' ? 'deny' : action;
    return { action: effective, matchedRuleId, scope: where, optInAvailable: effective === 'delegate' };
  };
  for (const attachment of judgingOrder(scope)) {
    const document = facts.policies.get(attachment.policyId);
    if (!document || document.kind !== scope.kind) continue;
    for (const rule of document.rules) {
      if (matches(rule, scope, type, facts)) return decide(rule.action, rule.id);
    }
  }
  return decide(scope.defaultAction, null);
}
