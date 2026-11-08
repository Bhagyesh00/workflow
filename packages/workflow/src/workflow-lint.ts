/**
 * Workflow lint (the editor's Workflow Doctor), moved from the editor so the server's builder and
 * MCP tools run the same static checks: port derivation for canvas nodes (static lists,
 * expression-driven ports, AI ports on root nodes, sub-node outputs and the extra error output of
 * `onError: continueErrorOutput`), the connection rules used while dragging cables, the graph walks
 * the checks need, and `lintWorkflow`. The editor re-exports every name (lib/ports.ts, lib/doctor.ts,
 * lib/workflow-ops.ts). Isomorphic: no Node API.
 */
import { evaluateSimple, isExpression, splitTemplate } from './expression/expression';
import { parseExpression } from './expression/interpreter';
import {
  type Connection,
  type Connections,
  type ConnectionType,
  ConnectionTypes,
  type Item,
  type NodeCredentialDescription,
  type NodeInputConfig,
  type NodeOutputConfig,
  type NodeTypeDescription,
  type WorkflowNode,
} from './interfaces';
import { isParameterDisplayed, isResourceLocatorValue, resolveNodeParameters } from './parameters';

// ---------------------------------------------------------------------------------------------
// Ports (from editor lib/ports.ts)
// ---------------------------------------------------------------------------------------------

export type PortDirection = 'in' | 'out';

export interface PortSpec {
  /** React Flow handle id, e.g. `in:main:0` or `out:ai_tool:0` */
  id: string;
  direction: PortDirection;
  type: ConnectionType;
  /** index among ports of the same direction and type: the connection index */
  index: number;
  label?: string;
  required?: boolean;
  maxConnections?: number;
  category?: 'error';
  /** which node types may connect to this port, see `canConnect` */
  filter?: { excludedNodes?: string[]; nodes?: string[] };
}

export interface NodePorts {
  inputs: PortSpec[];
  outputs: PortSpec[];
  /** only non-main outputs: rendered round, output on top */
  isSubNode: boolean;
  isTrigger: boolean;
  /** the node's type, for port filters; `deriveNodePorts` always sets it */
  nodeType?: string;
}

const CONNECTION_TYPE_VALUES = new Set<string>(Object.values(ConnectionTypes));

export const AI_PORT_LABELS: Record<string, string> = {
  ai_languageModel: 'Model',
  ai_tool: 'Tool',
  ai_memory: 'Memory',
  ai_outputParser: 'Output parser',
  ai_embedding: 'Embedding',
  ai_vectorStore: 'Vector store',
  ai_document: 'Document',
  ai_textSplitter: 'Text splitter',
  ai_retriever: 'Retriever',
  ai_reranker: 'Reranker',
};

export function handleId(direction: PortDirection, type: ConnectionType, index: number): string {
  return `${direction}:${type}:${index}`;
}

export function parseHandleId(
  id: string | null | undefined,
): { direction: PortDirection; type: ConnectionType; index: number } | null {
  if (!id) return null;
  const [direction, type, index] = id.split(':');
  if ((direction !== 'in' && direction !== 'out') || !CONNECTION_TYPE_VALUES.has(type)) return null;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) return null;
  return { direction, type: type as ConnectionType, index: n };
}

type RawPort = ConnectionType | NodeInputConfig | NodeOutputConfig;

function isRawPort(value: unknown): value is RawPort {
  if (typeof value === 'string') return CONNECTION_TYPE_VALUES.has(value);
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { type?: unknown }).type === 'string' &&
      CONNECTION_TYPE_VALUES.has((value as { type: string }).type),
  );
}

/**
 * Resolve a static or expression port list. Expressions are evaluated with the sandboxed
 * interpreter against `$parameter` (node values merged with defaults); failures fall back to
 * a single main port so a half-configured node still renders.
 */
export function evaluatePortList(
  spec: NodeTypeDescription['inputs'] | NodeTypeDescription['outputs'],
  parameters: Record<string, unknown>,
): RawPort[] {
  if (Array.isArray(spec)) return spec.filter(isRawPort);
  if (typeof spec !== 'string') return ['main'];
  try {
    const value = evaluateSimple(spec, { $parameter: parameters }, { timeoutMs: 50, maxSteps: 50_000 });
    if (Array.isArray(value)) return value.filter(isRawPort);
  } catch {
    // fall through
  }
  return ['main'];
}

