/**
 * `get_resolved_node_parameters` (P5-69, lane L4): a node's parameters as they resolved for one item of
 * one run of a saved execution, with `createDataProxy` (through `ExpressionEvaluator`) over the run data
 * the execution saved. Nothing runs again and no node is called.
 *
 * An expression that names `$env`, `$secrets`, `$vars` or `$credentials` is never evaluated: it comes
 * back as `skipped` (same reason as decisions' `expressionValues` line: such values can hold secrets).
 * Every other value passes `redactSecrets` and is cut. With `sendValues` false nothing is resolved.
 */
import {
  type DataObject,
  type ExecuteData,
  type ExecutionMode,
  type ExpressionDataContext,
  ExpressionEvaluator,
  type Item,
  isExpression,
  type NodeParameters,
  type RunData,
  redactSecrets,
  type SourceData,
  type TaskData,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';

/** expressions naming these are not evaluated */
export const SKIPPED_EXPRESSION_VARIABLES = ['$env', '$secrets', '$vars', '$credentials'] as const;

const SKIP_PATTERN = /\$(?:env|secrets|vars|credentials)\b/;

export const SKIPPED_EXPRESSION_REASON =
  'It reads $env, $secrets, $vars or $credentials, which the Assistant never evaluates';

/** characters a resolved string keeps; entries listed; budget of one expression */
const LIMITS = { valueChars: 500, expressions: 100, arrayItems: 20, keys: 50, depth: 6, timeoutMs: 1000 };

export type ResolvedExpressionStatus = 'resolved' | 'empty' | 'failed' | 'skipped';

export interface ResolvedExpression {
  /** dotted path in the parameters, e.g. `assignments.assignments.0.value` */
  path: string;
  expression: string;
  status: ResolvedExpressionStatus;
  value?: unknown;
  error?: string;
  reason?: string;
}

export interface ResolveNodeParametersInput {
  definition: WorkflowDefinition;
  runData: RunData;
  nodeName: string;
  itemIndex: number;
  /** omitted: the node's last run */
  runIndex?: number;
  executionId: string;
  mode: ExecutionMode;
  sendValues: boolean;
}

export interface ResolvedNodeParameters {
  node: string;
  type: string;
  runIndex: number | null;
  itemIndex: number;
  /** items on the node's first input for that run */
  inputItemCount: number;
  /** the parameters with each expression replaced by its value (`[skipped]`, `[failed]` where it did not resolve) */
  parameters?: unknown;
  expressions?: ResolvedExpression[];
  note?: string;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** redacted before it is cut, so a cut never leaves part of a secret unmatched */
function safeString(text: string): string {
  return cut(redactSecrets(text.slice(0, LIMITS.valueChars * 4)), LIMITS.valueChars);
}

/** a value as the model may read it: strings redacted and cut, arrays and objects bounded */
export function safeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return safeString(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined) return null;
  if (typeof value !== 'object') return safeString(String(value));
  if (depth >= LIMITS.depth) return '[…]';
  if (typeof (value as { toISO?: unknown }).toISO === 'function') {
    return safeString(String((value as { toISO: () => string }).toISO()));
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const shown = value.slice(0, LIMITS.arrayItems).map((v) => safeValue(v, depth + 1));
    if (value.length > LIMITS.arrayItems) shown.push(`[${value.length - LIMITS.arrayItems} more]`);
    return shown;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries.slice(0, LIMITS.keys)) out[safeString(key)] = safeValue(v, depth + 1);
  if (entries.length > LIMITS.keys) out['[more keys]'] = entries.length - LIMITS.keys;
  return out;
}

/** true when an expression names one of `SKIPPED_EXPRESSION_VARIABLES` */
export function isSkippedExpression(expression: string): boolean {
  return SKIP_PATTERN.test(expression);
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
  );
}

/** the items a source points at: output `previousNodeOutput` of run `previousNodeRun` of `previousNode` */
function sourceItems(runData: RunData, source: SourceData | null | undefined): Item[] {
  if (!source?.previousNode) return [];
  const runs = runData[source.previousNode] ?? [];
  const task = runs[source.previousNodeRun ?? runs.length - 1];
  const items = task?.data?.main?.[source.previousNodeOutput ?? 0];
  return Array.isArray(items) ? items : [];
}

