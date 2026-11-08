/**
 * Assistant tools: node search, node details, parameter options and running one node (P5-69, lane L6).
 *
 * - `search_nodes`, `get_node_types` (viewer): S4's `searchNodes` and `nodeDetails` on the node registry;
 *   static descriptions, so no untrusted wrapper. A node type is only ever looked up with `nodeTypes.get`.
 * - `get_node_parameter_options` (editor, as `POST /node-types/options`): `loadNodeOptions` for one
 *   parameter or method; a credential must be this workspace's; the list comes from an outside API, so the
 *   result is wrapped (`node-options`), and so is the node's own error (the adapter's `shapeToolError`).
 * - `execute_node` (editor, `executeNode`): always a card unless this thread holds the grant
 *   `nodes:execute:<type>:<resource>:<operation>` (a node with neither is scoped by the first of `mode`,
 *   `url`, `query`, `command`, `action` it declares, else by its type alone; no grant is offered past 200
 *   characters, so one URL never stands for all, nor when a value the key uses is an expression, which the
 *   input items decide at run time). The card shows every parameter (redacted, up to 6000 characters, the
 *   rest counted) and the input items as a preview. Before the card: the type must exist and run alone (no
 *   trigger, webhook-only or sub-node), and every credential must be this workspace's
 *   (`assertCredentialsInTenant`). On approval a one-node definition runs through `runAndCollect` (mode
 *   manual, no workflow id, at most 60 s); a node that starts waiting is stopped and reported as an error;
 *   the output goes through `previewOutput` (redacted, wrapped, values only with `sendValues`).
 */
