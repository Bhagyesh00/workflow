import { WorkflowOperationError } from './errors';
import { evaluateSimple } from './expression/expression';
import type {
  Connection,
  Connections,
  ConnectionType,
  DataObject,
  NodeInputConfig,
  NodeOutputConfig,
  NodeTypeDescription,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowSettings,
} from './interfaces';
import type { NodeType } from './node-types';

export interface NodeTypeLookup {
  get(type: string): NodeType | undefined;
}

/** connectionsByDestination[destNode][type][inputIndex] = sources */
export type DestinationConnections = Record<string, Partial<Record<ConnectionType, Connection[][]>>>;

export function invertConnections(connections: Connections): DestinationConnections {
  const result: DestinationConnections = {};
  for (const [sourceNode, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      outputs?.forEach((destinations, outputIndex) => {
        for (const dest of destinations ?? []) {
          const nodeEntry = (result[dest.node] ??= {});
          const inputs = (nodeEntry[dest.type] ??= []);
          while (inputs.length <= dest.index) inputs.push([]);
          inputs[dest.index].push({ node: sourceNode, type, index: outputIndex });
        }
      });
    }
  }
  return result;
}

/** Wrapper around a workflow definition with graph helpers. */
export class Workflow {
  readonly id?: string;
  readonly name: string;
  readonly nodes: Record<string, WorkflowNode> = {};
  readonly connectionsBySource: Connections;
  readonly connectionsByDestination: DestinationConnections;
  readonly settings: WorkflowSettings;
  readonly staticData: DataObject;
  readonly active: boolean;

  constructor(
    readonly definition: WorkflowDefinition,
    readonly nodeTypes: NodeTypeLookup,
  ) {
    this.id = definition.id;
    this.name = definition.name;
    this.active = definition.active ?? false;
    for (const node of definition.nodes) {
      if (this.nodes[node.name]) {
        throw new WorkflowOperationError(`Duplicate node name "${node.name}"`);
      }
      this.nodes[node.name] = node;
    }
    this.connectionsBySource = definition.connections ?? {};
    this.connectionsByDestination = invertConnections(this.connectionsBySource);
    this.settings = definition.settings ?? {};
    this.staticData = definition.staticData ?? {};
  }

  getNode(name: string): WorkflowNode | undefined {
    return this.nodes[name];
  }

  getNodeType(node: WorkflowNode): NodeType {
    const type = this.nodeTypes.get(node.type);
    if (!type) throw new WorkflowOperationError(`Unknown node type "${node.type}" (node "${node.name}")`);
    return type;
  }

  isTriggerNode(node: WorkflowNode): boolean {
    const type = this.nodeTypes.get(node.type);
    if (!type) return false;
    return Boolean(type.trigger || type.poll || type.webhook) || type.description.group.includes('trigger');
  }

  /** nodes connected as direct or transitive parents via `type` */
  getParentNodes(name: string, type: ConnectionType | 'ALL' = 'main', depth = -1): string[] {
    return this.walk(name, type, depth, (n, t) => {
      const byType = this.connectionsByDestination[n];
      if (!byType) return [];
      const types = t === 'ALL' ? (Object.keys(byType) as ConnectionType[]) : [t];
      return types.flatMap((ct) => (byType[ct] ?? []).flat().map((c) => c.node));
    });
  }

  getChildNodes(name: string, type: ConnectionType | 'ALL' = 'main', depth = -1): string[] {
    return this.walk(name, type, depth, (n, t) => {
      const byType = this.connectionsBySource[n];
      if (!byType) return [];
      const types = t === 'ALL' ? (Object.keys(byType) as ConnectionType[]) : [t];
      return types.flatMap((ct) => (byType[ct] ?? []).flatMap((d) => (d ?? []).map((c) => c.node)));
    });
  }

