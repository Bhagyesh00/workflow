/**
 * The builder's tools on a draft (P5-09, L1): `search_nodes`, `get_node_details`, `add_nodes`,
 * `update_node_parameters`, `remove_node`, `rename_node`, `connect_nodes`, `remove_connection`,
 * `get_workflow_overview`, `get_execution_schema`, `validate_workflow`. Each wraps `invoke` to emit
 * `tool` progress; a change emits `workflow-updated`. No tool saves, runs, reads credentials or calls
 * out; a credential the model writes is dropped here.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import {
  type AiTool,
  BUILDER_MAX_VALIDATE_ATTEMPTS,
  type BuilderChunk,
  type DataObject,
  type DoctorIssue,
  type JsonSchema,
  latestVersion,
  lintForBuilder,
  type NodeCredentialDescription,
  type NodeProperty,
  redactSecrets,
  Workflow,
  type WorkflowDefinition,
} from '@workflow/workflow';
import type { ServerContext } from '../../context';
import type { TenantRow } from '../../db/schema';
import { PolicyCheckFailedError, violationMessage } from '../type-policies/errors';
import { policyIssues, restrictedNodeTypesView, workflowProjectId } from '../type-policies/tool-filter';
import { workflowWebhooks } from '../webhook-paths';
import { executionContext, sanitizeForModel, wrapUntrusted } from './context';
import {
  type BuilderConnectionInput,
  type BuilderDraft,
  type BuilderDraftNodeInput,
  MAX_CONNECTION_INDEX,
} from './draft';

/** what every builder tool gets; `ctx` and `tenant` are frozen, L1 may add fields */
export interface BuilderToolDeps {
  ctx: ServerContext;
  tenant: TenantRow;
  emit: (chunk: BuilderChunk) => void;
  /** the workflow the draft belongs to (the tenant's row): `get_execution_schema` reads its last run */
  workflowId?: string;
  /** the tenant's "send data values" setting; off gives structure only */
  sendValues?: boolean;
}

/** one hit of `search_nodes` */
export interface BuilderNodeSearchHit {
  type: string;
  displayName: string;
  description: string;
  /** latest type version */
  version: number;
  isTrigger: boolean;
}

/** the hits for one query of `search_nodes` */
export interface BuilderNodeSearchResult {
  query: string;
  results: BuilderNodeSearchHit[];
}

/** what `get_node_details` returns for one type */
export interface BuilderNodeDetails {
  type: string;
  displayName: string;
  description: string;
  version: number;
  inputs: unknown;
  outputs: unknown;
  properties: NodeProperty[];
  credentials: NodeCredentialDescription[];
}

/** result of `validate_workflow`: the builder lint (`lintForBuilder`) and the server's own checks */
export interface BuilderValidation {
  valid: boolean;
  issues: DoctorIssue[];
}

const MAX_HITS = 10;
const MAX_QUERIES = 10;

const OBJECT = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});
const STRING: JsonSchema = { type: 'string' };
const INTEGER: JsonSchema = { type: 'integer', minimum: 0, maximum: MAX_CONNECTION_INDEX };
const CONNECTION: JsonSchema = OBJECT(
  {
    from: {
      type: 'string',
      description: 'name of the node the connection starts at (a sub-node for AI inputs)',
    },
    to: { type: 'string', description: 'name of the node the connection ends at' },
    type: {
      type: 'string',
      description: 'connection type, default "main"; e.g. "ai_languageModel", "ai_tool"',
    },
    outputIndex: { ...INTEGER, description: 'output of "from", default 0' },
    inputIndex: { ...INTEGER, description: 'input of "to", default 0' },
  },
  ['from', 'to'],
);

function isTrigger(group: string[] | undefined, polling: unknown): boolean {
  return Boolean(group?.includes('trigger') || polling);
}

function score(text: string, terms: string[], weight: number): number {
  const lower = text.toLowerCase();
  return terms.reduce((sum, term) => sum + (lower.includes(term) ? weight : 0), 0);
}

