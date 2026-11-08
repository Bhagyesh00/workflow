/**
 * Which nodes of a draft `verify_workflow` runs and which it pins with a fixture (P5-70, lane L7). It
 * fails closed: only data-only nodes of `VERIFY_RUN_ALLOW_LIST` run, and only when they hold no
 * credential and no parameter at any depth names `$vars`, `$secrets`, `$credentials`, `$env` or uses
 * `this`; every other node, every trigger and every credentialed node is simulated.
 *
 * The rule is an allow list of node types. The expression check reads the text of every expression
 * (a string that starts with `=`, or holds `{{`), so a name built at run time (`this['$va' + 'rs']`)
 * still counts: `$vars` is live in an expression, and a run's output reaches the model with no person
 * in between. A node type the registry does not know, a disabled flag, or a parameter tree too deep to
 * read is never a reason to run: such a node is simulated.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { WorkflowDefinition, WorkflowNode } from '@workflow/workflow';

/** the node types verify may run for real (data only, no outside call) */
export const VERIFY_RUN_ALLOW_LIST: readonly string[] = [
  'core.manualTrigger',
  'core.noOp',
  'core.set',
  'core.if',
  'core.switch',
  'core.filter',
  'core.merge',
  'core.sort',
  'core.limit',
  'core.removeDuplicates',
  'core.aggregate',
  'core.splitOut',
  'core.summarize',
  'core.renameKeys',
  'core.compareDatasets',
  'core.splitInBatches',
  'core.dateTime',
];

const ALLOWED = new Set(VERIFY_RUN_ALLOW_LIST);

/**
 * What in an expression's text makes its node simulated: the four secret-holding roots, `this` (any
 * case, so `globalThis` too), and the escapes and prototype names that could spell a root without
 * writing it (expressions run in our own interpreter, which has no native code path).
 */
const RISKY_EXPRESSION = /\$vars|\$secrets|\$credentials|\$env|this|\\u|\\x|constructor|__proto__|prototype/i;

/** deeper than this, a parameter tree is not read: the node is simulated */
const MAX_DEPTH = 64;

/** true when `value` holds an expression a run would evaluate with a risky name in it, or is too deep to read */
export function hasRiskyExpression(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') {
    const isExpression = value.startsWith('=') || value.includes('{{');
    return isExpression && RISKY_EXPRESSION.test(value);
  }
  if (Array.isArray(value)) return value.some((entry) => hasRiskyExpression(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      hasRiskyExpression(entry, depth + 1),
    );
  }
  return false;
}

function hasCredentials(node: WorkflowNode): boolean {
  const credentials = node.credentials as unknown;
  if (credentials === undefined || credentials === null) return false;
  if (typeof credentials !== 'object' || Array.isArray(credentials)) return true;
  return Object.keys(credentials).length > 0;
}

/** whether verify may run `node` for real */
function mayRun(node: WorkflowNode, nodeTypes: NodeTypeRegistry): boolean {
  if (!node || typeof node.type !== 'string' || !ALLOWED.has(node.type)) return false;
  if (!nodeTypes.get(node.type)) return false;
  if (hasCredentials(node)) return false;
  return !hasRiskyExpression(node.parameters ?? {});
}

/** node names to run (`execute`) and to pin with a fixture (`simulate`); every node is in exactly one */
export function planVerify(
  definition: WorkflowDefinition,
  nodeTypes: NodeTypeRegistry,
): { execute: string[]; simulate: string[] } {
  const execute: string[] = [];
  const simulate: string[] = [];
  const seen = new Set<string>();
  for (const node of definition.nodes ?? []) {
    const name = node?.name;
    if (typeof name !== 'string' || seen.has(name)) continue;
    seen.add(name);
    (mayRun(node, nodeTypes) ? execute : simulate).push(name);
  }
  return { execute, simulate };
}