function toSpecs(raw: RawPort[], direction: PortDirection, outputNames?: string[]): PortSpec[] {
  const counters: Partial<Record<ConnectionType, number>> = {};
  return raw.map((port) => {
    const config = typeof port === 'string' ? { type: port } : port;
    const index = counters[config.type] ?? 0;
    counters[config.type] = index + 1;
    const label =
      config.displayName ??
      (config.type === 'main'
        ? direction === 'out'
          ? outputNames?.[index]
          : undefined
        : AI_PORT_LABELS[config.type]);
    return {
      id: handleId(direction, config.type, index),
      direction,
      type: config.type,
      index,
      label,
      required: (config as NodeInputConfig).required,
      maxConnections: (config as NodeInputConfig).maxConnections,
      category: (config as NodeOutputConfig).category,
      filter: (config as NodeInputConfig).filter,
    };
  });
}

export function isTriggerDescription(description: NodeTypeDescription | undefined): boolean {
  if (!description) return false;
  return description.group.includes('trigger') || Boolean(description.polling);
}

export function latestVersion(description: NodeTypeDescription): number {
  return Array.isArray(description.version) ? Math.max(...description.version) : description.version;
}

const portCache = new WeakMap<WorkflowNode, WeakMap<NodeTypeDescription, NodePorts>>();

/** Ports of a node. Memoized per (node object, description object): both are immutable. */
export function deriveNodePorts(node: WorkflowNode, description: NodeTypeDescription | undefined): NodePorts {
  if (!description) {
    // unknown node type: keep whatever is connected visible with one main in/out
    return {
      inputs: [{ id: handleId('in', 'main', 0), direction: 'in', type: 'main', index: 0 }],
      outputs: [{ id: handleId('out', 'main', 0), direction: 'out', type: 'main', index: 0 }],
      isSubNode: false,
      isTrigger: false,
      nodeType: node.type,
    };
  }
  const cached = portCache.get(node)?.get(description);
  if (cached) return cached;

  const needsParams = typeof description.inputs === 'string' || typeof description.outputs === 'string';
  const parameters = needsParams
    ? resolveNodeParameters(description.properties, node.parameters ?? {}, { nodeVersion: node.typeVersion })
    : node.parameters;
  const inputs = toSpecs(evaluatePortList(description.inputs, parameters), 'in');
  const outputs = toSpecs(evaluatePortList(description.outputs, parameters), 'out', description.outputNames);

  if (node.onError === 'continueErrorOutput' && !outputs.some((o) => o.category === 'error')) {
    const index = outputs.filter((o) => o.type === 'main').length;
    outputs.push({
      id: handleId('out', 'main', index),
      direction: 'out',
      type: 'main',
      index,
      label: 'Error',
      category: 'error',
    });
  }

  const ports: NodePorts = {
    inputs,
    outputs,
    isSubNode: outputs.length > 0 && outputs.every((o) => o.type !== 'main'),
    isTrigger: isTriggerDescription(description),
    nodeType: node.type,
  };
  let byDescription = portCache.get(node);
  if (!byDescription) {
    byDescription = new WeakMap();
    portCache.set(node, byDescription);
  }
  byDescription.set(description, ports);
  return ports;
}

// ---------------------------------------------------------------------------------------------
// Connection rules
// ---------------------------------------------------------------------------------------------

export interface ConnectionAttempt {
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
}

/** number of cables already plugged into `target`'s input `type/index` */
export function countInputConnections(
  connections: Connections,
  target: string,
  type: ConnectionType,
  index: number,
): number {
  let count = 0;
  for (const byType of Object.values(connections)) {
    for (const outputs of Object.values(byType)) {
      for (const destinations of outputs ?? []) {
        for (const d of destinations ?? []) {
          if (d.node === target && d.type === type && d.index === index) count++;
        }
      }
    }
  }
  return count;
}

export function connectionExists(
  connections: Connections,
  source: string,
  type: ConnectionType,
  outputIndex: number,
  target: string,
  inputIndex: number,
): boolean {
  return Boolean(
    connections[source]?.[type]?.[outputIndex]?.some((d) => d.node === target && d.index === inputIndex),
  );
}

/** an empty or missing list restricts nothing, as in n8n; a port with no known type fails a real list */
function allowedBy(nodes: string[] | undefined, nodeType: string | undefined): boolean {
  if (!nodes?.length) return true;
  return nodeType !== undefined && nodes.includes(nodeType);
}