export function searchNodes(nodeTypes: NodeTypeRegistry, queries: string[]): BuilderNodeSearchResult[] {
  const all = nodeTypes.list().filter((t) => !t.description.hidden);
  return queries.slice(0, MAX_QUERIES).map((raw) => {
    const query = String(raw ?? '').trim();
    const lowered = query.toLowerCase();
    const terms = lowered.split(/\s+/).filter(Boolean);
    const scored = all
      .map((t) => {
        const d = t.description;
        let points =
          (d.name.toLowerCase() === lowered || d.displayName.toLowerCase() === lowered ? 100 : 0) +
          (lowered && d.displayName.toLowerCase().includes(lowered) ? 30 : 0) +
          score(d.displayName, terms, 10) +
          score((d.alias ?? []).join(' '), terms, 8) +
          score(d.name, terms, 6) +
          score((d.categories ?? []).join(' '), terms, 3) +
          score(d.description ?? '', terms, 2);
        // tool variants rank below their node unless the query asks for a tool
        if (points && d.name.endsWith('Tool') && !terms.includes('tool')) points -= 1;
        return { t, points };
      })
      .filter((s) => s.points > 0)
      .sort((a, b) => b.points - a.points || a.t.description.name.localeCompare(b.t.description.name))
      .slice(0, MAX_HITS);
    return {
      query,
      results: scored.map(({ t }) => ({
        type: t.description.name,
        displayName: t.description.displayName,
        description: t.description.description ?? '',
        version: latestVersion(t.description),
        isTrigger: isTrigger(t.description.group, t.description.polling),
      })),
    };
  });
}

/** undefined for an unknown type */
export function nodeDetails(nodeTypes: NodeTypeRegistry, type: string): BuilderNodeDetails | undefined {
  const nodeType = nodeTypes.get(type);
  if (!nodeType) return undefined;
  const d = nodeType.description;
  return {
    type: d.name,
    displayName: d.displayName,
    description: d.description ?? '',
    version: latestVersion(d),
    inputs: d.inputs,
    outputs: d.outputs,
    properties: d.properties,
    // credential slots by type name only: never a stored credential
    credentials: (d.credentials ?? []).map(({ name, required, displayOptions }) => ({
      name,
      ...(required !== undefined ? { required } : {}),
      ...(displayOptions ? { displayOptions } : {}),
    })),
  };
}

export async function validateDefinition(
  ctx: ServerContext,
  tenantId: string,
  definition: WorkflowDefinition,
  workflowId?: string,
): Promise<BuilderValidation> {
  const nodeTypes = ctx.registries.nodeTypes;
  const issues = lintForBuilder(
    { nodes: definition.nodes, connections: definition.connections, pinData: definition.pinData },
    { get: (type) => nodeTypes.get(type)?.description },
  );
  const add = (issue: Omit<DoctorIssue, 'id'>) =>
    issues.push({ ...issue, id: `${issue.severity}:${issue.node ?? '-'}:${issue.code}:${issues.length}` });
  let workflow: Workflow | undefined;
  try {
    workflow = new Workflow(definition, nodeTypes);
  } catch (error) {
    add({ severity: 'error', code: 'workflow-invalid', message: (error as Error).message });
  }
  if (workflow) {
    try {
      const hooks = workflowWebhooks(workflow);
      const conflicts = hooks.length
        ? await ctx.repos.webhooks.findConflicts(tenantId, workflowId ?? '', hooks)
        : [];
      for (const conflict of conflicts) {
        const hook = hooks.find((h) => h.method === conflict.method && h.path === conflict.path);
        add({
          severity: 'warning',
          node: hook?.nodeName,
          code: 'webhook-path-in-use',
          message: `The webhook path "${conflict.method} ${conflict.path}" is used by another active workflow`,
          hint: 'Choose another path.',
        });
      }
    } catch (error) {
      add({ severity: 'error', code: 'webhook-invalid', message: (error as Error).message });
    }
  }
  await addPolicyIssues(ctx, tenantId, definition, workflowId, add);
  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/** the nodes a policy check reads out of a stored `nodes` column (anything else is skipped) */
function storedPolicyNodes(nodes: readonly unknown[]): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const node = raw as { name?: unknown; type?: unknown };
    if (typeof node.type !== 'string') continue;
    out.push({ name: typeof node.name === 'string' ? node.name : '', type: node.type });
  }
  return out;
}