import { randomUUID } from 'node:crypto';
import {
  type AssistantApprovalDetails,
  type DataObject,
  type Item,
  isExpression,
  type NodeProperty,
  type NodeType,
  redactSecrets,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';
import { z } from 'zod';
import type { ServerContext } from '../../../context';
import type { AuthContext } from '../../../http/auth';
import { nodeDetails, searchNodes } from '../../ai-builder/tools';
import { assertCredentialsInTenant } from '../../mcp/tools/builder/credential-check';
import { McpToolError } from '../../mcp/workflow-gate';
import { loadNodeOptions } from '../../node-options';
import { approvalPreview } from '../approvals';
import { previewOutput, runAndCollect } from '../run-helper';
import type { AssistantRunScope, AssistantToolDefinition } from '../types';

/** the longest run of one node */
export const EXECUTE_NODE_MAX_MS = 60_000;
/** a longer grant key offers no "always allow this session" */
export const EXECUTE_NODE_GRANT_MAX = 200;
/** parameters that scope a grant for a node with neither `resource` nor `operation`, in this order */
export const EXECUTE_NODE_GRANT_FALLBACK = ['mode', 'url', 'query', 'command', 'action'] as const;
const MAX_INPUT_ITEMS = 50;
const FACT_CHARS = 200;
/** characters of one parameter fact (the gate cuts a fact at 500) */
const PARAMETER_PART_CHARS = 480;
/** characters of parameters one card shows; the rest is counted in a `Parameters cut` fact */
export const EXECUTE_NODE_PARAMETER_CHARS = 6000;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function versionsOf(nodeType: NodeType): number[] {
  const v = nodeType.description.version;
  return Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------------------------------------
// search_nodes, get_node_types
// ---------------------------------------------------------------------------------------------------------

const searchNodesInput = z
  .object({
    query: z.string().trim().min(1).max(100).optional().describe('One short search, e.g. "slack"'),
    queries: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(10)
      .optional()
      .describe('Up to ten searches in one call, e.g. ["gmail", "http request"]'),
  })
  .refine((value) => value.query !== undefined || value.queries !== undefined, {
    message: 'Give "query" or "queries"',
  });
type SearchNodesInput = z.infer<typeof searchNodesInput>;

const searchNodesTool: AssistantToolDefinition<SearchNodesInput> = {
  name: 'search_nodes',
  description:
    'Search the node types of this instance by name, service or purpose. Use short service names ("Slack", "HTTP Request"), not whole sentences.',
  input: searchNodesInput,
  minRole: 'viewer',
  async handler(ctx, _run, input) {
    const queries = [...(input.query ? [input.query] : []), ...(input.queries ?? [])].slice(0, 10);
    return { results: searchNodes(ctx.registries.nodeTypes, queries) };
  },
};

const nodeTypeRequest = z.union([
  z.string().trim().min(1).max(256),
  z.object({
    nodeType: z.string().trim().min(1).max(256),
    version: z.number().optional(),
    resource: z.string().max(256).optional(),
    operation: z.string().max(256).optional(),
    mode: z.string().max(256).optional(),
  }),
]);

type NodeTypeRequest = z.infer<typeof nodeTypeRequest>;

const getNodeTypesInput = z.object({
  nodeTypes: z
    .array(nodeTypeRequest)
    .min(1)
    .max(10)
    .describe(
      'One to ten node types: a type name, or { nodeType, version?, resource?, operation?, mode? } to show only the parameters of that resource, operation or mode',
    ),
});
type GetNodeTypesInput = z.infer<typeof getNodeTypesInput>;

/** false when a `show` rule on `name` excludes `value` */
function shownFor(property: NodeProperty, name: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  const show = property.displayOptions?.show?.[name];
  if (Array.isArray(show) && !show.some((entry) => entry === value)) return false;
  const hide = property.displayOptions?.hide?.[name];
  if (Array.isArray(hide) && hide.some((entry) => entry === value)) return false;
  return true;
}

const getNodeTypesTool: AssistantToolDefinition<GetNodeTypesInput> = {
  name: 'get_node_types',
  description:
    'Get the exact parameters, credential slots, inputs and outputs of one to ten node types, by type name from search_nodes.',
  input: getNodeTypesInput,
  minRole: 'viewer',
  async handler(ctx, _run, input) {
    const definitions = input.nodeTypes.map((request) => {
      const spec: Exclude<NodeTypeRequest, string> =
        typeof request === 'string' ? { nodeType: request } : request;
      const details = nodeDetails(ctx.registries.nodeTypes, spec.nodeType);
      if (!details) return { nodeType: spec.nodeType, error: `Unknown node type "${spec.nodeType}"` };
      const nodeType = ctx.registries.nodeTypes.get(spec.nodeType);
      const versions = nodeType ? versionsOf(nodeType) : [details.version];
      const properties = details.properties.filter(
        (p) =>
          shownFor(p, 'resource', spec.resource) &&
          shownFor(p, 'operation', spec.operation) &&
          shownFor(p, 'mode', spec.mode),
      );
      return {
        ...details,
        versions,
        ...(spec.version !== undefined && !versions.includes(spec.version)
          ? { note: `Version ${spec.version} does not exist; the versions are ${versions.join(', ')}` }
          : {}),
        properties,
      };
    });
    return { definitions };
  },
};

// ---------------------------------------------------------------------------------------------------------
// get_node_parameter_options
// ---------------------------------------------------------------------------------------------------------

const credentialRef = z.object({ id: z.string().min(1).max(128), name: z.string().max(256) });

const optionsInput = z
  .object({
    nodeType: z.string().trim().min(1).max(256),
    version: z.number().describe('The node type version'),
    parameterPath: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe('The parameter to list values for, e.g. "channelId" or "model"; dots for nested ones'),
    methodName: z.string().trim().min(1).max(256).optional().describe('The method itself, with methodType'),
    methodType: z.enum(['loadOptions', 'listSearch', 'resourceMapping']).optional(),
    credentialType: z.string().trim().min(1).max(128).optional(),
    credentialId: z.string().trim().min(1).max(128).optional().describe('A credential of this workspace'),
    credentials: z.record(z.string(), credentialRef).optional().describe('The node credentials map'),
    currentNodeParameters: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Parameters a dependent list needs, e.g. the selected resource'),
    filter: z.string().max(1000).optional(),
    paginationToken: z.string().max(2000).optional(),
  })
  .refine((value) => value.parameterPath !== undefined || value.methodName !== undefined, {
    message: 'Give "parameterPath", or "methodName" with "methodType"',
  })
  .refine((value) => value.methodName === undefined || value.methodType !== undefined, {
    message: '"methodName" needs "methodType"',
  });
type OptionsInput = z.infer<typeof optionsInput>;

type OptionsMethod = { kind: 'loadOptions' | 'listSearch' | 'resourceMapping'; method: string };

/** the property at `path` (names joined by dots), looking through collections and fixed collections */
function findProperty(properties: NodeProperty[], path: string): NodeProperty | undefined {
  const [head, ...rest] = path.split('.');
  const match = properties.find((p) => p.name === head);
  if (!match) return undefined;
  if (!rest.length) return match;
  const children = (match.options ?? []).flatMap((option) => {
    if ('values' in option && Array.isArray(option.values)) return option.values as NodeProperty[];
    if ('type' in option && 'default' in option) return [option as NodeProperty];
    return [];
  });
  return findProperty(children, rest.join('.'));
}

function methodOf(property: NodeProperty): OptionsMethod | undefined {
  const listMode = property.modes?.find((mode) => mode.typeOptions?.searchListMethod);
  if (property.type === 'resourceLocator' && listMode?.typeOptions?.searchListMethod) {
    return { kind: 'listSearch', method: listMode.typeOptions.searchListMethod };
  }
  if (property.typeOptions?.loadOptionsMethod) {
    return { kind: 'loadOptions', method: property.typeOptions.loadOptionsMethod };
  }
  if (property.typeOptions?.resourceMapper?.resourceMapperMethod) {
    return { kind: 'resourceMapping', method: property.typeOptions.resourceMapper.resourceMapperMethod };
  }
  return undefined;
}

/** a credential refusal of S4's check as this tool's own text */
async function assertTenantCredentials(
  ctx: ServerContext,
  tenantId: string,
  definition: WorkflowDefinition,
): Promise<void> {
  try {
    await assertCredentialsInTenant(ctx, tenantId, definition);
  } catch (error) {
    if (error instanceof McpToolError) {
      throw new Error(
        error.message.startsWith('Credential "')
          ? 'A credential this node uses is not in this workspace, so it was refused'
          : 'A credential reference of this node is not valid: it needs a string "id" and a "name"',
      );
    }
    throw error;
  }
}

/** the node's credentials, each checked to be a credential of this workspace of the named type */
async function tenantCredentials(
  ctx: ServerContext,
  run: AssistantRunScope,
  credentials: Record<string, { id: string; name: string }>,
): Promise<Array<{ type: string; id: string; name: string }>> {
  const nodes = [{ credentials } as unknown as WorkflowNode];
  await assertTenantCredentials(ctx, run.tenant.id, { name: 'check', nodes, connections: {} });
  const out: Array<{ type: string; id: string; name: string }> = [];
  for (const [type, ref] of Object.entries(credentials)) {
    const row = await ctx.repos.credentials.get(run.tenant.id, ref.id);
    if (!row || row.tenantId !== run.tenant.id) {
      throw new Error('A credential this node uses is not in this workspace, so it was refused');
    }
    if (row.type !== type) {
      throw new Error(`The credential under "${type}" is a "${row.type}" credential`);
    }
    out.push({ type, id: row.id, name: row.name });
  }
  return out;
}

const parameterOptionsTool: AssistantToolDefinition<OptionsInput> = {
  name: 'get_node_parameter_options',
  description:
    'List the live values of a dynamic node parameter (channels, sheets, models, ...) through a credential of this workspace. The values come from an outside service.',
  input: optionsInput,
  minRole: 'editor',
  untrusted: 'node-options',
  async handler(ctx, run, input) {
    const nodeType = ctx.registries.nodeTypes.get(input.nodeType);
    if (!nodeType) throw new Error(`Unknown node type "${input.nodeType}"`);
    let method: OptionsMethod | undefined;
    if (input.parameterPath) {
      const property = findProperty(nodeType.description.properties, input.parameterPath);
      if (!property) throw new Error(`"${input.nodeType}" has no parameter "${input.parameterPath}"`);
      method = methodOf(property);
      if (!method) throw new Error(`The parameter "${input.parameterPath}" has no list of values to load`);
    } else if (input.methodName && input.methodType) {
      method = { kind: input.methodType, method: input.methodName };
    }
    if (!method) throw new Error('Give "parameterPath", or "methodName" with "methodType"');

    const refs: Record<string, { id: string; name: string }> = { ...(input.credentials ?? {}) };
    if (input.credentialId) {
      const row = await ctx.repos.credentials.get(run.tenant.id, input.credentialId);
      if (!row || row.tenantId !== run.tenant.id) {
        throw new Error('The credential is not in this workspace, so it was refused');
      }
      if (input.credentialType && input.credentialType !== row.type) {
        throw new Error(`The credential is a "${row.type}" credential, not "${input.credentialType}"`);
      }
      refs[row.type] = { id: row.id, name: row.name };
    }
    const checked = await tenantCredentials(ctx, run, refs);
    const credentials = Object.fromEntries(checked.map((c) => [c.type, { id: c.id, name: c.name }]));

    const auth: AuthContext = { user: run.user, tenant: run.tenant, role: run.role };
    const result = await loadNodeOptions(ctx, auth, {
      nodeType: input.nodeType,
      method: method.method,
      kind: method.kind,
      node: {
        id: 'assistant-options',
        name: nodeType.description.defaults?.name || nodeType.description.displayName,
        type: input.nodeType,
        typeVersion: input.version,
        position: [0, 0],
        parameters: input.currentNodeParameters ?? {},
        ...(checked.length ? { credentials } : {}),
      },
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
      ...(input.paginationToken !== undefined ? { paginationToken: input.paginationToken } : {}),
    });
    return Array.isArray(result) ? { results: result } : result;
  },
};

// ---------------------------------------------------------------------------------------------------------
// execute_node
// ---------------------------------------------------------------------------------------------------------

const executeNodeInput = z.object({
  type: z.string().trim().min(1).max(256).describe('Full node type name, e.g. "core.httpRequest"'),
  version: z.number().describe('Node type version'),
  config: z.object({
    parameters: z.record(z.string(), z.unknown()).default({}),
    credentials: z
      .record(z.string(), credentialRef)
      .optional()
      .describe('Credentials of this workspace by credential type: { id, name }'),
  }),
  input: z
    .array(z.object({ json: z.record(z.string(), z.unknown()) }))
    .max(MAX_INPUT_ITEMS)
    .optional()
    .describe('Input items; one empty item when left out'),
  timeoutMs: z.number().int().min(1).optional().describe('At most 60000'),
});
type ExecuteNodeInput = z.infer<typeof executeNodeInput>;

/** a scoping value only known at run time: an expression, or a value that is not plain text (a resource locator) */
const UNSCOPED = 'unscoped';

/**
 * A parameter's value as given, else the default of its first declaration shown for `resource`.
 * `unscoped` when the value is an expression or given as anything but text: the input items decide it at
 * run time, so a grant keyed by its text would cover every value.
 */
function resolveValue(
  properties: NodeProperty[],
  parameters: Record<string, unknown>,
  name: string,
  resource?: string,
): { value: string; label: string } | typeof UNSCOPED | undefined {
  const declared = properties.filter((p) => p.name === name && shownFor(p, 'resource', resource));
  if (!declared.length) return undefined;
  const given = parameters[name];
  if (given !== undefined && given !== null && typeof given !== 'string') return UNSCOPED;
  const value = given ?? declared[0]?.default;
  if (isExpression(value)) return UNSCOPED;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const option = declared
    .flatMap((p) => p.options ?? [])
    .find((o) => 'value' in o && (o as { value?: unknown }).value === value);
  return { value, label: option && 'name' in option ? String(option.name) : value };
}

/**
 * The thread grant an approval of this call covers, and the operation's label for the card. Values are
 * URI-encoded, so a `:` in one cannot pose as another part. Null when the key passes 200 characters, and
 * when a value the key uses is an expression (or not plain text): the card then offers approve once only.
 */
export function executeNodeScope(
  nodeType: NodeType,
  parameters: Record<string, unknown>,
): { grantKey: string | null; label: string | null } {
  const type = nodeType.description.name;
  const properties = nodeType.description.properties;
  const resourceFound = resolveValue(properties, parameters, 'resource');
  const resource = resourceFound === UNSCOPED ? undefined : resourceFound;
  const operationFound = resolveValue(properties, parameters, 'operation', resource?.value);
  const operation = operationFound === UNSCOPED ? undefined : operationFound;
  let unscoped = resourceFound === UNSCOPED || operationFound === UNSCOPED;
  const declaresSplit = properties.some((p) => p.name === 'resource' || p.name === 'operation');
  let key = `nodes:execute:${type}`;
  let label: string | null = null;
  if (declaresSplit) {
    key += `:${encodeURIComponent(resource?.value ?? '')}:${encodeURIComponent(operation?.value ?? '')}`;
    label = [resource?.label, operation?.label].filter(Boolean).join(' > ') || null;
  } else {
    for (const name of EXECUTE_NODE_GRANT_FALLBACK) {
      const found = resolveValue(properties, parameters, name);
      if (!found) continue;
      if (found === UNSCOPED) {
        unscoped = true;
        break;
      }
      key += `:${encodeURIComponent(found.value)}`;
      label = found.label;
      break;
    }
  }
  return { grantKey: unscoped || key.length > EXECUTE_NODE_GRANT_MAX ? null : key, label };
}

interface PreparedNode {
  nodeType: NodeType;
  node: WorkflowNode;
  definition: WorkflowDefinition;
  credentials: Array<{ type: string; id: string; name: string }>;
}

/** every check that runs before a card and again before the run */
async function prepareNode(
  ctx: ServerContext,
  run: AssistantRunScope,
  input: ExecuteNodeInput,
): Promise<PreparedNode> {
  const nodeType = ctx.registries.nodeTypes.get(input.type);
  if (!nodeType) throw new Error(`Unknown node type "${input.type}"`);
  const d = nodeType.description;
  const versions = versionsOf(nodeType);
  if (!versions.includes(input.version)) {
    throw new Error(
      `"${input.type}" has no version ${input.version}; the versions are ${versions.join(', ')}`,
    );
  }
  if (d.group?.includes('trigger') || d.polling || nodeType.trigger || nodeType.poll) {
    throw new Error('A trigger node cannot run on its own; run a workflow that starts with it instead');
  }
  if (!nodeType.execute) {
    throw new Error(
      nodeType.webhook
        ? 'A webhook node cannot run on its own'
        : 'This node only runs attached to another node (a sub-node), not on its own',
    );
  }
  const node: WorkflowNode = {
    id: randomUUID(),
    name: d.defaults?.name || d.displayName,
    type: d.name,
    typeVersion: input.version,
    position: [0, 0],
    parameters: input.config.parameters as DataObject,
    ...(input.config.credentials ? { credentials: input.config.credentials } : {}),
  };
  const definition: WorkflowDefinition = { name: 'Assistant node run', nodes: [node], connections: {} };
  // inline workflows in the parameters are checked too
  await assertTenantCredentials(ctx, run.tenant.id, definition);
  const credentials = await tenantCredentials(ctx, run, input.config.credentials ?? {});
  return { nodeType, node, definition, credentials };
}

function nodeFacts(prepared: PreparedNode, input: ExecuteNodeInput, label: string | null) {
  const facts: AssistantApprovalDetails['facts'] = [
    {
      label: 'Node',
      value: `${prepared.nodeType.description.displayName} (${prepared.node.type} v${input.version})`,
    },
  ];
  if (label) facts.push({ label: 'Operation', value: cut(label, FACT_CHARS) });
  for (const c of prepared.credentials) facts.push({ label: 'Credential', value: cut(c.name, FACT_CHARS) });
  facts.push(...parameterFacts(input.config.parameters));
  facts.push({
    label: 'Input items',
    value: input.input?.length ? String(input.input.length) : '1 (empty)',
  });
  facts.push({ label: 'Note', value: 'The node really runs: what it sends or changes happens' });
  return facts;
}

/**
 * Every parameter as its own fact (text as it is, the rest as JSON), redacted whole before it is split
 * into parts the gate keeps, up to `EXECUTE_NODE_PARAMETER_CHARS`; what is left out is counted.
 */
export function parameterFacts(parameters: Record<string, unknown>): AssistantApprovalDetails['facts'] {
  const facts: AssistantApprovalDetails['facts'] = [];
  let left = EXECUTE_NODE_PARAMETER_CHARS;
  let hidden = 0;
  for (const [name, value] of Object.entries(parameters)) {
    let text: string;
    try {
      text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
    } catch {
      text = String(value);
    }
    text = redactSecrets(text);
    const shown = text.slice(0, Math.max(0, left));
    hidden += text.length - shown.length;
    left -= shown.length;
    if (!shown && text) continue;
    const label = `Parameter ${cut(redactSecrets(name), 60)}`;
    const parts = Math.max(1, Math.ceil(shown.length / PARAMETER_PART_CHARS));
    for (let i = 0; i < parts; i++) {
      facts.push({
        label: parts > 1 ? `${label} (${i + 1} of ${parts})` : label,
        value: shown.slice(i * PARAMETER_PART_CHARS, (i + 1) * PARAMETER_PART_CHARS),
      });
    }
  }
  if (hidden > 0) {
    facts.push({ label: 'Parameters cut', value: `${hidden} more characters are not shown on this card` });
  }
  return facts;
}

const executeNodeTool: AssistantToolDefinition<ExecuteNodeInput> = {
  name: 'execute_node',
  description:
    "Run one node on its own with real credentials, parameters and input items, and read its output (to learn its exact output shape or test it). It really runs, so it needs the person's approval. Triggers, webhooks and nodes that wait cannot run this way.",
  input: executeNodeInput,
  minRole: 'editor',
  permission: 'executeNode',
  // the card (or a thread grant) comes from `suspendFor`, so the grant uses the node's defaults
  async suspendFor(ctx, run, input) {
    const prepared = await prepareNode(ctx, run, input);
    const { grantKey, label } = executeNodeScope(prepared.nodeType, input.config.parameters);
    if (grantKey) {
      const thread = await ctx.repos.assistantThreads.get(run.tenant.id, run.user.id, run.threadId);
      if (thread?.grants.includes(grantKey)) return null;
    }
    return {
      inputType: 'approval',
      title: 'Run a node',
      resourceName: `${prepared.nodeType.description.displayName} node`,
      details: {
        facts: nodeFacts(prepared, input, label),
        // the items every `$json` expression reads, so the person sees the real URL, body or id
        ...(input.input?.length ? { preview: approvalPreview(input.input.map((item) => item.json)) } : {}),
      },
      grantKey,
    };
  },
  async handler(ctx, run, input) {
    const prepared = await prepareNode(ctx, run, input);
    const timeoutMs = Math.min(input.timeoutMs ?? EXECUTE_NODE_MAX_MS, EXECUTE_NODE_MAX_MS);
    const items: Item[] = (input.input?.length ? input.input : [{ json: {} }]).map((item) => ({
      json: item.json as DataObject,
    }));
    const outcome = await runAndCollect(
      ctx,
      run,
      { workflow: prepared.definition, startNode: prepared.node.name, triggerItems: items },
      timeoutMs,
    );
    if (outcome.status === 'waiting') {
      await ctx.executions.stop(run.tenant.id, outcome.executionId).catch((error) => {
        ctx.logger.warn(
          { err: error, tenantId: run.tenant.id, executionId: outcome.executionId },
          'Assistant node run could not be stopped',
        );
      });
      return {
        status: 'error',
        error: {
          message:
            'The node started waiting (a Wait node or a send-and-wait operation), which a single node run does not support, so the run was stopped',
        },
      };
    }
    if (outcome.status === 'timedOut') {
      return {
        status: 'error',
        error: {
          message: outcome.aborted
            ? 'The run was stopped'
            : `The node did not finish within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}, so the run was stopped`,
        },
      };
    }
    return previewOutput(outcome, run.sendValues);
  },
};

export const nodesTools: AssistantToolDefinition[] = [
  searchNodesTool,
  getNodeTypesTool,
  parameterOptionsTool,
  executeNodeTool,
];
