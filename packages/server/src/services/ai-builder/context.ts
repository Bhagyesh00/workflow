/**
 * What the builder tells the model about the workflow (P5-09). `buildWorkflowContext` and
 * `sanitizeForModel` are L1's: credentials removed, parameter values through `redactSecrets` and the
 * trim steps, "send data values" off gives structure only, last run of this workflow only.
 * `wrapUntrusted` is FULL from C0: every piece of node output, run data, page, plan note or existing
 * parameter goes through it before it reaches a model.
 *
 * Deviation from n8n: no `expressionValues`. Evaluated values can hold `$env` or secret values, so the
 * model sees the expression text only.
 */
import {
  BUILDER_CONTEXT_TOKENS,
  BUILDER_EXECUTION_DATA_LIMIT,
  BUILDER_TRIM_STEPS,
  BUILDER_VALUE_LIMIT,
  type Item,
  redactSecrets,
  type WorkflowDefinition,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import { ApiError } from '../../http/errors';
import { estimateTokens } from './compaction';

export interface BuildWorkflowContextInput {
  ctx: ServerContext;
  tenant: TenantRow;
  /** the workflow row, which must be the tenant's */
  workflowId: string;
  /** the editor's current definition, already parsed by `workflowDataSchema` */
  definition: WorkflowDefinition;
  /** the tenant's "send data values" setting */
  sendValues: boolean;
}

export interface SanitizeOptions {
  /** false: structure only, every value replaced by its type */
  sendValues?: boolean;
  /** characters a string value keeps (default `BUILDER_VALUE_LIMIT`) */
  maxChars?: number;
}

/** at most this many items per node are shown with values */
const SAMPLE_ITEMS = 2;
/** nested levels of a schema; deeper data shows as its type */
const MAX_DEPTH = 6;

function cut(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}... [${text.length - maxChars} more characters]`
    : text;
}

/** every leaf of `value`: strings redacted and cut (or replaced by the type when values are off) */
function scrub(value: unknown, options: Required<SanitizeOptions>, depth = 0): unknown {
  if (typeof value === 'string') {
    return options.sendValues ? cut(redactSecrets(value), options.maxChars) : '<string>';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return options.sendValues ? value : `<${typeof value}>`;
  }
  if (value === null || value === undefined) return value;
  if (depth > 20) return '<nested>';
  if (Array.isArray(value)) return value.map((v) => scrub(v, options, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v, options, depth + 1)]),
    );
  }
  return `<${typeof value}>`;
}

/** the shape of pinned or run items: keys and value types, never values */
function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return depth >= MAX_DEPTH ? 'array' : value.length ? [shapeOf(value[0], depth + 1)] : [];
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object';
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, depth + 1)]),
    );
  }
  return typeof value;
}

function sanitizeWith(definition: WorkflowDefinition, options: Required<SanitizeOptions>): unknown {
  return {
    name: options.sendValues ? cut(redactSecrets(definition.name ?? ''), 256) : '<string>',
    nodes: (definition.nodes ?? []).map((node) => ({
      name: node.name,
      type: node.type,
      typeVersion: node.typeVersion,
      position: node.position,
      ...(node.disabled ? { disabled: true } : {}),
      parameters: scrub(node.parameters ?? {}, options),
      // the credential types the node has, never an id, a name or data
      ...(node.credentials && Object.keys(node.credentials).length
        ? { credentialTypes: Object.keys(node.credentials) }
        : {}),
    })),
    connections: definition.connections ?? {},
    ...(definition.pinData && Object.keys(definition.pinData).length
      ? {
          pinnedDataShape: Object.fromEntries(
            Object.entries(definition.pinData).map(([name, items]) => [
              name,
              shapeOf(items?.[0]?.json ?? {}),
            ]),
          ),
        }
      : {}),
  };
}

/** the definition as the model may see it: no credentials, values redacted and trimmed */
export function sanitizeForModel(definition: WorkflowDefinition, options: SanitizeOptions = {}): unknown {
  return sanitizeWith(definition, {
    sendValues: options.sendValues !== false,
    maxChars: options.maxChars ?? BUILDER_VALUE_LIMIT,
  });
}

/** the sanitized definition, trimmed step by step until it fits `BUILDER_CONTEXT_TOKENS` */
function fittedWorkflow(definition: WorkflowDefinition, sendValues: boolean): string {
  let json = JSON.stringify(sanitizeForModel(definition, { sendValues }));
  for (const step of BUILDER_TRIM_STEPS) {
    if (estimateTokens(json) <= BUILDER_CONTEXT_TOKENS) break;
    json = JSON.stringify(sanitizeForModel(definition, { sendValues, maxChars: step }));
  }
  return json;
}

interface RunTask {
  data?: { main?: Array<Item[] | null> };
  executionStatus?: string;
}

/** one node's last output: the schema, plus a few trimmed values when values may be sent */
function nodeOutput(task: RunTask | undefined, sendValues: boolean, budget: number): unknown {
  const items = (task?.data?.main?.[0] ?? []).filter(Boolean) as Item[];
  const json = items.map((item) => item?.json ?? {});
  return {
    items: items.length,
    schema: shapeOf(json[0] ?? {}),
    // binary never: only the JSON part of an item
    ...(sendValues && json.length
      ? { sample: scrub(json.slice(0, SAMPLE_ITEMS), { sendValues: true, maxChars: Math.max(100, budget) }) }
      : {}),
  };
}

/**
 * The last run of `workflowId` (this tenant's only): each node's output schema and, when values may be
 * sent, trimmed sample values, wrapped as untrusted data. Never binary data, never another workflow.
 */
export async function executionContext(input: {
  ctx: ServerContext;
  tenant: TenantRow;
  workflowId: string;
  sendValues: boolean;
}): Promise<string> {
  const { ctx, tenant, workflowId, sendValues } = input;
  const [last] = await ctx.repos.executions.list(tenant.id, { workflowId, limit: 1 });
  if (!last || last.workflowId !== workflowId) return 'This workflow has not run yet.';
  const data = await ctx.repos.executions.getData(tenant.id, last.id);
  const runData = (data?.state as { resultData?: { runData?: Record<string, RunTask[]> } } | null)?.resultData
    ?.runData;
  if (!runData || !Object.keys(runData).length) return 'The last run of this workflow has no node output.';
  const names = Object.keys(runData);
  const budget = Math.floor(BUILDER_EXECUTION_DATA_LIMIT / names.length / SAMPLE_ITEMS);
  const outputs = Object.fromEntries(
    names.map((name) => {
      const runs = runData[name] ?? [];
      return [name, nodeOutput(runs[runs.length - 1], sendValues, budget)];
    }),
  );
  let json = JSON.stringify(outputs);
  if (json.length > BUILDER_EXECUTION_DATA_LIMIT) {
    // too much: the schemas only
    json = JSON.stringify(
      Object.fromEntries(
        names.map((name) => {
          const runs = runData[name] ?? [];
          return [name, nodeOutput(runs[runs.length - 1], false, 0)];
        }),
      ),
    );
    json = cut(json, BUILDER_EXECUTION_DATA_LIMIT);
  }
  return `Output of each node in the last run (status ${last.status}):\n${wrapUntrusted('execution', json)}`;
}

export async function buildWorkflowContext(input: BuildWorkflowContextInput): Promise<string> {
  const { ctx, tenant, workflowId, definition, sendValues } = input;
  const row = await ctx.repos.workflows.get(tenant.id, workflowId);
  if (!row) throw ApiError.notFound('Workflow');
  const parts = [
    definition.nodes?.length
      ? `The current workflow (nodes, parameters and connections${sendValues ? '' : '; values are hidden by a workspace setting'}):\n${wrapUntrusted('workflow', fittedWorkflow(definition, sendValues))}`
      : 'The workflow is empty.',
    await executionContext({ ctx, tenant, workflowId: row.id, sendValues }),
  ];
  return parts.join('\n\n');
}

export const UNTRUSTED_TAG = 'untrusted_data';

/**
 * Wraps outside text as `<untrusted_data source="...">` data the model must never follow. Every `<` in
 * `text` becomes `&lt;` and `source` keeps only `[\w .:-]`, so neither a page nor a node name can close
 * the wrapper or open another tag.
 */
export function wrapUntrusted(source: string, text: string): string {
  const safeSource = String(source ?? '').replace(/[^\w .:-]/g, '');
  const safeText = String(text ?? '').replace(/</g, '&lt;');
  return `<${UNTRUSTED_TAG} source="${safeSource}">\n${safeText}\n</${UNTRUSTED_TAG}>`;
}
