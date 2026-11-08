/**
 * Lint for the AI builder and the MCP builder tools: `lintWorkflow` plus the builder's own checks. Every
 * issue carries a stable `code` (n8n's check names where n8n has the check), so a model gets the same
 * name for the same problem on every attempt. `lintWorkflow` itself stays unchanged (the Doctor is the
 * same). A missing credential is only `info` here: the builder never sets credentials, the editor fills
 * one of the right type when the user accepts the draft. Isomorphic: no Node API.
 */
import { isExpression } from './expression/expression';
import { extractFromAiArguments } from './from-ai';
import type {
  ConnectionType,
  NodeProperty,
  NodePropertyOption,
  NodeTypeDescription,
  WorkflowNode,
} from './interfaces';
import { isParameterDisplayed, resolveNodeParameters } from './parameters';
import {
  type DescriptionLookup,
  type DoctorInput,
  type DoctorIssue,
  deriveNodePorts,
  getMainParents,
  type IssueSeverity,
  lintWorkflow,
  listConnections,
  type NodePorts,
} from './workflow-lint';

const AGENT_TYPE = 'ai.agent';
const MERGE_TYPE = 'core.merge';
const SET_TYPES = new Set(['core.set', 'core.setTool']);
const HTTP_TYPES = new Set(['core.httpRequest', 'core.httpRequestTool']);
const DATA_TABLE_TYPES = new Set(['core.dataTable', 'core.dataTableTool']);
const RESPOND_TYPE = 'core.respondToWebhook';
const DATA_TABLE_WRITES = new Set(['insert', 'update', 'upsert']);

/** header or query names that carry a secret when filled with a fixed value */
const SECRET_HEADER =
  /^(authorization|proxy-authorization|x-api-key|api[-_]?key|apikey|x-auth-token|auth[-_]?token|access[-_]?token|token|secret|client[-_]?secret|password)$/i;
/** field names of a Set node that look like a credential */
const SECRET_FIELD = /(password|passwd|secret|api[-_]?key|apikey|token|credential|private[-_]?key)/i;

/** the code each `lintWorkflow` message gets; unmatched issues keep no code */
const BASE_CODES: Array<{ match: RegExp; code: string; severity?: IssueSeverity; hint?: string }> = [
  { match: /^Uses the node type ".*", which is not installed$/, code: 'node-type-not-found' },
  { match: /^".*" is required$/, code: 'node-missing-required-parameter' },
  {
    match: /^Needs a ".*" credential$/,
    code: 'node-missing-credentials',
    severity: 'info',
    hint: 'Leave credentials out: the editor fills in one of this type when the user accepts the draft.',
  },
  { match: /^Needs a ".*" connection$/, code: 'node-missing-required-input' },
  { match: /^Is not attached to a root node$/, code: 'sub-node-not-connected' },
  { match: / per workflow, found \d+$/, code: 'workflow-exceeds-max-nodes-limit' },
  { match: /^There is no trigger yet$/, code: 'workflow-has-no-trigger', severity: 'warning' },
  { match: /^Has no input connection, so it will never run$/, code: 'node-not-connected' },
  { match: /^Expression in ".*" does not parse$/, code: 'expression-syntax' },
  { match: /^".*" refers to ".*", which does not exist$/, code: 'expression-unknown-node' },
  { match: /^".*" reads from ".*", which is not upstream of this node$/, code: 'expression-not-upstream' },
  { match: /^Listens on .*, which ".*" already uses$/, code: 'webhook-path-conflict' },
  { match: /pinned data$/, code: 'pinned-data-active' },
];

function withCode(issue: DoctorIssue): DoctorIssue {
  const rule = BASE_CODES.find((r) => r.match.test(issue.message));
  if (!rule) return issue;
  return {
    ...issue,
    code: rule.code,
    ...(rule.severity ? { severity: rule.severity } : {}),
    ...(rule.hint ? { hint: rule.hint } : {}),
  };
}