/** the node's input items of one run: from its run's source, or the input it was given (sub-nodes) */
function inputItems(runData: RunData, task: TaskData | undefined): Item[] {
  const override = task?.inputOverride?.main?.[0];
  if (Array.isArray(override)) return override;
  return sourceItems(runData, task?.source?.[0] ?? null);
}

/**
 * Resolves `input.nodeName`'s parameters for one item of one run. Throws when the node is not in the
 * definition or the run does not exist.
 */
export function resolveNodeParameters(input: ResolveNodeParametersInput): ResolvedNodeParameters {
  const { definition, runData, nodeName, itemIndex, executionId, mode } = input;
  const node: WorkflowNode | undefined = (definition.nodes ?? []).find((n) => n.name === nodeName);
  if (!node) throw new Error(`Node '${nodeName}' is not in this execution's workflow`);
  const runs = runData[nodeName] ?? [];
  if (input.runIndex !== undefined && (input.runIndex < 0 || input.runIndex >= runs.length)) {
    throw new Error(`Node '${nodeName}' has no run ${input.runIndex} (it ran ${runs.length} times)`);
  }
  const runIndex = input.runIndex ?? (runs.length ? runs.length - 1 : null);
  const task = runIndex === null ? undefined : runs[runIndex];
  const items = inputItems(runData, task);
  const base: ResolvedNodeParameters = {
    node: nodeName,
    type: node.type,
    runIndex,
    itemIndex,
    inputItemCount: items.length,
  };
  if (!input.sendValues) {
    return { ...base, note: 'Parameter values are hidden by a workspace setting, so nothing was resolved' };
  }

  const nodes: Record<string, WorkflowNode> = {};
  for (const n of definition.nodes ?? []) nodes[n.name] = n;
  const executeData: ExecuteData = {
    node: nodeName,
    data: { main: [items] },
    source: task ? { main: (task.source ?? []) as Array<SourceData | null> } : null,
  };
  const context: ExpressionDataContext = {
    workflow: { id: definition.id, name: definition.name ?? '', active: definition.active ?? false, nodes },
    runData,
    activeNodeName: nodeName,
    connectionInputData: items,
    itemIndex,
    runIndex: runIndex ?? 0,
    mode,
    executionId,
    timezone: definition.settings?.timezone ?? 'UTC',
    // never the tenant's variables: `$vars` expressions are skipped, and none may reach the model
    variables: {},
    executeData,
    nodeParameters: (node.parameters ?? {}) as NodeParameters,
  };
  const evaluator = new ExpressionEvaluator({ timeoutMs: LIMITS.timeoutMs });
  const expressions: ResolvedExpression[] = [];

  const walk = (value: unknown, path: string[], depth: number): unknown => {
    if (isExpression(value)) {
      const entry: ResolvedExpression = {
        path: path.join('.') || '(root)',
        expression: safeString(value),
        status: 'resolved',
      };
      let shown: unknown;
      if (isSkippedExpression(value)) {
        entry.status = 'skipped';
        entry.reason = SKIPPED_EXPRESSION_REASON;
        shown = '[skipped]';
      } else {
        try {
          const resolved = evaluator.evaluate(value, context);
          shown = safeValue(resolved);
          entry.status = isEmpty(resolved) ? 'empty' : 'resolved';
          entry.value = shown;
        } catch (error) {
          entry.status = 'failed';
          entry.error = safeString(error instanceof Error ? error.message : String(error));
          shown = '[failed]';
        }
      }
      if (expressions.length < LIMITS.expressions) expressions.push(entry);
      return shown;
    }
    if (depth >= LIMITS.depth) return '[…]';
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)], depth + 1));
    if (value && typeof value === 'object') {
      const out: DataObject = {};
      for (const [key, v] of Object.entries(value)) {
        out[safeString(key)] = walk(v, [...path, key], depth + 1) as DataObject[string];
      }
      return out;
    }
    return safeValue(value);
  };

  const parameters = walk(node.parameters ?? {}, [], 0);
  return {
    ...base,
    parameters,
    expressions,
    ...(runIndex === null ? { note: 'The node did not run in this execution, so its input is empty' } : {}),
  };
}
