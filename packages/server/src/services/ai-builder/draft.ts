/**
 * The builder's in-memory draft (P5-09, L1). One definition per turn; server-made node ids and a fresh
 * `webhookId`; a node type resolves through `nodeTypes.get` only. Nothing here saves: the draft goes to
 * the editor as `workflow-updated`, and only the user's Accept saves it. Credentials the model writes are
 * dropped in tools.ts, not here (L9's credential operation uses the draft); existing refs stay.
 */
import { randomUUID } from 'node:crypto';
import type { NodeTypeRegistry } from '@workflow/core';
import {
  type Connection,
  type ConnectionType,
  ConnectionTypes,
  type NodeParameters,
  type NodeTypeDescription,
  renameNodeInDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@workflow/workflow';

/** a node the model asks for; the draft fills id, version, position and `webhookId` */
export interface BuilderDraftNodeInput {
  name?: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: NodeParameters;
  credentials?: WorkflowNode['credentials'];
}

/** one connection of `connect_nodes` / `remove_connection` */
export interface BuilderConnectionInput {
  from: string;
  to: string;
  /** connection type, default `main` */
  type?: string;
  outputIndex?: number;
  inputIndex?: number;
}

/** a mistake the model can fix: its message goes back to the model as the tool's answer */
export class BuilderDraftError extends Error {
  override name = 'BuilderDraftError';
}

const MAX_NAME = 128;
const GRID_X = 240;
const CONNECTION_TYPES = new Set<string>(Object.values(ConnectionTypes));

function versionsOf(description: NodeTypeDescription): number[] {
  return Array.isArray(description.version) ? description.version : [description.version];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** a whole number at least 0, else `fallback` */
function index(value: unknown, fallback = 0): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

export class BuilderDraft {
  readonly nodeTypes: NodeTypeRegistry;
  private readonly current: WorkflowDefinition;

  constructor(definition: WorkflowDefinition, nodeTypes: NodeTypeRegistry) {
    this.current = definition;
    this.nodeTypes = nodeTypes;
  }

  /** the live object; a caller that emits it clones it first */
  definition(): WorkflowDefinition {
    return this.current;
  }

  private find(name: string): WorkflowNode {
    const node = this.current.nodes.find((n) => n.name === name);
    if (!node) throw new BuilderDraftError(`There is no node named "${name}"`);
    return node;
  }

  /** `wanted`, or `wanted 2`, `wanted 3`... when the name is taken */
  private uniqueName(wanted: string): string {
    const base = wanted.trim().slice(0, MAX_NAME) || 'Node';
    const taken = new Set(this.current.nodes.map((n) => n.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, MAX_NAME - String(i).length - 1)} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** right of the right-most node, so a new node never covers another */
  private nextPosition(): [number, number] {
    if (!this.current.nodes.length) return [0, 0];
    const x = Math.max(...this.current.nodes.map((n) => n.position?.[0] ?? 0));
    const y = Math.min(...this.current.nodes.map((n) => n.position?.[1] ?? 0));
    return [x + GRID_X, y];
  }

  /** adds nodes; returns the nodes as added (final names and ids) */
  addNodes(nodes: BuilderDraftNodeInput[]): WorkflowNode[] {
    // check every node first, so a bad one adds nothing
    const resolved = nodes.map((input) => {
      if (!input || typeof input.type !== 'string') throw new BuilderDraftError('Each node needs a "type"');
      const nodeType = this.nodeTypes.get(input.type);
      if (!nodeType) {
        throw new BuilderDraftError(
          `Unknown node type "${input.type}". Use search_nodes to find the exact type name.`,
        );
      }
      if (input.parameters !== undefined && !isPlainObject(input.parameters)) {
        throw new BuilderDraftError(`The parameters of "${input.name ?? input.type}" must be an object`);
      }
      return { input, description: nodeType.description };
    });
    const added: WorkflowNode[] = [];
    for (const { input, description } of resolved) {
      const versions = versionsOf(description);
      const typeVersion =
        typeof input.typeVersion === 'number' && versions.includes(input.typeVersion)
          ? input.typeVersion
          : Math.max(...versions);
      const position =
        Array.isArray(input.position) &&
        input.position.length === 2 &&
        input.position.every((v) => Number.isFinite(v))
          ? ([input.position[0], input.position[1]] as [number, number])
          : this.nextPosition();
      const node: WorkflowNode = {
        id: randomUUID(),
        name: this.uniqueName(
          typeof input.name === 'string' && input.name.trim()
            ? input.name
            : (description.defaults?.name ?? description.displayName),
        ),
        type: description.name,
        typeVersion,
        position,
        parameters: structuredClone(input.parameters ?? {}),
        ...(isPlainObject(input.credentials) && Object.keys(input.credentials).length
          ? { credentials: structuredClone(input.credentials) }
          : {}),
        ...(description.webhooks?.length ? { webhookId: randomUUID() } : {}),
      };
      this.current.nodes.push(node);
      added.push(node);
    }
    return added;
  }

  /** merges `parameters` into the node's (top-level keys replace); `null` removes a key */
  updateNodeParameters(name: string, parameters: NodeParameters): WorkflowNode {
    const node = this.find(name);
    if (!isPlainObject(parameters)) throw new BuilderDraftError('"parameters" must be an object');
    const next: NodeParameters = { ...(node.parameters ?? {}) };
    for (const [key, value] of Object.entries(structuredClone(parameters))) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    node.parameters = next;
    return node;
  }

  removeNode(name: string): void {
    this.find(name);
    const definition = this.current;
    definition.nodes = definition.nodes.filter((n) => n.name !== name);
    delete definition.connections[name];
    for (const byType of Object.values(definition.connections)) {
      for (const [type, outputs] of Object.entries(byType)) {
        byType[type as ConnectionType] = (outputs ?? []).map(
          (dests) => dests?.filter((d) => d.node !== name) ?? null,
        );
      }
    }
    if (definition.pinData) delete definition.pinData[name];
  }

  renameNode(name: string, newName: string): void {
    this.find(name);
    const wanted = String(newName ?? '').trim();
    if (!wanted) throw new BuilderDraftError('The new name must not be empty');
    if (wanted.length > MAX_NAME) throw new BuilderDraftError(`Names are at most ${MAX_NAME} characters`);
    if (wanted === name) return;
    if (this.current.nodes.some((n) => n.name === wanted)) {
      throw new BuilderDraftError(`A node named "${wanted}" already exists`);
    }
    const renamed = renameNodeInDefinition(this.current, name, wanted);
    this.current.nodes = renamed.nodes;
    this.current.connections = renamed.connections;
    if (renamed.pinData) this.current.pinData = renamed.pinData;
  }

  private checkConnection(item: BuilderConnectionInput): Required<BuilderConnectionInput> {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') {
      throw new BuilderDraftError('A connection needs "from" and "to" node names');
    }
    this.find(item.from);
    this.find(item.to);
    if (item.from === item.to) throw new BuilderDraftError('A node cannot connect to itself');
    const type = item.type ?? 'main';
    if (!CONNECTION_TYPES.has(type)) throw new BuilderDraftError(`Unknown connection type "${type}"`);
    return {
      from: item.from,
      to: item.to,
      type,
      outputIndex: index(item.outputIndex),
      inputIndex: index(item.inputIndex),
    };
  }

  /**
   * Adds connections; a sub-node connects from its output to the root node's input of the same type
   * (`from` the model, `to` the agent, type `ai_languageModel`). An existing one is kept once.
   */
  connectNodes(items: BuilderConnectionInput[]): void {
    const checked = items.map((item) => this.checkConnection(item));
    for (const { from, to, type, outputIndex, inputIndex } of checked) {
      const byType = (this.current.connections[from] ??= {});
      const outputs = (byType[type as ConnectionType] ??= []);
      while (outputs.length <= outputIndex) outputs.push([]);
      const dests = (outputs[outputIndex] ??= []);
      if (dests.some((d) => d.node === to && d.index === inputIndex && d.type === type)) continue;
      dests.push({ node: to, type: type as ConnectionType, index: inputIndex } as Connection);
    }
  }

  removeConnection(item: BuilderConnectionInput): void {
    const { from, to, type, outputIndex, inputIndex } = this.checkConnection(item);
    const dests = this.current.connections[from]?.[type as ConnectionType]?.[outputIndex];
    const at = dests?.findIndex((d) => d.node === to && d.index === inputIndex) ?? -1;
    if (!dests || at < 0) {
      throw new BuilderDraftError(`There is no ${type} connection from "${from}" to "${to}"`);
    }
    dests.splice(at, 1);
  }
}