  private walk(
    start: string,
    type: ConnectionType | 'ALL',
    depth: number,
    next: (node: string, type: ConnectionType | 'ALL') => string[],
  ): string[] {
    const result: string[] = [];
    const seen = new Set<string>([start]);
    let frontier = [start];
    let level = 0;
    while (frontier.length && (depth === -1 || level < depth)) {
      const following: string[] = [];
      for (const n of frontier) {
        for (const parent of next(n, type)) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          result.push(parent);
          following.push(parent);
        }
      }
      frontier = following;
      level++;
    }
    return result;
  }

  /** nodes that feed `name` through non-main (AI) connections of `type` */
  getSubNodes(name: string, type: ConnectionType): WorkflowNode[] {
    const inputs = this.connectionsByDestination[name]?.[type] ?? [];
    return inputs
      .flat()
      .map((c) => this.nodes[c.node])
      .filter((n): n is WorkflowNode => Boolean(n) && !n.disabled);
  }

  /** nodes that feed `name` through `type`, one entry per connection index; an empty slot keeps its index */
  getSubNodesBySlot(name: string, type: ConnectionType): WorkflowNode[][] {
    const inputs = this.connectionsByDestination[name]?.[type] ?? [];
    return inputs.map((slot) =>
      slot.map((c) => this.nodes[c.node]).filter((n): n is WorkflowNode => Boolean(n) && !n.disabled),
    );
  }

  /** main-input sources of `name`, by input index */
  getMainInputs(name: string): Connection[][] {
    return this.connectionsByDestination[name]?.main ?? [];
  }

  /** number of main inputs declared by the node type (expression-based inputs resolved to their count) */
  getMainInputCount(node: WorkflowNode): number {
    const description = this.nodeTypes.get(node.type)?.description;
    const connected = this.getMainInputs(node.name).length;
    if (!description) return Math.max(1, connected);
    const declared = resolvePorts(description.inputs, node, evaluatePortExpression).filter(
      (p) => portType(p) === 'main',
    ).length;
    return Math.max(declared, connected);
  }

  getTriggerNodes(): WorkflowNode[] {
    // a tool variant keeps the `webhook` of the node it copies, but only its agent can run it
    return Object.values(this.nodes).filter(
      (n) => !n.disabled && this.isTriggerNode(n) && !this.isSubNode(n),
    );
  }

  /**
   * The node an execution should start from: the given trigger, otherwise the first
   * enabled trigger, otherwise the first node without main inputs.
   */
  getStartNode(preferred?: string): WorkflowNode | undefined {
    if (preferred && this.nodes[preferred]) return this.nodes[preferred];
    const triggers = this.getTriggerNodes();
    if (triggers.length) return sortByPosition(triggers)[0];
    const roots = Object.values(this.nodes).filter(
      (n) => !n.disabled && this.getMainInputs(n.name).flat().length === 0 && !this.isSubNode(n),
    );
    return sortByPosition(roots)[0];
  }

  /** a node whose only outputs are non-main (AI sub-node) */
  isSubNode(node: WorkflowNode): boolean {
    const description = this.nodeTypes.get(node.type)?.description;
    if (!description) return false;
    const outputs = resolvePorts(description.outputs, node, evaluatePortExpression);
    return outputs.length > 0 && outputs.every((p) => portType(p) !== 'main');
  }
}

/** evaluate an inputs/outputs expression against the node's raw parameters */
export function evaluatePortExpression(expression: string, parameters: DataObject): unknown {
  try {
    return evaluateSimple(expression, { $parameter: parameters });
  } catch {
    return undefined;
  }
}

export function portType(port: ConnectionType | NodeInputConfig | NodeOutputConfig): ConnectionType {
  return typeof port === 'string' ? port : port.type;
}

/**
 * Inputs/outputs may be a static list or an expression string evaluated against
 * the node parameters. Without an expression evaluator (cheap path) we support the
 * conventions `numberInputs` / `numberOutputs` and rules-based outputs.
 */
export function resolvePorts(
  ports: NodeTypeDescription['inputs'] | NodeTypeDescription['outputs'],
  node: WorkflowNode,
  evaluate?: (expression: string, parameters: DataObject) => unknown,
): Array<ConnectionType | NodeInputConfig | NodeOutputConfig> {
  if (Array.isArray(ports)) return ports;
  if (evaluate) {
    const value = evaluate(ports, node.parameters);
    if (Array.isArray(value)) return value as Array<ConnectionType | NodeInputConfig>;
  }
  return ['main'];
}

export function sortByPosition<T extends { position: [number, number] }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => a.position[1] - b.position[1] || a.position[0] - b.position[0]);
}

/** Rename a node and update connections plus `$('Name')` / `$node["Name"]` references. */
export function renameNodeInDefinition(
  definition: WorkflowDefinition,
  oldName: string,
  newName: string,
): WorkflowDefinition {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`(\\$\\(\\s*['"\`])${escaped}(['"\`]\\s*\\))`, 'g'),
    new RegExp(`(\\$node\\[\\s*['"\`])${escaped}(['"\`]\\s*\\])`, 'g'),
    new RegExp(`(\\$items\\(\\s*['"\`])${escaped}(['"\`])`, 'g'),
  ];
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!value.startsWith('=') && !value.includes('$(')) return value;
      return patterns.reduce((acc, re) => acc.replace(re, `$1${newName}$2`), value);
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    }
    return value;
  };

  const nodes = definition.nodes.map((n) => ({
    ...n,
    name: n.name === oldName ? newName : n.name,
    parameters: rewrite(n.parameters) as WorkflowNode['parameters'],
  }));
  const connections: Connections = {};
  for (const [source, byType] of Object.entries(definition.connections)) {
    const renamedByType: Connections[string] = {};
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, Array<Connection[] | null>][]) {
      renamedByType[type] = outputs.map(
        (dests) => dests?.map((d) => (d.node === oldName ? { ...d, node: newName } : d)) ?? null,
      );
    }
    connections[source === oldName ? newName : source] = renamedByType;
  }
  const pinData = definition.pinData
    ? Object.fromEntries(Object.entries(definition.pinData).map(([k, v]) => [k === oldName ? newName : k, v]))
    : undefined;
  return { ...definition, nodes, connections, pinData };
}