/**
 * The type policy violations of a definition as error issues (P6-55), so a model retries. In the workflow's
 * project when `workflowId` names one, else the workspace scope; against the stored workflow only the added
 * types are judged, as at a save. A check that cannot decide is an error issue too: it never passes.
 */
async function addPolicyIssues(
  ctx: ServerContext,
  tenantId: string,
  definition: WorkflowDefinition,
  workflowId: string | undefined,
  add: (issue: Omit<DoctorIssue, 'id'>) => void,
): Promise<void> {
  try {
    const stored = workflowId ? await ctx.repos.workflows.get(tenantId, workflowId) : undefined;
    const violations = await policyIssues(
      ctx.serviceDeps,
      tenantId,
      stored?.projectId ?? null,
      definition,
      stored ? { nodes: storedPolicyNodes(stored.nodes) } : undefined,
    );
    for (const violation of violations) {
      add({
        severity: 'error',
        ...(violation.nodeName ? { node: violation.nodeName } : {}),
        code: 'policy-blocked',
        message: violationMessage([violation]),
        hint: 'Use another type; this one is not available here.',
      });
    }
  } catch (error) {
    if (!(error instanceof PolicyCheckFailedError)) throw error;
    add({
      severity: 'error',
      code: 'policy-check-failed',
      message: error.message,
      hint: 'Try again in a moment.',
    });
  }
}

/** the model's nodes without credentials: the user picks credentials, never the model */
function withoutCredentials(nodes: unknown): { nodes: BuilderDraftNodeInput[]; dropped: number } {
  if (!Array.isArray(nodes)) return { nodes: [], dropped: 0 };
  let dropped = 0;
  const clean = nodes.map((raw) => {
    const { credentials, ...rest } = (raw ?? {}) as BuilderDraftNodeInput;
    if (credentials !== undefined) dropped++;
    return rest as BuilderDraftNodeInput;
  });
  return { nodes: clean, dropped };
}

/** issue codes whose message quotes a parameter value: a fixed text when data values are off */
const VALUE_MESSAGES: Record<string, (message: string) => string> = {
  'node-invalid-options-value': (message) => {
    const label = /^("[^"]*") has the value /.exec(message)?.[1];
    return `${label ?? 'A parameter'} has a value that is not one of its options`;
  },
  'webhook-path-conflict': () => 'Another webhook node in this workflow listens on the same method and path',
  'webhook-path-in-use': () => 'The webhook path is used by another active workflow',
  'webhook-invalid': () => 'A webhook node has an invalid method or path',
};