/**
 * Whether a cable may be plugged in: output → input, same connection type, no self-loop,
 * no duplicate, the input's `maxConnections` respected and both ports' node type filters passed.
 * `source`/`target` are node names.
 */
export function canConnect(
  attempt: ConnectionAttempt,
  connections: Connections,
  portsOf: (nodeName: string) => NodePorts | undefined,
): boolean {
  if (attempt.source === attempt.target) return false;
  const from = parseHandleId(attempt.sourceHandle);
  const to = parseHandleId(attempt.targetHandle);
  if (!from || !to || from.direction !== 'out' || to.direction !== 'in') return false;
  if (from.type !== to.type) return false;
  const sourcePorts = portsOf(attempt.source);
  const targetPorts = portsOf(attempt.target);
  const output = sourcePorts?.outputs.find((p) => p.id === attempt.sourceHandle);
  if (!output) return false;
  const input = targetPorts?.inputs.find((p) => p.id === attempt.targetHandle);
  if (!input) return false;
  const sourceType = sourcePorts?.nodeType;
  if (sourceType !== undefined && input.filter?.excludedNodes?.includes(sourceType)) return false;
  if (!allowedBy(input.filter?.nodes, sourceType)) return false;
  if (!allowedBy(output.filter?.nodes, targetPorts?.nodeType)) return false;
  if (connectionExists(connections, attempt.source, from.type, from.index, attempt.target, to.index))
    return false;
  if (input.maxConnections !== undefined) {
    if (countInputConnections(connections, attempt.target, to.type, to.index) >= input.maxConnections)
      return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Graph walks (from editor lib/workflow-ops.ts)
// ---------------------------------------------------------------------------------------------

/** the nodes and connections of a workflow, all the lint reads of the editor's graph */
export interface LintGraph {
  nodes: WorkflowNode[];
  connections: Connections;
}

/** one cable as a flat record (the editor re-exports it as `ConnectionRef`) */
export interface GraphConnectionRef {
  source: string;
  sourceType: ConnectionType;
  sourceIndex: number;
  target: string;
  targetType: ConnectionType;
  targetIndex: number;
}

/** Every connection as a flat list (the order is stable: source, type, output, destination). */
export function listConnections(connections: Connections): GraphConnectionRef[] {
  const result: GraphConnectionRef[] = [];
  for (const [source, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      (outputs ?? []).forEach((dests, sourceIndex) => {
        for (const d of dests ?? []) {
          result.push({
            source,
            sourceType: type,
            sourceIndex,
            target: d.node,
            targetType: d.type,
            targetIndex: d.index,
          });
        }
      });
    }
  }
  return result;
}

/** Immediate main parents of `name`, ordered by input index. */
export function getMainParents(
  connections: Connections,
  name: string,
): Array<{ node: string; outputIndex: number; inputIndex: number }> {
  return listConnections(connections)
    .filter((c) => c.target === name && c.targetType === 'main')
    .map((c) => ({ node: c.source, outputIndex: c.sourceIndex, inputIndex: c.targetIndex }))
    .sort((a, b) => a.inputIndex - b.inputIndex);
}

/** All ancestors reachable through main connections, nearest first. */
export function getAncestors(connections: Connections, name: string): string[] {
  const all = listConnections(connections).filter((c) => c.targetType === 'main');
  const result: string[] = [];
  const seen = new Set([name]);
  let frontier = [name];
  while (frontier.length) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const c of all) {
        if (c.target !== n || seen.has(c.source)) continue;
        seen.add(c.source);
        result.push(c.source);
        next.push(c.source);
      }
    }
    frontier = next;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Sticky notes and pinned data
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Workflow Doctor (from editor lib/doctor.ts): static checks that run while you edit, so problems
// show up before a run fails or activation is refused. Each finding points at a node when it can.
// ---------------------------------------------------------------------------------------------

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface DoctorIssue {
  id: string;
  severity: IssueSeverity;
  node?: string;
  message: string;
  hint?: string;
  /** a stable check name (the builder's lint sets it, for example `non-tool-node-uses-fromai`) */
  code?: string;
}

/**
 * Credential slots a node needs beyond `description.credentials`: every displayed `credentialsSelect`
 * parameter with a value names the credential type to attach (for example HTTP Request with a
 * predefined credential type).
 */
export function selectedCredentialSlots(
  description: NodeTypeDescription,
  params: Record<string, unknown>,
  nodeVersion: number,
): NodeCredentialDescription[] {
  const slots: NodeCredentialDescription[] = [];
  for (const prop of description.properties) {
    if (prop.type !== 'credentialsSelect') continue;
    if (!isParameterDisplayed(prop.displayOptions, params, { nodeVersion, rootParams: params })) continue;
    const value = params[prop.name];
    if (typeof value !== 'string' || !value || isExpression(value)) continue;
    if (!slots.some((s) => s.name === value)) slots.push({ name: value, required: true });
  }
  return slots;
}

/**
 * Credential slots of one node as the editor shows them: the declared credentials that pass their
 * displayOptions, plus the slots named by displayed `credentialsSelect` parameters. A declared
 * credential that is hidden (for example a generic auth type while a predefined type is chosen)
 * does not hide the slot the select asks for.
 */
export function nodeCredentialSlots(
  description: NodeTypeDescription,
  params: Record<string, unknown>,
  nodeVersion: number,
): NodeCredentialDescription[] {
  const declared = (description.credentials ?? []).filter((c) =>
    isParameterDisplayed(c.displayOptions, params, { nodeVersion, rootParams: params }),
  );
  const dynamic = selectedCredentialSlots(description, params, nodeVersion).filter(
    (s) => !declared.some((d) => d.name === s.name),
  );
  return [...declared, ...dynamic];
}

export interface DoctorInput extends LintGraph {
  pinData?: Record<string, Item[]>;
  active?: boolean;
}

export interface DescriptionLookup {
  get(type: string): NodeTypeDescription | undefined;
}

const REFERENCE_PATTERNS = [
  /\$\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/g,
  /\$node\[\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\]/g,
  /\$items\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
];

/** Node names referenced by `$('Name')`, `$node["Name"]` and `$items("Name")` in one string. */
export function referencedNodes(expression: string): string[] {
  const names = new Set<string>();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of expression.matchAll(pattern)) names.add(match[2].replace(/\\(.)/g, '$1'));
  }
  return [...names];
}

