/**
 * Port derivation for canvas nodes: static lists, expression-driven (dynamic) ports, AI ports on
 * root nodes, sub-node outputs and the extra error output of `onError: continueErrorOutput`.
 * Also the connection rules used while dragging cables.
 */
import {
  type Connections,
  type ConnectionType,
  ConnectionTypes,
  evaluateSimple,
  type NodeInputConfig,
  type NodeOutputConfig,
  type NodeTypeDescription,
  resolveNodeParameters,
  type WorkflowNode,
} from '@workflow/workflow';

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