function isOption(value: unknown): value is NodePropertyOption {
  return Boolean(value && typeof value === 'object' && 'value' in value && !('type' in value));
}

/** the values an `options` / `multiOptions` property allows; undefined when they load at run time */
function allowedValues(prop: NodeProperty): Set<unknown> | undefined {
  if (prop.typeOptions?.loadOptionsMethod) return undefined;
  const options = (prop.options ?? []).filter(isOption);
  if (!options.length) return undefined;
  return new Set(options.map((o) => o.value));
}

function hasOutput(ports: NodePorts, type: ConnectionType): boolean {
  return ports.outputs.some((p) => p.type === type);
}

function isFilled(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null;
}

/** name/value pairs of a fixedCollection `{ parameters: [{ name, value }] }` */
function namedPairs(value: unknown): Array<{ name: string; value: unknown }> {
  const list = (value as { parameters?: unknown } | undefined)?.parameters;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is { name: unknown; value: unknown } => Boolean(p && typeof p === 'object'))
    .map((p) => ({ name: String(p.name ?? ''), value: p.value }));
}

/** the builder's own checks on one node; `push` adds an issue */
function nodeChecks(
  node: WorkflowNode,
  description: NodeTypeDescription,
  ports: NodePorts,
  input: DoctorInput,
  push: (issue: Omit<DoctorIssue, 'id'>) => void,
): void {
  const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
    nodeVersion: node.typeVersion,
  });
  const shown = (prop: NodeProperty) =>
    isParameterDisplayed(prop.displayOptions, params, { nodeVersion: node.typeVersion, rootParams: params });

  // node-invalid-options-value: a fixed value that is not one of the options
  for (const prop of description.properties) {
    if (prop.type !== 'options' && prop.type !== 'multiOptions') continue;
    if (!shown(prop)) continue;
    const allowed = allowedValues(prop);
    const raw = node.parameters?.[prop.name];
    if (!allowed || raw === undefined || isExpression(raw)) continue;
    const values = prop.type === 'multiOptions' && Array.isArray(raw) ? raw : [raw];
    const bad = values.filter((v) => !isExpression(v) && !allowed.has(v as string));
    if (bad.length) {
      push({
        severity: 'error',
        node: node.name,
        code: 'node-invalid-options-value',
        message: `"${prop.displayName}" has the value ${JSON.stringify(bad[0])}, which is not one of its options`,
        hint: `Use one of: ${[...allowed].map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }
  }

  // non-tool-node-uses-fromai: $fromAI only works in a node an agent calls as a tool
  const isTool = hasOutput(ports, 'ai_tool');
  if (!isTool && extractFromAiArguments(node.parameters ?? {}).length) {
    push({
      severity: 'error',
      node: node.name,
      code: 'non-tool-node-uses-fromai',
      message: 'Uses $fromAI, which only works in a node connected to an agent as a tool',
      hint: 'Use the tool version of this node on the agent, or replace $fromAI with an expression.',
    });
  }

  // tool-node-has-no-parameters
  if (isTool && !ports.isTrigger) {
    const settable = description.properties.filter(
      (p) =>
        !p.isNodeSetting && p.type !== 'notice' && p.type !== 'hidden' && p.type !== 'button' && shown(p),
    );
    if (settable.length && Object.keys(node.parameters ?? {}).length === 0) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'tool-node-has-no-parameters',
        message: 'Is a tool with no parameters set',
        hint: 'Set what the tool does, and use $fromAI for the values the agent chooses.',
      });
    }
  }

  // agent prompt checks
  if (node.type === AGENT_TYPE) {
    const text = node.parameters?.text;
    if (params.promptType === 'define' && typeof text === 'string' && text.trim() && !isExpression(text)) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'agent-static-prompt',
        message: 'Has a fixed prompt, so every run sends the same message',
        hint: 'Map the prompt from the incoming data with an expression, for example {{ $json.text }}.',
      });
    }
    const system = node.parameters?.systemMessage;
    if (system === undefined || (typeof system === 'string' && !system.trim())) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'agent-no-system-prompt',
        message: 'Has no system message',
        hint: 'Set the system message to tell the agent its role and rules.',
      });
    }
  }

  // http-request-hardcoded-credentials
  if (HTTP_TYPES.has(node.type)) {
    // raw values: a header list the description does not spell out still counts
    const raw = node.parameters ?? {};
    const pairs = [...namedPairs(raw.headerParameters), ...namedPairs(raw.queryParameters)];
    const secret = pairs.find(
      (p) => SECRET_HEADER.test(p.name.trim()) && isFilled(p.value) && !isExpression(p.value),
    );
    if (secret) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'http-request-hardcoded-credentials',
        message: `Sends "${secret.name}" as a fixed value`,
        hint: 'Use a credential under Authentication instead of a header or query value.',
      });
    }
  }

  // set-node-credential-field
  if (SET_TYPES.has(node.type)) {
    const list = (params.assignments as { assignments?: unknown } | undefined)?.assignments;
    const fields = Array.isArray(list) ? (list as Array<{ name?: unknown; value?: unknown }>) : [];
    const secret = fields.find(
      (f) => SECRET_FIELD.test(String(f?.name ?? '')) && isFilled(f?.value) && !isExpression(f?.value),
    );
    if (secret) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'set-node-credential-field',
        message: `Sets "${String(secret.name)}" to a fixed value that looks like a secret`,
        hint: 'Keep secrets in credentials, never in node fields.',
      });
    }
  }

  // data-table-missing-set-node
  if (
    DATA_TABLE_TYPES.has(node.type) &&
    params.resource === 'row' &&
    DATA_TABLE_WRITES.has(String(params.operation))
  ) {
    const parents = getMainParents(input.connections, node.name);
    const byName = new Map(input.nodes.map((n) => [n.name, n]));
    if (!parents.some((p) => SET_TYPES.has(byName.get(p.node)?.type ?? ''))) {
      push({
        severity: 'warning',
        node: node.name,
        code: 'data-table-missing-set-node',
        message: 'Writes rows without an Edit Fields (Set) node before it',
        hint: 'Shape each row with an Edit Fields (Set) node so the columns match the table.',
      });
    }
  }

  // webhook response: "Using Respond to Webhook node" needs one
  if (description.webhooks?.length && !node.disabled && params.responseMode === 'responseNode') {
    const hasRespond = input.nodes.some((n) => n.type === RESPOND_TYPE && !n.disabled);
    if (!hasRespond) {
      push({
        severity: 'error',
        node: node.name,
        code: 'webhook-response-node-missing',
        message: 'Responds "Using Respond to Webhook node", but the workflow has none',
        hint: 'Add a Respond to Webhook node after it, or change the response mode.',
      });
    }
  }
}

/** connection checks: every cable lands on an input that accepts it */
function connectionChecks(
  input: DoctorInput,
  portsOf: (name: string) => NodePorts | undefined,
  push: (issue: Omit<DoctorIssue, 'id'>) => void,
): void {
  const connections = listConnections(input.connections);
  for (const c of connections) {
    const source = portsOf(c.source);
    const target = portsOf(c.target);
    if (!source || !target) continue;
    const output = source.outputs.find((p) => p.type === c.sourceType && p.index === c.sourceIndex);
    const port = target.inputs.find((p) => p.type === c.targetType && p.index === c.targetIndex);
    const filtered =
      port &&
      ((source.nodeType !== undefined && port.filter?.excludedNodes?.includes(source.nodeType)) ||
        (port.filter?.nodes?.length && !port.filter.nodes.includes(source.nodeType ?? '')));
    if (!output || !port || c.sourceType !== c.targetType || filtered) {
      push({
        severity: 'error',
        node: c.target,
        code: 'node-unsupported-connection-input',
        message: `Gets a "${c.targetType}" connection from "${c.source}" that it does not accept`,
        hint: 'Connect the node to an input of the same type, or remove the connection.',
      });
    }
  }
  // inputs that take one connection at most
  for (const node of input.nodes) {
    const ports = portsOf(node.name);
    for (const port of ports?.inputs ?? []) {
      if (port.maxConnections === undefined) continue;
      const count = connections.filter(
        (c) => c.target === node.name && c.targetType === port.type && c.targetIndex === port.index,
      ).length;
      if (count > port.maxConnections) {
        push({
          severity: 'error',
          node: node.name,
          code: 'node-unsupported-connection-input',
          message: `Has ${count} "${port.label ?? port.type}" connections, but takes ${port.maxConnections}`,
        });
      }
    }
  }
}

/** a Merge node needs every input connected */
function mergeChecks(
  node: WorkflowNode,
  ports: NodePorts,
  input: DoctorInput,
  push: (issue: Omit<DoctorIssue, 'id'>) => void,
): void {
  if (node.type !== MERGE_TYPE || node.disabled) return;
  const inputs = ports.inputs.filter((p) => p.type === 'main');
  const connected = new Set(
    listConnections(input.connections)
      .filter((c) => c.target === node.name && c.targetType === 'main')
      .map((c) => c.targetIndex),
  );
  if (connected.size === 1) {
    push({
      severity: 'warning',
      node: node.name,
      code: 'node-merge-single-input',
      message: 'Has only one input connected, so there is nothing to merge',
      hint: 'Connect a second branch, or remove the Merge node.',
    });
    return;
  }
  const missing = inputs.filter((p) => !connected.has(p.index));
  if (connected.size > 1 && missing.length) {
    push({
      severity: 'warning',
      node: node.name,
      code: 'node-merge-missing-input',
      message: `Has no connection on ${missing.map((p) => `"${p.label ?? `Input ${p.index + 1}`}"`).join(', ')}`,
      hint: 'Connect every input, or lower the number of inputs.',
    });
  }
}

export function lintForBuilder(input: DoctorInput, types: DescriptionLookup): DoctorIssue[] {
  const issues: DoctorIssue[] = lintWorkflow(input, types).map(withCode);
  const push = (issue: Omit<DoctorIssue, 'id'>) =>
    issues.push({ ...issue, id: `${issue.severity}:${issue.node ?? '-'}:${issue.code}:${issues.length}` });

  if (input.nodes.length === 0) {
    push({
      severity: 'error',
      code: 'workflow-has-no-nodes',
      message: 'The workflow has no nodes',
      hint: 'Add a trigger and the nodes that do the work.',
    });
  }

  const portCache = new Map<string, NodePorts | undefined>();
  const byName = new Map(input.nodes.map((n) => [n.name, n]));
  const portsOf = (name: string): NodePorts | undefined => {
    if (portCache.has(name)) return portCache.get(name);
    const node = byName.get(name);
    const description = node ? types.get(node.type) : undefined;
    const ports = node && description ? deriveNodePorts(node, description) : undefined;
    portCache.set(name, ports);
    return ports;
  };

  for (const node of input.nodes) {
    const description = types.get(node.type);
    const ports = portsOf(node.name);
    if (!description || !ports) continue;
    nodeChecks(node, description, ports, input, push);
    mergeChecks(node, ports, input, push);
  }
  connectionChecks(input, portsOf, push);

  // a Respond to Webhook node answers nothing without a webhook set to wait for it
  const respond = input.nodes.filter((n) => n.type === RESPOND_TYPE && !n.disabled);
  if (respond.length) {
    const waits = input.nodes.some((n) => {
      const description = types.get(n.type);
      if (!description?.webhooks?.length || n.disabled) return false;
      const params = resolveNodeParameters(description.properties, n.parameters ?? {}, {
        nodeVersion: n.typeVersion,
      });
      return params.responseMode === 'responseNode';
    });
    if (!waits) {
      push({
        severity: 'warning',
        node: respond[0].name,
        code: 'respond-to-webhook-without-webhook',
        message: 'Answers a webhook, but no webhook waits for a Respond to Webhook node',
        hint: 'Set the webhook\'s response mode to "Using Respond to Webhook node".',
      });
    }
  }

  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
