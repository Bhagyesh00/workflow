/**
 * The builder's in-memory draft (P5-09, L1). One definition per turn; server-made node ids and a fresh
 * `webhookId`; a node type resolves through `nodeTypes.get` only. Nothing here saves: the draft goes to
 * the editor as `workflow-updated`, and only the user's Accept saves it. Credentials the model writes are
 * dropped in tools.ts, not here (L9's credential operation uses the draft); existing refs stay.
 */
import type { NodeTypeRegistry } from '@workflow/core';
import type { NodeParameters, WorkflowDefinition, WorkflowNode } from '@workflow/workflow';

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

  /** adds nodes; returns the nodes as added (final names and ids) */
  addNodes(_nodes: BuilderDraftNodeInput[]): WorkflowNode[] {
    throw new Error('not implemented (L1)');
  }

  updateNodeParameters(_name: string, _parameters: NodeParameters): WorkflowNode {
    throw new Error('not implemented (L1)');
  }

  removeNode(_name: string): void {
    throw new Error('not implemented (L1)');
  }

  renameNode(_name: string, _newName: string): void {
    throw new Error('not implemented (L1)');
  }

  connectNodes(_items: BuilderConnectionInput[]): void {
    throw new Error('not implemented (L1)');
  }

  removeConnection(_item: BuilderConnectionInput): void {
    throw new Error('not implemented (L1)');
  }
}