/** Every expression string inside a parameter tree, with its dotted path. */
export function collectExpressions(value: unknown, path = ''): Array<{ path: string; expression: string }> {
  if (isExpression(value)) return [{ path, expression: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => collectExpressions(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => collectExpressions(v, path ? `${path}.${k}` : k));
  }
  return [];
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (isResourceLocatorValue(value)) return value.value === '' || value.value === undefined;
  return false;
}

function prettyPath(path: string): string {
  return path.replace(/\[(\d+)\]/g, ' #$1').replace(/\./g, ' › ');
}

export function lintWorkflow(input: DoctorInput, types: DescriptionLookup): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const push = (issue: Omit<DoctorIssue, 'id'>) =>
    issues.push({ ...issue, id: `${issue.severity}:${issue.node ?? '-'}:${issues.length}` });
  const names = new Set(input.nodes.map((n) => n.name));
  const connections = listConnections(input.connections);
  const counts = new Map<string, number>();
  const webhookRoutes = new Map<string, string>();
  let triggers = 0;

  for (const node of input.nodes) {
    const description = types.get(node.type);
    if (!description) {
      push({
        severity: 'error',
        node: node.name,
        message: `Uses the node type "${node.type}", which is not installed`,
        hint: 'Replace the node or install the package that provides it.',
      });
      continue;
    }
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    const ports = deriveNodePorts(node, description);
    if (ports.isTrigger && !node.disabled) triggers++;
    const params = resolveNodeParameters(description.properties, node.parameters ?? {}, {
      nodeVersion: node.typeVersion,
    });

    // required parameters
    for (const prop of description.properties) {
      if (!prop.required || prop.isNodeSetting) continue;
      if (
        !isParameterDisplayed(prop.displayOptions, params, {
          nodeVersion: node.typeVersion,
          rootParams: params,
        })
      ) {
        continue;
      }
      if (isEmptyValue(params[prop.name])) {
        push({ severity: 'error', node: node.name, message: `"${prop.displayName}" is required` });
      }
    }

    // credentials
    for (const cred of nodeCredentialSlots(description, params, node.typeVersion)) {
      if (!cred.required) continue;
      if (!node.credentials?.[cred.name]?.id) {
        push({
          severity: 'error',
          node: node.name,
          message: `Needs a "${cred.name}" credential`,
          hint: 'Open the node and select or create a credential.',
        });
      }
    }

    // expressions: syntax and references
    const ancestors = new Set(getAncestors(input.connections, node.name));
    if (ports.isSubNode) {
      // sub-nodes see the data of the root node they are attached to
      for (const c of connections) {
        if (c.source !== node.name) continue;
        ancestors.add(c.target);
        for (const a of getAncestors(input.connections, c.target)) ancestors.add(a);
      }
    }
    for (const { path, expression } of collectExpressions(node.parameters ?? {})) {
      for (const segment of splitTemplate(expression.slice(1))) {
        if (segment.type !== 'code' || !segment.value.trim()) continue;
        try {
          parseExpression(segment.value);
        } catch (error) {
          push({
            severity: 'error',
            node: node.name,
            message: `Expression in "${prettyPath(path)}" does not parse`,
            hint: (error as Error).message,
          });
        }
      }
      for (const ref of referencedNodes(expression)) {
        if (!names.has(ref)) {
          push({
            severity: 'error',
            node: node.name,
            message: `"${prettyPath(path)}" refers to "${ref}", which does not exist`,
            hint: 'Rename the reference or restore the node.',
          });
        } else if (ref !== node.name && !ancestors.has(ref)) {
          push({
            severity: 'warning',
            node: node.name,
            message: `"${prettyPath(path)}" reads from "${ref}", which is not upstream of this node`,
            hint: 'Its data is only available when it ran earlier in the same execution.',
          });
        }
      }
    }

    // wiring
    const incoming = connections.filter((c) => c.target === node.name);
    const outgoing = connections.filter((c) => c.source === node.name);
    const hasMainInput = ports.inputs.some((p) => p.type === 'main');
    if (
      !ports.isTrigger &&
      !ports.isSubNode &&
      hasMainInput &&
      !incoming.some((c) => c.targetType === 'main')
    ) {
      push({
        severity: 'warning',
        node: node.name,
        message: 'Has no input connection, so it will never run',
        hint: 'Connect it to a trigger or to a previous node.',
      });
    }
    if (ports.isSubNode && outgoing.length === 0) {
      push({ severity: 'warning', node: node.name, message: 'Is not attached to a root node' });
    }
    for (const port of ports.inputs) {
      if (!port.required) continue;
      if (!incoming.some((c) => c.targetType === port.type && c.targetIndex === port.index)) {
        push({
          severity: 'error',
          node: node.name,
          message: `Needs a "${port.label ?? port.type}" connection`,
        });
      }
    }

    // webhook routes must be unique per method
    if (description.webhooks?.length && !node.disabled) {
      for (const webhook of description.webhooks) {
        try {
          const method = String(
            evaluateSimple(webhook.httpMethod, { $parameter: params }) || 'GET',
          ).toUpperCase();
          const path = String(evaluateSimple(webhook.path, { $parameter: params }) ?? '')
            .trim()
            .replace(/^\/+|\/+$/g, '');
          if (!path) continue; // defaults to the node's unique webhookId
          const key = `${method} ${path}`;
          const other = webhookRoutes.get(key);
          if (other) {
            push({
              severity: 'error',
              node: node.name,
              message: `Listens on ${method} /${path}, which "${other}" already uses`,
            });
          } else webhookRoutes.set(key, node.name);
        } catch {
          // path expressions that need run data cannot be checked statically
        }
      }
    }
  }

  for (const [type, count] of counts) {
    const max = types.get(type)?.maxNodes;
    if (max !== undefined && count > max) {
      const description = types.get(type)!;
      push({
        severity: 'error',
        message: `"${description.displayName}" can be used ${max === 1 ? 'once' : `${max} times`} per workflow, found ${count}`,
      });
    }
  }

  if (input.nodes.length && triggers === 0) {
    push({
      severity: 'info',
      message: 'There is no trigger yet',
      hint: 'Add a trigger to start the workflow on a schedule, a webhook or an app event.',
    });
  }

  const pinned = Object.keys(input.pinData ?? {}).filter((n) => names.has(n));
  if (input.active && pinned.length) {
    push({
      severity: 'info',
      message: `${pinned.length === 1 ? `"${pinned[0]}" has` : `${pinned.length} nodes have`} pinned data`,
      hint: 'Pinned data only replaces node output in manual runs; production runs execute the node.',
    });
  }

  const rank: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function issuesByNode(issues: DoctorIssue[]): Map<string, DoctorIssue[]> {
  const map = new Map<string, DoctorIssue[]>();
  for (const issue of issues) {
    if (!issue.node) continue;
    const list = map.get(issue.node) ?? [];
    list.push(issue);
    map.set(issue.node, list);
  }
  return map;
}
