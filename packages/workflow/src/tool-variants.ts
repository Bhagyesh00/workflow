/**
 * Any node as an agent tool. A node with `usableAsTool` gets a `<name>Tool` copy at load; a node that can
 * send and wait gets a human review copy. The conversions are L2's. Until L2 fills this file no variant
 * exists, so the two variant checks answer false: the engine calls them for every sub-node without
 * `supplyData`, and that path must keep its refusal.
 */
import type { NodeTypeDescription, WorkflowNode } from './interfaces';
import type { NodeType } from './node-types';

/** L2 fills: true for a description `toToolVariant` made */
export function isToolVariant(_description: NodeTypeDescription): boolean {
  return false;
}

/** L2 fills: true for a description `toHitlVariant` made */
export function isHitlVariant(_description: NodeTypeDescription): boolean {
  return false;
}

/** the outputs hold `ai_tool`; the caller checks that the type has `execute` */
export function isToolNode(description: NodeTypeDescription): boolean {
  const { outputs } = description;
  if (!Array.isArray(outputs)) return false;
  return outputs.some((output) => (typeof output === 'string' ? output : output.type) === 'ai_tool');
}

export function hasSendAndWaitOperation(_description: NodeTypeDescription): boolean {
  throw new Error('not implemented (L2)');
}

export function toToolVariant(_node: NodeType): NodeType {
  throw new Error('not implemented (L2)');
}

export function toHitlVariant(_node: NodeType): NodeType {
  throw new Error('not implemented (L2)');
}

/** the given nodes plus their tool and human review variants. C0: the input unchanged; L2 fills */
export function withToolVariants(nodes: NodeType[]): NodeType[] {
  return nodes;
}

/** the name the model sees for a tool node */
export function toolNameOf(_nodeName: string): string {
  throw new Error('not implemented (L2)');
}

/** the description the model sees; `resolve` reads a resolved parameter of `node` */
export function toolDescriptionFor(
  _node: WorkflowNode,
  _description: NodeTypeDescription,
  _resolve: (name: string) => unknown,
): string {
  throw new Error('not implemented (L2)');
}
