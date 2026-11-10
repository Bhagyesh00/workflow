/**
 * P6-48 (L1): the pure evaluator of one scope for one type. Floors first (priority ascending), then normal
 * attachments, rules flattened, first match wins, else the scope's default. `name` matches the type or its
 * base (`facts.baseName`, tool variants); `package` matches `facts.packageName`; `extends` (credential kind
 * only) matches the type or one of `facts.ancestors`.
 * Stub from C0; L1 fills it.
 */
import type { PolicyDocument, PolicyScope, TypeDecision, TypeFacts } from './types';

/** the facts of one type plus the tenant's documents the scope's attachments name (`snapshot.policies`) */
export interface EvaluationFacts extends TypeFacts {
  policies: ReadonlyMap<string, PolicyDocument>;
}

export function evaluateScope(_scope: PolicyScope, _type: string, _facts: EvaluationFacts): TypeDecision {
  // stub (L1)
  throw new Error('not implemented (L1)');
}
