/**
 * P6-11 (L9): role mapping rules. An expression is evaluated by `evaluateSimple`
 * (workflow/src/expression/expression.ts) with the claims as data (`$claims`), at most 2000 characters, dry
 * run at save; only `true` or `"true"` matches and an error counts as false. The first match per scope wins.
 * Nothing else is in scope of an expression: no node data, no credentials, no environment.
 */
import { type DataObject, evaluateSimple } from '@workflow/workflow';

/** the longest expression a rule may hold */
export const RULE_EXPRESSION_MAX_LENGTH = 2000;

/** one evaluation may take this long, then it is an error (false) */
const EVALUATION_TIMEOUT_MS = 250;

function run(expression: string, claims: DataObject): unknown {
  return evaluateSimple(expression, { $claims: claims }, { timeoutMs: EVALUATION_TIMEOUT_MS });
}

/** whether `expression` matches the claims (an error is false) */
export function ruleMatches(expression: string, claims: DataObject): boolean {
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > RULE_EXPRESSION_MAX_LENGTH) {
    return false;
  }
  try {
    const result = run(expression, claims);
    return result === true || result === 'true';
  } catch {
    return false;
  }
}

/** the save-time dry run: undefined when the expression evaluates, else the reason it does not */
export function ruleExpressionProblem(expression: string): string | undefined {
  if (typeof expression !== 'string' || expression.trim().length === 0) return 'The expression is empty.';
  if (expression.length > RULE_EXPRESSION_MAX_LENGTH) {
    return `The expression is longer than ${RULE_EXPRESSION_MAX_LENGTH} characters.`;
  }
  try {
    run(expression, {});
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // a syntax error never works; a failure on empty claims (a missing claim read) is how a rule
    // reads when a claim is absent, and that sign-in simply does not match
    if (/invalid syntax/i.test(message)) return message.slice(0, 200);
    return undefined;
  }
}
