/**
 * P6-11 (L9): role mapping rules. An expression is evaluated by `evaluateSimple`
 * (workflow/src/expression/expression.ts) with the claims as data, at most 2000 characters, dry run at
 * save; only `true` or `"true"` matches and an error counts as false. The first match per scope wins.
 * Stub from C0: throws until L9.
 */
import type { DataObject } from '@workflow/workflow';

/** the longest expression a rule may hold */
export const RULE_EXPRESSION_MAX_LENGTH = 2000;

/** whether `expression` matches the claims (an error is false) */
export function ruleMatches(_expression: string, _claims: DataObject): boolean {
  throw new Error('not implemented (L9)');
}

/** the save-time dry run: undefined when the expression evaluates, else the reason it does not */
export function ruleExpressionProblem(_expression: string): string | undefined {
  throw new Error('not implemented (L9)');
}