function issueView(issue: DoctorIssue, sendValues: boolean) {
  const hide = !sendValues && issue.code ? VALUE_MESSAGES[issue.code] : undefined;
  return {
    severity: issue.severity,
    ...(issue.code ? { code: issue.code } : {}),
    ...(issue.node ? { node: issue.node } : {}),
    message: redactSecrets(hide ? hide(issue.message) : issue.message),
    ...(issue.hint ? { hint: redactSecrets(issue.hint) } : {}),
  };
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** one tool: progress chunks around `run`, and `workflow-updated` after a change */
function builderTool(
  deps: BuilderToolDeps,
  draft: BuilderDraft,
  spec: { name: string; description: string; parameters: JsonSchema; changes?: boolean },
  run: (args: DataObject) => unknown | Promise<unknown>,
): AiTool {
  return {
    kind: 'tool',
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    async invoke(args: DataObject) {
      deps.emit({ type: 'tool', toolName: spec.name, status: 'running' });
      let result: unknown;
      try {
        result = await run(args ?? {});
      } catch (error) {
        const message = errorText(error);
        deps.emit({ type: 'tool', toolName: spec.name, status: 'error', summary: message });
        throw new Error(message);
      }
      deps.emit({ type: 'tool', toolName: spec.name, status: 'done' });
      if (spec.changes) {
        deps.emit({ type: 'workflow-updated', workflow: structuredClone(draft.definition()) });
      }
      return result;
    },
  };
}

function searchTool(draft: BuilderDraft, deps: BuilderToolDeps): AiTool {
  return builderTool(
    deps,
    draft,
    {
      name: 'search_nodes',
      description:
        'Find node types by what they do. Give several short queries at once (for example ["webhook", "send email"]). Returns type names to use in add_nodes.',
      parameters: OBJECT({ queries: { type: 'array', items: STRING, minItems: 1, maxItems: MAX_QUERIES } }, [
        'queries',
      ]),
    },
    async (args) =>
      searchNodes(
        await restrictedNodeTypesView(
          deps.ctx.serviceDeps,
          deps.tenant.id,
          await workflowProjectId(deps.ctx.serviceDeps, deps.tenant.id, deps.workflowId),
          draft.nodeTypes,
        ),
        (args.queries as string[]) ?? [],
      ),
  );
}

function detailsTool(draft: BuilderDraft, deps: BuilderToolDeps): AiTool {
  return builderTool(
    deps,
    draft,
    {
      name: 'get_node_details',
      description:
        'The parameters, inputs, outputs and credential types of one node type. Read it before you add or configure a node.',
      parameters: OBJECT({ type: STRING }, ['type']),
    },
    async (args) => {
      const view = await restrictedNodeTypesView(
        deps.ctx.serviceDeps,
        deps.tenant.id,
        await workflowProjectId(deps.ctx.serviceDeps, deps.tenant.id, deps.workflowId),
        draft.nodeTypes,
      );
      const details = nodeDetails(view, String(args.type ?? ''));
      if (!details)
        throw new Error(`Unknown node type "${String(args.type ?? '')}". Use search_nodes first.`);
      return details;
    },
  );
}

function overviewTool(draft: BuilderDraft, deps: BuilderToolDeps): AiTool {
  return builderTool(
    deps,
    draft,
    {
      name: 'get_workflow_overview',
      description: 'The current draft: its nodes, their parameters and the connections.',
      parameters: OBJECT({}),
    },
    () =>
      wrapUntrusted(
        'workflow',
        JSON.stringify(sanitizeForModel(draft.definition(), { sendValues: deps.sendValues !== false })),
      ),
  );
}

/** the read-only tools: `search_nodes`, `get_node_details`, `get_workflow_overview` (plan mode) */
export function readBuilderTools(draft: BuilderDraft, deps: BuilderToolDeps): AiTool[] {
  return [searchTool(draft, deps), detailsTool(draft, deps), overviewTool(draft, deps)];
}

/** every builder tool on `draft` (build mode); the caller adds `webFetchTools` */
export function createBuilderTools(draft: BuilderDraft, deps: BuilderToolDeps): AiTool[] {
  let validations = 0;
  const change = (
    spec: Omit<Parameters<typeof builderTool>[2], 'changes'>,
    run: (args: DataObject) => unknown,
  ) => builderTool(deps, draft, { ...spec, changes: true }, run);

  return [
    ...readBuilderTools(draft, deps),
    change(
      {
        name: 'add_nodes',
        description:
          'Add nodes to the draft. Each node: type (from search_nodes), name, parameters. Leave credentials out: the user picks them. Returns the final names.',
        parameters: OBJECT(
          {
            nodes: {
              type: 'array',
              minItems: 1,
              items: OBJECT(
                {
                  type: STRING,
                  name: STRING,
                  typeVersion: { type: 'number' },
                  position: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
                  parameters: { type: 'object' },
                },
                ['type'],
              ),
            },
          },
          ['nodes'],
        ),
      },
      (args) => {
        const { nodes, dropped } = withoutCredentials(args.nodes);
        const added = draft.addNodes(nodes);
        return {
          added: added.map((n) => ({ name: n.name, type: n.type, typeVersion: n.typeVersion })),
          ...(dropped
            ? { note: 'Credentials were left out: the user picks them after the draft is accepted.' }
            : {}),
        };
      },
    ),
    change(
      {
        name: 'update_node_parameters',
        description:
          'Set parameters of one node. Top-level keys replace the old values; null removes a key. Credentials are not parameters and cannot be set.',
        parameters: OBJECT({ name: STRING, parameters: { type: 'object' } }, ['name', 'parameters']),
      },
      (args) => {
        const node = draft.updateNodeParameters(String(args.name ?? ''), args.parameters as DataObject);
        return { updated: node.name };
      },
    ),
    change(
      {
        name: 'remove_node',
        description: 'Remove a node and its connections.',
        parameters: OBJECT({ name: STRING }, ['name']),
      },
      (args) => {
        draft.removeNode(String(args.name ?? ''));
        return { removed: String(args.name) };
      },
    ),
    change(
      {
        name: 'rename_node',
        description: 'Rename a node; connections and expressions that name it follow.',
        parameters: OBJECT({ name: STRING, newName: STRING }, ['name', 'newName']),
      },
      (args) => {
        draft.renameNode(String(args.name ?? ''), String(args.newName ?? ''));
        return { renamed: String(args.name), to: String(args.newName).trim() };
      },
    ),
    change(
      {
        name: 'connect_nodes',
        description:
          'Connect nodes. Main data flows from "from" to "to". An AI sub-node (model, memory, tool) connects from the sub-node to its root node with the matching type, e.g. type "ai_languageModel".',
        parameters: OBJECT({ items: { type: 'array', minItems: 1, items: CONNECTION } }, ['items']),
      },
      (args) => {
        const items = (args.items as BuilderConnectionInput[]) ?? [];
        draft.connectNodes(items);
        return { connected: items.length };
      },
    ),
    change(
      {
        name: 'remove_connection',
        description: 'Remove one connection.',
        parameters: CONNECTION,
      },
      (args) => {
        draft.removeConnection(args as unknown as BuilderConnectionInput);
        return { removed: true };
      },
    ),
    builderTool(
      deps,
      draft,
      {
        name: 'get_execution_schema',
        description:
          'The output fields of each node in the last run of this workflow, to write expressions such as {{ $json.field }}.',
        parameters: OBJECT({}),
      },
      async () => {
        if (!deps.workflowId) return 'This workflow has not run yet.';
        return executionContext({
          ctx: deps.ctx,
          tenant: deps.tenant,
          workflowId: deps.workflowId,
          sendValues: deps.sendValues !== false,
        });
      },
    ),
    builderTool(
      deps,
      draft,
      {
        name: 'validate_workflow',
        description: `Check the draft for problems. Fix every error and validate again; at most ${BUILDER_MAX_VALIDATE_ATTEMPTS} times per request.`,
        parameters: OBJECT({}),
      },
      async () => {
        validations++;
        if (validations > BUILDER_MAX_VALIDATE_ATTEMPTS) {
          return `Validation was already run ${BUILDER_MAX_VALIDATE_ATTEMPTS} times. Stop and tell the user which problems are left.`;
        }
        const result = await validateDefinition(
          deps.ctx,
          deps.tenant.id,
          draft.definition(),
          deps.workflowId,
        );
        const head = result.valid
          ? 'The draft is valid.'
          : 'The draft has errors. Fix each one (see the hints), then validate again.';
        // messages name nodes and parameters of the user's workflow: data, never instructions
        return `${head}\n${wrapUntrusted('validation', JSON.stringify(result.issues.map((issue) => issueView(issue, deps.sendValues !== false))))}`;
      },
    ),
  ];
}
