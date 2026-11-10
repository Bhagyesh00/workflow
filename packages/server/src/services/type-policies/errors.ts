/**
 * P6-04: the errors of the type availability policies. FULL in C0: no lane changes this file.
 * - `PolicyViolationError`: 403, code `policy_violation`, `details: { violations }`; the message names the
 *   blocked types (n8n's texts, "instance" said as "workspace"); a project denial never names the project.
 * - `PolicyCheckFailedError`: 503, code `policy_check_failed`: a check that failed or missed its deadline
 *   blocks (fail closed), never passes.
 */
import { ApiError } from '../../http/errors';
import type { EnforcementPoint, TypePolicyViolation } from './types';

/** one violation's text */
function oneMessage(v: TypePolicyViolation): string {
  const what = v.kind === 'credential-type-unavailable' ? 'Credential type' : 'Node type';
  const scope = v.scope === 'project' ? 'project' : 'workspace';
  return `${what} "${v.type}" is blocked by a ${scope} policy`;
}

/**
 * `Node type "<t>" is blocked by a workspace policy` (or `by a project policy`), `Credential type "<t>" is
 * blocked by ...`; several: `Blocked by policy: a; b`
 */
export function violationMessage(violations: readonly TypePolicyViolation[]): string {
  if (violations.length === 0) return 'Blocked by policy';
  if (violations.length === 1) return oneMessage(violations[0]);
  return `Blocked by policy: ${violations.map(oneMessage).join('; ')}`;
}

export class PolicyViolationError extends ApiError {
  constructor(readonly violations: TypePolicyViolation[]) {
    super(403, 'policy_violation', violationMessage(violations), { violations });
    this.name = 'PolicyViolationError';
  }
}

export class PolicyCheckFailedError extends ApiError {
  constructor(
    readonly point: EnforcementPoint,
    /** the cause, for the log only (never sent) */
    readonly reason?: unknown,
  ) {
    super(503, 'policy_check_failed', `Could not verify policy for ${point}, so the action was blocked`);
    this.name = 'PolicyCheckFailedError';
  }
}
